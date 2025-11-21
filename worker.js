// =================================================================================
//  项目: Gemini-API-Platform (Cloudflare Worker + Durable Objects 版)
//  版本: 2.2.8 (社区最终修正版 + 增强)
//  作者: 首席开发者体验架构师 (由 AI 辅助增强) & 社区
//  协议: F1 驾驶舱开发哲学
//  日期: 2025-11-21
//
//  描述:
//  本文件是一个完全自包含、可一键部署的 Cloudflare Worker 平台。
//
//  核心特性 (v2.2.8):
//  1. [关键修正]: 在 getAccessToken 函数中为获取令牌的请求增加了 User-Agent 头，
//             模拟真实浏览器行为，大幅降低因请求可疑而被 Google 风控导致获取令牌失败的概率。
//             这是解决 "无法获取访问令牌" 错误的关键。
//  2. [增强]: 在 API 请求失败的 catch 块中增加了详细的错误日志记录 (console.error)。
//  3. [新增]: 实现了 /v1/models 接口，以兼容需要预先获取模型列表的第三方客户端。
//  4. [关键修复]: 修正了 Durable Object 中警报(Alarm)功能的 API 调用方式。
//
// =================================================================================

// --- [代码目录] ---
// 1. 全局配置 (CONFIG)
// 2. Durable Object: GeminiSession (核心状态与逻辑)
// 3. 主 Worker: 路由与请求分发
// 4. UI 模块: 驾驶舱与管理页面
// 5. 辅助函数

// =================================================================================
// 1. 全局配置 (CONFIG)
// =================================================================================
const CONFIG = {
  PROJECT_NAME: "Gemini-API-Platform",
  PROJECT_VERSION: "2.2.8", // 版本号更新
  DEFAULT_MODEL: "gemini-pro", // 保持一个通用默认值
  UPSTREAM_INIT_URL: "https://gemini.google.com/app",
  UPSTREAM_GENERATE_URL: "https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate",
  UPSTREAM_ROTATE_URL: "https://accounts.google.com/RotateCookies",
  // [关键修正] 与 Python 项目 v1.17.1 的 constants.py 完全同步
  MODELS: {
    "gemini-pro": {}, // 作为通用模型或默认模型
    "gemini-3.0-pro": { "x-goog-ext-525001261-jspb": '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4]]' },
    "gemini-2.5-pro": { "x-goog-ext-525001261-jspb": '[1,null,null,null,"4af6c7f5da75d65d",null,null,0,[4]]' },
    "gemini-2.5-flash": { "x-goog-ext-525001261-jspb": '[1,null,null,null,"9ec249fc9ad08861",null,null,0,[4]]' },
    // 保留旧名称以兼容可能已经配置好的客户端，但新客户端将看到新名称
    "gemini-1.5-pro-latest": { "x-goog-ext-525001261-jspb": '[1,null,null,null,"4af6c7f5da75d65d",null,null,0,[4]]' },
    "gemini-1.5-flash-latest": { "x-goog-ext-525001261-jspb": '[1,null,null,null,"9ec249fc9ad08861",null,null,0,[4]]' },
  },
  COOKIE_REFRESH_INTERVAL: 2 * 60 * 60 * 1000, // 2 hours
};

// =================================================================================
// 2. Durable Object: GeminiSession
// =================================================================================
export class GeminiSession {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.storage.getAlarm().then(alarm => {
      if (alarm === null) {
        this.state.storage.setAlarm(Date.now() + CONFIG.COOKIE_REFRESH_INTERVAL);
      }
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
        if (path.startsWith('/_manage')) {
            return this.handleManageRequest(request);
        }
        else if (path.startsWith('/v1')) {
            return this.handleApiRequest(request);
        }
        return createJsonErrorResponse('未知的 Durable Object 路径', 404, 'do_not_found');
    } catch (e) {
        console.error("Durable Object Unhandled Exception:", e.stack);
        return createJsonErrorResponse(`内部服务器错误: ${e.message}`, 500, 'do_unhandled_exception');
    }
  }

  async alarm() {
    console.log("Durable Object Alarm: 开始执行 Cookie 刷新任务。");
    const cookies = await this.state.storage.get('cookies') || [];
    let updated = false;
    for (const cookie of cookies) {
      if (!cookie || !cookie.psid || !cookie.psidts) continue;
      try {
        const newPsidts = await this.refreshPsidts(cookie.psid, cookie.psidts);
        if (newPsidts && newPsidts !== cookie.psidts) {
          cookie.psidts = newPsidts;
          cookie.status = 'ok';
          cookie.error = null;
          cookie.lastRefreshed = new Date().toISOString();
          updated = true;
          console.log(`Cookie for PSID ${cookie.psid.substring(0, 10)}... 刷新成功。`);
        }
      } catch (e) {
        cookie.status = 'error';
        cookie.error = e.message;
        updated = true;
        console.error(`Cookie for PSID ${cookie.psid.substring(0, 10)}... 刷新失败:`, e.message);
      }
    }

    if (updated) {
      await this.state.storage.put('cookies', cookies);
    }
    this.state.storage.setAlarm(Date.now() + CONFIG.COOKIE_REFRESH_INTERVAL);
  }

  async handleManageRequest(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/_manage/cookies' && request.method === 'GET') {
      const cookies = await this.state.storage.get('cookies') || [];
      const sanitizedCookies = (cookies || []).map(c => ({
        id: c?.id,
        psid_suffix: c && c.psid ? c.psid.slice(-6) : 'N/A',
        status: c?.status,
        lastRefreshed: c?.lastRefreshed,
        error: c?.error
      })).filter(c => c.id);
      return new Response(JSON.stringify(sanitizedCookies), { headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/_manage/cookies' && request.method === 'POST') {
      const { psid, psidts } = await request.json();
      if (!psid || !psidts) return createJsonErrorResponse('缺少 psid 或 psidts', 400, 'missing_params');
      let cookies = await this.state.storage.get('cookies') || [];
      cookies.push({ id: crypto.randomUUID(), psid, psidts, status: 'new', lastUsed: 0, lastRefreshed: null, error: null });
      await this.state.storage.put('cookies', cookies);
      return new Response(JSON.stringify({ message: 'Cookie 添加成功' }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }
    if (path.startsWith('/_manage/cookies/') && request.method === 'DELETE') {
      const id = path.split('/').pop();
      let cookies = await this.state.storage.get('cookies') || [];
      cookies = cookies.filter(c => c.id !== id);
      await this.state.storage.put('cookies', cookies);
      return new Response(JSON.stringify({ message: 'Cookie 删除成功' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path === '/_manage/parse' && request.method === 'POST') {
        return this.handleParseRequest(request);
    }
    return createJsonErrorResponse('无效的管理操作', 400, 'invalid_manage_operation');
  }

  async handleParseRequest(request) {
    try {
        const text = await request.text();
        if (!text || text.length === 0) {
            throw new Error("粘贴内容不能为空。");
        }
        if (text.length > 15 * 1024 * 1024) {
            throw new Error("粘贴内容过大，请限制在 15MB 以内。这通常是因为复制了整个网络日志，请只复制单个请求的相关信息。");
        }
        const { psid, psidts } = this.parseCookieValues(text);
        return new Response(JSON.stringify({ psid, psidts }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return createJsonErrorResponse(e.message, 400, 'parse_failed');
    }
  }

  parseCookieValues(text) {
    let psid = null;
    let psidts = null;

    const psidMatch = text.match(/__Secure-1PSID=([^;"]+)/);
    const psidtsMatch = text.match(/__Secure-1PSIDTS=([^;"]+)/);
    if (psidMatch && psidMatch[1]) psid = psidMatch[1];
    if (psidtsMatch && psidtsMatch[1]) psidts = psidtsMatch[1];
    if (psid && psidts) return { psid, psidts };

    const psidPsMatch = text.match(/New-Object System\.Net\.Cookie\("__Secure-1PSID", "([^"]+)"/);
    const psidtsPsMatch = text.match(/New-Object System\.Net\.Cookie\("__Secure-1PSIDTS", "([^"]+)"/);
    if (psidPsMatch && psidPsMatch[1]) psid = psidPsMatch[1];
    if (psidtsPsMatch && psidtsPsMatch[1]) psidts = psidtsPsMatch[1];
    if (psid && psidts) return { psid, psidts };

    try {
        const jsonText = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
        const har = JSON.parse(jsonText);
        const cookies = har?.log?.entries?.[0]?.request?.cookies || har?.request?.cookies || har?.cookies;
        if (cookies && Array.isArray(cookies)) {
            for (const cookie of cookies) {
                if (cookie.name === '__Secure-1PSID') psid = cookie.value;
                if (cookie.name === '__Secure-1PSIDTS') psidts = cookie.value;
            }
        }
        if (psid && psidts) return { psid, psidts };
    } catch (e) { /* Ignore JSON parsing errors */ }

    if (!psid || !psidts) {
        let errorMessage = "解析失败。";
        if (!psid && !psidts) errorMessage += "未能找到 __Secure-1PSID 和 __Secure-1PSIDTS。";
        else if (!psid) errorMessage += "找到了 __Secure-1PSIDTS 但未找到 __Secure-1PSID。";
        else errorMessage += "找到了 __Secure-1PSID 但未找到 __Secure-1PSIDTS。";
        errorMessage += " 请确保复制了完整的请求头、cURL 命令或 HAR 条目内容。";
        throw new Error(errorMessage);
    }
    return { psid, psidts };
  }

  async handleApiRequest(request) {
    if (new URL(request.url).pathname !== '/v1/chat/completions') {
      return createJsonErrorResponse('此路径仅支持 /v1/chat/completions', 404, 'not_found');
    }

    const cookie = await this.getAvailableCookie();
    if (!cookie) {
      return createJsonErrorResponse('会话中没有可用的有效 Cookie。请在管理页面添加。', 500, 'no_available_cookies');
    }

    try {
      const accessToken = await this.getAccessToken(cookie.psid, cookie.psidts);
      if (!accessToken) {
        throw new Error('无法获取访问令牌，Cookie 可能已失效或被 Google 风控。请尝试重新获取。');
      }

      const requestBody = await request.json();
      const conversationState = await this.getConversationState(requestBody.chat_id);
      const geminiPayload = constructGeminiPayload(requestBody, conversationState);

      const modelId = requestBody.model || CONFIG.DEFAULT_MODEL;
      const modelConfig = CONFIG.MODELS[modelId];
      if (modelConfig === undefined) {
          throw new Error(`请求的模型 '${modelId}' 不存在或未在配置中定义。`);
      }
      const modelHeaders = modelConfig || {};

      const geminiHeaders = {
        'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8',
        'Cookie': `__Secure-1PSID=${cookie.psid}; __Secure-1PSIDTS=${cookie.psidts}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'X-Same-Domain': '1',
        ...modelHeaders,
      };
      const postData = new URLSearchParams({
        'at': accessToken,
        'f.req': JSON.stringify([null, JSON.stringify(geminiPayload)]),
      }).toString();

      const upstreamResponse = await fetch(CONFIG.UPSTREAM_GENERATE_URL, {
        method: 'POST',
        headers: geminiHeaders,
        body: postData,
      });

      if (!upstreamResponse.ok) {
        const errorText = await upstreamResponse.text();
        throw new Error(`上游服务错误: ${upstreamResponse.status} - ${errorText}`);
      }

      const { readable, writable } = new TransformStream();
      this.streamAndProcess(upstreamResponse.body, writable, requestBody, cookie.id);
      return new Response(readable, { headers: corsHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8' }) });

    } catch (e) {
      // [增强] 增加详细错误日志
      console.error(`API 请求失败 (Cookie PSID 后缀: ...${cookie.psid.slice(-6)}):`, e.message);
      cookie.status = 'error';
      cookie.error = e.message;
      await this.updateCookie(cookie);
      return createJsonErrorResponse(e.message, 500, 'session_request_failed');
    }
  }

  async getAvailableCookie() {
    let cookies = await this.state.storage.get('cookies') || [];
    if (cookies.length === 0) return null;
    cookies = cookies.filter(c => c && c.psid && c.psidts);
    if (cookies.length === 0) return null;
    cookies.sort((a, b) => {
        if (a.status === 'ok' && b.status !== 'ok') return -1;
        if (a.status !== 'ok' && b.status === 'ok') return 1;
        return (a.lastUsed || 0) - (b.lastUsed || 0);
    });
    const cookie = cookies[0];
    cookie.lastUsed = Date.now();
    await this.state.storage.put('cookies', cookies);
    return cookie;
  }

  async updateCookie(updatedCookie) {
    let cookies = await this.state.storage.get('cookies') || [];
    const index = cookies.findIndex(c => c.id === updatedCookie.id);
    if (index !== -1) {
      cookies[index] = updatedCookie;
      await this.state.storage.put('cookies', cookies);
    }
  }

  // =================================================================================
  // [关键修正] 在此函数中增加了 User-Agent，以模拟真实浏览器，防止被 Google 风控
  // =================================================================================
  async getAccessToken(psid, psidts) {
    const cached = await this.state.storage.get('accessToken');
    if (cached && cached.psid === psid && cached.expiry > Date.now()) {
      return cached.token;
    }
    const response = await fetch(CONFIG.UPSTREAM_INIT_URL, {
      headers: { 
        'Cookie': `__Secure-1PSID=${psid}; __Secure-1PSIDTS=${psidts}`,
        // 模拟真实浏览器的 User-Agent
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      }
    });
    if (!response.ok) {
        console.error(`获取 Access Token 失败，状态码: ${response.status}, 响应: ${await response.text()}`);
        return null;
    }
    const text = await response.text();
    const match = text.match(/"SNlM0e":"(.*?)"/);
    if (match && match[1]) {
      const accessToken = { token: match[1], psid: psid, expiry: Date.now() + 10 * 60 * 1000 };
      await this.state.storage.put('accessToken', accessToken);
      return accessToken.token;
    }
    return null;
  }

  async refreshPsidts(psid, psidts) {
    const response = await fetch(CONFIG.UPSTREAM_ROTATE_URL, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Cookie': `__Secure-1PSID=${psid}; __Secure-1PSIDTS=${psidts}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      body: '[000,"-0000000000000000000"]',
    });
    if (!response.ok) throw new Error(`刷新失败: ${response.status}`);
    const newCookies = response.headers.get('set-cookie');
    const match = newCookies?.match(/__Secure-1PSIDTS=([^;]+)/);
    return match ? match[1] : null;
  }

  async getConversationState(chatId = 'default') {
    let conversations = await this.state.storage.get('conversations') || {};
    return conversations[chatId] || null;
  }

  async updateConversationState(chatId = 'default', newState) {
    let conversations = await this.state.storage.get('conversations') || {};
    conversations[chatId] = newState;
    const keys = Object.keys(conversations);
    if (keys.length > 50) {
      delete conversations[keys[0]];
    }
    await this.state.storage.put('conversations', conversations);
  }

  async streamAndProcess(readable, writable, requestBody, cookieId) {
    const reader = readable.getReader();
    const writer = writable.getWriter();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const requestId = `chatcmpl-${crypto.randomUUID()}`;
    const modelId = requestBody.model || CONFIG.DEFAULT_MODEL;

    let buffer = '';
    let conversationContext = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim().startsWith('[[') && !line.trim().startsWith('["wrb.fr')) continue;
          try {
            const jsonData = JSON.parse(line);
            const contentPart = jsonData?.[0]?.[2] || (jsonData?.[0]?.[0] === "wrb.fr" ? jsonData[0][1] : null);
            if (contentPart) {
              const parsedContent = JSON.parse(contentPart);
              const delta = parsedContent?.[4]?.[0]?.[1]?.[0];
              const newCid = parsedContent?.[1]?.[0];
              const newRid = parsedContent?.[1]?.[1];
              const newRcid = parsedContent?.[4]?.[0]?.[0];
              if (newCid && newRid && newRcid) {
                conversationContext = { cid: newCid, rid: newRid, rcid: newRcid };
              }
              if (typeof delta === 'string') {
                const chunk = { id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
            }
          } catch (e) { /* Ignore parsing errors on individual lines */ }
        }
      }
    } catch (e) {
      console.error("流处理错误:", e);
    } finally {
      const finalChunk = { id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
      await writer.write(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
      await writer.write(encoder.encode('data: [DONE]\n\n'));
      await writer.close();
      if (conversationContext) {
        await this.updateConversationState(requestBody.chat_id, conversationContext);
      }
      const cookies = await this.state.storage.get('cookies') || [];
      const cookie = cookies.find(c => c.id === cookieId);
      if (cookie && cookie.status !== 'ok') {
          cookie.status = 'ok';
          cookie.error = null;
          await this.updateCookie(cookie);
      }
    }
  }
}

// =================================================================================
// 3. 主 Worker: 路由与请求分发
// =================================================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return handleCorsPreflight();

    if (url.pathname === '/') return handleUIMain(request);
    if (url.pathname === '/manage') return handleUIManage(request);

    if (url.pathname === '/v1/models') {
      return handleModelsRequest();
    }

    if (url.pathname === '/api/session' && request.method === 'POST') {
      const newId = env.GEMINI_SESSIONS.newUniqueId();
      const newSessionToken = newId.toString();
      return new Response(JSON.stringify({ session_token: newSessionToken }), { headers: corsHeaders({ 'Content-Type': 'application/json' }) });
    }

    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/_manage/')) {
      let sessionToken = null;
      let finalRequest = request;

      const authHeader = request.headers.get('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        sessionToken = authHeader.substring(7);
      } else {
        const tokenFromQuery = url.searchParams.get('token');
        if (tokenFromQuery) {
          sessionToken = tokenFromQuery;
        
          const newHeaders = new Headers(request.headers);
          newHeaders.set('Authorization', `Bearer ${sessionToken}`);

          finalRequest = new Request(request.url, {
            method: request.method,
            headers: newHeaders,
            body: request.body,
            redirect: request.redirect,
          });
        }
      }

      if (!sessionToken) {
        return createJsonErrorResponse('需要提供 Bearer <会话令牌> 进行认证。', 401, 'unauthorized');
      }

      try {
        const doId = env.GEMINI_SESSIONS.idFromString(sessionToken);
        const stub = env.GEMINI_SESSIONS.get(doId);
        return stub.fetch(finalRequest);
      } catch (e) {
        return createJsonErrorResponse('无效的会话令牌格式。它必须是一个由系统生成的 64 位十六进制 ID。', 400, 'invalid_session_token');
      }
    }

    return createJsonErrorResponse('路径未找到', 404, 'not_found');
  }
};

// =================================================================================
// 4. UI 模块: 驾驶舱与管理页面
// =================================================================================
function handleUIMain(request) {
  const html = `
    <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>会话入口</title>
    <style>body{font-family:sans-serif;background:#121212;color:#e0e0e0;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}.container{background:#1e1e1e;padding:40px;border-radius:8px;text-align:center;border:1px solid #333;min-width:400px;}h1{color:#ffbf00;}input{width:100%;padding:10px;margin:10px 0;border-radius:4px;border:1px solid #555;background:#2a2a2a;color:#e0e0e0;box-sizing: border-box;}button{padding:10px 20px;border:none;border-radius:4px;cursor:pointer;background:#ffbf00;color:#121212;font-weight:bold;margin-top:10px;}#new-session-result{margin-top:20px;font-family:monospace;background:#2a2a2a;padding:10px;border-radius:4px;word-break:break-all;text-align:left;}</style>
    </head><body><div class="container"><h1>会话令牌入口</h1><p>输入您已有的会话令牌，或创建一个新会话。</p><input id="token-input" type="text" placeholder="输入您的会话令牌..."><button onclick="manageSession()">进入管理页面</button><hr style="border-color:#333;margin:20px 0;"><button onclick="createNewSession()">创建新会话</button><div id="new-session-result"></div></div>
    <script>
      function manageSession() { const token = document.getElementById('token-input').value; if(token) window.location.href = '/manage?token=' + token; else alert('请输入会话令牌'); }
      async function createNewSession() { const res = await fetch('/api/session', { method: 'POST' }); const data = await res.json(); document.getElementById('new-session-result').innerHTML = '<strong>新会话令牌 (请妥善保管):</strong><br>' + data.session_token; }
    </script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function handleUIManage(request) {
  const token = new URL(request.url).searchParams.get('token');
  if (!token) return new Response('缺少 token 参数', { status: 400 });

  const html = `
    <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Cookie 管理</title>
    <style>
      body{font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background:#121212; color:#e0e0e0; margin:20px; line-height: 1.6;}
      .container { max-width: 900px; margin: 0 auto; }
      h1,h2,h3 { color:#ffbf00; border-bottom: 1px solid #333; padding-bottom: 10px; }
      p, li { color: #aaa; }
      code { background-color: #333; color: #ffbf00; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
      .card { background: #1e1e1e; border: 1px solid #333; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
      table{width:100%;border-collapse:collapse;margin-top:20px;}
      th,td{padding:12px 15px;border:1px solid #333;text-align:left; font-size: 14px; word-break: break-all;}
      th { background: #2a2a2a; }
      input, textarea, .api-info-box pre { box-sizing: border-box; width: 100%; padding:10px; border-radius:4px; border:1px solid #555; background:#2a2a2a; color:#e0e0e0; margin-bottom:10px; font-family: monospace;}
      textarea { min-height: 150px; resize: vertical; }
      button { padding:10px 18px; border:none; border-radius:4px; cursor:pointer; background:#ffbf00; color:#121212; font-weight:bold; transition: background-color 0.2s; }
      button:hover { background: #ffd040; }
      button:disabled { background: #555; color: #888; cursor: not-allowed; }
      .delete-btn{ background:#b71c1c; color: white; } .delete-btn:hover { background: #d32f2f; }
      .logout-btn{ background:#1565c0; color: white; float: right;} .logout-btn:hover { background: #1976d2; }
      .input-group { display: flex; gap: 10px; } .input-group input { flex-grow: 1; }
      #parse-status { margin-top: 10px; padding: 10px; border-radius: 4px; display: none; font-weight: bold; }
      .status-success { background: #2e7d32; color: white; } .status-error { background: #b71c1c; color: white; } .status-loading { background: #1565c0; color: white; }
      #api-info { display: none; } .api-info-box { background: #2a2a2a; padding: 15px; border-radius: 5px; margin-top: 15px; } .api-info-box pre { white-space: pre-wrap; word-break: break-all; background: #333; padding: 10px; }
    </style>
    </head><body>
    <div class="container">
      <button class="logout-btn" onclick="window.location.href='/'">退出并返回主页</button>
      <h1>会话管理中心</h1>
      <p>当前会话令牌: <strong>${token}</strong></p>

      <div class="card" id="api-info">
        <h3>API 调用信息</h3>
        <p>将会话令牌作为 API Key，配合以下端点，即可在任何支持 OpenAI 格式的客户端中使用。</p>
        <div class="api-info-box">
          <strong>API 端点 (Endpoint):</strong>
          <pre id="api-endpoint"></pre>
          <strong>API 密钥 (Key):</strong>
          <pre id="api-key"></pre>
        </div>
        <p><strong>注意:</strong> API 密钥就是您的会话令牌，它与您的会话数据 (Cookie等) 绑定。您无法直接修改它。如果您需要一个新的密钥，请返回主页并“创建新会话”。</p>
      </div>

      <div class="card">
        <h3>1. 智能粘贴 (推荐)</h3>
        <p>在此处粘贴从浏览器开发者工具复制的任何内容 (如原始请求头、cURL命令、HAR条目等)。系统将自动提取 <code>__Secure-1PSID</code> 和 <code>__Secure-1PSIDTS</code>。</p>
        <textarea id="smart-paste-area" placeholder="例如，从 Chrome 网络面板右键点击一个请求，选择“复制” -> “复制为 cURL (bash)” 或 “复制所有请求头”，然后粘贴到这里。"></textarea>
        <button id="parse-btn" onclick="parseAndFill()">解析并填充到下方</button>
        <div id="parse-status"></div>
      </div>

      <div class="card">
        <h3>2. 手动添加/修改</h3>
        <p>如果智能粘贴失败，您可以在此手动输入或修改提取出的值，然后点击添加。</p>
        <div class="input-group">
          <input id="psid" placeholder="__Secure-1PSID">
          <input id="psidts" placeholder="__Secure-1PSIDTS">
        </div>
        <button onclick="addCookie()">添加 Cookie</button>
      </div>

      <div class="card">
        <h2>3. 已存 Cookie 列表 (自动负载均衡)</h2>
        <p>系统会自动轮询使用以下 Cookie。如果某个 Cookie 失效，系统会标记并尝试使用下一个。</p>
        <table id="cookie-table">
          <thead><tr><th>ID (前8位)</th><th>PSID (后6位)</th><th>状态</th><th>上次刷新</th><th>操作</th></tr></thead>
          <tbody><tr><td colspan="5" style="text-align:center;">正在加载...</td></tr></tbody>
        </table>
      </div>
    </div>

    <script>
      const TOKEN = '${token}';
      const psidInput = document.getElementById('psid');
      const psidtsInput = document.getElementById('psidts');
      const parseBtn = document.getElementById('parse-btn');
      const parseStatus = document.getElementById('parse-status');
      const smartPasteArea = document.getElementById('smart-paste-area');
      const apiInfoDiv = document.getElementById('api-info');

      function showStatus(message, type) {
        parseStatus.textContent = message;
        parseStatus.className = 'status-' + type;
        parseStatus.style.display = 'block';
        if (type !== 'loading') setTimeout(() => { parseStatus.style.display = 'none'; }, 8000);
      }

      function updateApiInfo() {
        document.getElementById('api-endpoint').textContent = window.location.origin + '/v1';
        document.getElementById('api-key').textContent = TOKEN;
        apiInfoDiv.style.display = 'block';
      }

      async function handleFetchError(response) {
          const errorText = await response.text();
          try {
              const errorJson = JSON.parse(errorText);
              return errorJson.error?.message || errorJson.message || errorJson.error || errorText;
          } catch (e) {
              if (errorText.includes('<title>Worker threw exception')) {
                  return 'Worker 内部发生异常，请检查 Cloudflare 后台日志。';
              }
              return errorText || response.statusText || '未知错误';
          }
      }

      async function parseAndFill() {
        const content = smartPasteArea.value;
        if (!content.trim()) { showStatus('粘贴内容不能为空。', 'error'); return; }
        parseBtn.disabled = true;
        parseBtn.textContent = '正在解析...';
        showStatus('正在解析，请稍候...', 'loading');
        try {
          const res = await fetch('/_manage/parse?token=' + TOKEN, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: content });
          if (!res.ok) {
            const errorMessage = await handleFetchError(res);
            throw new Error(errorMessage);
          }
          const data = await res.json();
          psidInput.value = data.psid;
          psidtsInput.value = data.psidts;
          showStatus('✅ 解析成功！值已自动填充到下方手动添加框中。请点击“添加 Cookie”按钮保存。', 'success');
          smartPasteArea.value = '';
        } catch (e) {
          showStatus('❌ 解析失败: ' + e.message, 'error');
        } finally {
          parseBtn.disabled = false;
          parseBtn.textContent = '解析并填充到下方';
        }
      }

      async function fetchCookies() {
        try {
            const res = await fetch('/_manage/cookies?token=' + TOKEN);
            if (!res.ok) {
                const errorMessage = await handleFetchError(res);
                throw new Error(errorMessage);
            }
            const cookies = await res.json();
            const tbody = document.querySelector('#cookie-table tbody');
            tbody.innerHTML = '';
            if (cookies.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">暂无 Cookie，请添加。</td></tr>';
                apiInfoDiv.style.display = 'none';
                return;
            }
            updateApiInfo();
            cookies.forEach(c => {
              const statusText = c.status === 'ok' ? '✅ 正常' : (c.status === 'new' ? '⏳ 新增' : '❌ 错误: ' + (c.error || '未知'));
              const row = \`<tr><td>\${c.id.slice(0,8)}</td><td>...\${c.psid_suffix}</td><td>\${statusText}</td><td>\${c.lastRefreshed ? new Date(c.lastRefreshed).toLocaleString() : 'N/A'}</td><td><button class="delete-btn" onclick="deleteCookie('\${c.id}')">删除</button></td></tr>\`;
              tbody.innerHTML += row;
            });
        } catch(e) {
            document.querySelector('#cookie-table tbody').innerHTML = \`<tr><td colspan="5" style="text-align:center; color: #b71c1c;">获取列表失败: \${e.message}</td></tr>\`;
        }
      }

      async function addCookie() {
        const psid = psidInput.value;
        const psidts = psidtsInput.value;
        if (!psid || !psidts) { alert('__Secure-1PSID 和 __Secure-1PSIDTS 均不能为空。'); return; }
        try {
            const res = await fetch('/_manage/cookies?token=' + TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ psid, psidts }) });
            if (!res.ok) {
                const errorMessage = await handleFetchError(res);
                throw new Error(errorMessage);
            }
            psidInput.value = '';
            psidtsInput.value = '';
            fetchCookies();
        } catch (e) {
            alert('添加失败: ' + e.message);
        }
      }

      async function deleteCookie(id) {
        if (!confirm('确定要删除这个 Cookie 吗？')) return;
        try {
            const res = await fetch('/_manage/cookies/' + id + '?token=' + TOKEN, { method: 'DELETE' });
            if (!res.ok) {
                const errorMessage = await handleFetchError(res);
                throw new Error(errorMessage);
            }
            fetchCookies();
        } catch (e) {
            alert('删除失败: ' + e.message);
        }
      }

      document.addEventListener('DOMContentLoaded', fetchCookies);
    </script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// =================================================================================
// 5. 辅助函数
// =================================================================================
function handleModelsRequest() {
  const models = Object.keys(CONFIG.MODELS).map(modelId => ({
    id: modelId,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'google',
  }));

  const responsePayload = {
    object: 'list',
    data: models,
  };

  return new Response(JSON.stringify(responsePayload), {
    status: 200,
    headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }),
  });
}

function handleCorsPreflight() {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Max-Age': '86400' } });
}
function createJsonErrorResponse(message, status, code) {
  return new Response(JSON.stringify({ error: { message, type: 'api_error', code } }), { status, headers: corsHeaders({ 'Content-Type': 'application/json; charset=utf-8' }) });
}
function corsHeaders(headers = {}) {
  return { ...headers, 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
}
function constructGeminiPayload(requestBody, conversationState) {
  const lastUserMessage = requestBody.messages.filter(m => m.role === 'user').pop();
  const prompt = [lastUserMessage.content];
  const context = conversationState ? [conversationState.cid, conversationState.rid, conversationState.rcid] : null;
  return [ [prompt], null, context ];
}
