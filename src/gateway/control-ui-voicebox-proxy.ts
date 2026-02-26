import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

const VOICEBOX_PROXY_PREFIX = "/__openclaw/voicebox";
const DEFAULT_VOICEBOX_TARGET = "http://voicebox:8000";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const REQUEST_HEADER_BLOCKLIST = new Set(["host", "content-length", ...HOP_BY_HOP_HEADERS]);

function sendText(res: ServerResponse, status: number, text: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(text);
}

function getProxyPrefix(basePath?: string): string {
  const normalizedBase = normalizeControlUiBasePath(basePath);
  return normalizedBase ? `${normalizedBase}${VOICEBOX_PROXY_PREFIX}` : VOICEBOX_PROXY_PREFIX;
}

function resolveTargetBaseUrl(): URL {
  const configured = process.env.OPENCLAW_VOICEBOX_PROXY_TARGET?.trim();
  return new URL(configured || DEFAULT_VOICEBOX_TARGET);
}

function shouldHandleVoiceboxProxyPath(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function buildTargetUrl(incoming: URL, prefix: string): URL {
  const target = resolveTargetBaseUrl();
  const suffix = incoming.pathname.slice(prefix.length);
  const normalizedSuffix = suffix ? suffix : "/";
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}${normalizedSuffix.startsWith("/") ? "" : "/"}${normalizedSuffix}`;
  target.search = incoming.search;
  return target;
}

function copyRequestHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (REQUEST_HEADER_BLOCKLIST.has(lower) || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.join(", ");
    } else {
      out[key] = value;
    }
  }
  return out;
}

function copyResponseHeaders(upstreamHeaders: IncomingHttpHeaders, res: ServerResponse) {
  for (const [key, value] of Object.entries(upstreamHeaders)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || value === undefined) {
      continue;
    }
    res.setHeader(key, value);
  }
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function forwardVoiceboxRequest(params: {
  targetUrl: URL;
  method: string;
  headers: Record<string, string>;
  body?: Buffer;
}): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return await new Promise((resolve, reject) => {
    const options: RequestOptions = {
      protocol: params.targetUrl.protocol,
      hostname: params.targetUrl.hostname,
      port: params.targetUrl.port || undefined,
      method: params.method,
      path: `${params.targetUrl.pathname}${params.targetUrl.search}`,
      headers: params.headers,
    };

    const requestFn = params.targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const upstreamReq = requestFn(options, (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      upstreamRes.on("end", () => {
        resolve({
          statusCode: upstreamRes.statusCode ?? 502,
          headers: upstreamRes.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    upstreamReq.on("error", reject);
    if (params.body && params.body.length > 0) {
      upstreamReq.write(params.body);
    }
    upstreamReq.end();
  });
}

export async function handleControlUiVoiceboxProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { basePath?: string },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }

  const incomingUrl = new URL(urlRaw, "http://localhost");
  const prefix = getProxyPrefix(opts?.basePath);
  if (!shouldHandleVoiceboxProxyPath(incomingUrl.pathname, prefix)) {
    return false;
  }

  const method = (req.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "OPTIONS"].includes(method)) {
    sendText(res, 405, "Method Not Allowed");
    return true;
  }

  try {
    const targetUrl = buildTargetUrl(incomingUrl, prefix);
    const headers = copyRequestHeaders(req);
    const body = method === "POST" ? await readRequestBody(req) : undefined;
    if (body && body.length > 0) {
      headers["content-length"] = String(body.length);
    }
    const upstream = await forwardVoiceboxRequest({
      targetUrl,
      method,
      headers,
      body,
    });

    res.statusCode = upstream.statusCode;
    copyResponseHeaders(upstream.headers, res);

    if (method === "HEAD") {
      res.end();
      return true;
    }

    res.end(upstream.body);
    return true;
  } catch (error) {
    const detail =
      error instanceof Error && error.message ? error.message : "voicebox proxy failed";
    sendText(res, 502, detail);
    return true;
  }
}
