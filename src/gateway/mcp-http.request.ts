import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "../security/secret-equal.js";
import { getHeader } from "./http-utils.js";
import {
  listMcpLoopbackTokens,
  resolveMcpLoopbackTokenScope,
  type McpLoopbackScope,
} from "./mcp-http.loopback-runtime.js";
import { isLoopbackAddress } from "./net.js";
import { checkBrowserOrigin } from "./origin-check.js";

const MAX_MCP_BODY_BYTES = 1_048_576;

export type McpRequestContext = {
  sessionKey: string;
  messageProvider: string | undefined;
  accountId: string | undefined;
  senderIsOwner: boolean | undefined;
};

function rejectsBrowserLoopbackRequest(req: IncomingMessage): boolean {
  const origin = getHeader(req, "origin");
  if (!origin) {
    // No Origin header → not a browser request. Native MCP clients
    // (curl, codex CLI, scripted MCP clients) never set Origin; let
    // them through to the bearer check.
    return false;
  }

  // Defer to checkBrowserOrigin. It already treats loopback peers
  // talking to a loopback Origin as `local-loopback`, which covers
  // the legitimate `localhost`↔`127.0.0.1` mismatch that browsers
  // flag as `Sec-Fetch-Site: cross-site` even though both ends are
  // local. A blanket cross-site early-return here would block that
  // flow even with a valid bearer; the helper's isLocalClient +
  // isLoopbackHost gating is the authoritative check.
  return !checkBrowserOrigin({
    requestHost: getHeader(req, "host"),
    origin,
    isLocalClient: isLoopbackAddress(req.socket?.remoteAddress),
  }).ok;
}

export type McpLoopbackValidationResult =
  | { ok: true; scope: McpLoopbackScope }
  | { ok: false };

export function validateMcpLoopbackRequest(params: {
  req: IncomingMessage;
  res: ServerResponse;
}): McpLoopbackValidationResult {
  let url: URL;
  try {
    url = new URL(params.req.url ?? "/", `http://${params.req.headers.host ?? "localhost"}`);
  } catch {
    params.res.writeHead(400, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "bad_request" }));
    return { ok: false };
  }

  if (params.req.method === "GET" && url.pathname.startsWith("/.well-known/")) {
    params.res.writeHead(404);
    params.res.end();
    return { ok: false };
  }

  if (url.pathname !== "/mcp") {
    params.res.writeHead(404, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "not_found" }));
    return { ok: false };
  }

  if (params.req.method !== "POST") {
    params.res.writeHead(405, { Allow: "POST" });
    params.res.end();
    return { ok: false };
  }

  if (rejectsBrowserLoopbackRequest(params.req)) {
    params.res.writeHead(403, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "forbidden" }));
    return { ok: false };
  }

  const scope = resolveBearerScope(getHeader(params.req, "authorization") ?? "");
  if (!scope) {
    params.res.writeHead(401, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "unauthorized" }));
    return { ok: false };
  }

  const contentType = getHeader(params.req, "content-type") ?? "";
  if (!contentType.startsWith("application/json")) {
    params.res.writeHead(415, { "Content-Type": "application/json" });
    params.res.end(JSON.stringify({ error: "unsupported_media_type" }));
    return { ok: false };
  }

  return { ok: true, scope };
}

function resolveBearerScope(authHeader: string): McpLoopbackScope | undefined {
  // Constant-time comparison against every registered token: do not
  // short-circuit on first miss. N is bounded by live backends (small).
  let matchedToken: string | undefined;
  for (const candidate of listMcpLoopbackTokens()) {
    const isMatch = safeEqualSecret(authHeader, `Bearer ${candidate}`);
    if (isMatch && matchedToken === undefined) {
      matchedToken = candidate;
    }
  }
  if (!matchedToken) {
    return undefined;
  }
  return resolveMcpLoopbackTokenScope(matchedToken);
}

export async function readMcpHttpBody(req: IncomingMessage): Promise<string> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_MCP_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_MCP_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function resolveMcpRequestContext(scope: McpLoopbackScope): McpRequestContext {
  return {
    sessionKey: scope.sessionKey,
    messageProvider: scope.messageProvider,
    accountId: scope.accountId,
    senderIsOwner: scope.senderIsOwner,
  };
}
