import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { loadMcpAppView } from "../agents/mcp-app-view-store.js";
import type { McpAppViewPayload } from "../agents/mcp-apps.js";
import { CONTROL_UI_MCP_APP_TICKET_HEADER } from "./control-ui-contract.js";
import { buildControlUiCspHeader } from "./control-ui-csp.js";
import { respondNotFound } from "./control-ui-http-utils.js";

const TICKET_SCOPE = "mcp-app-sandbox";
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CSP_DOMAINS = 64;
const MAX_CSP_ORIGIN_CHARS = 512;
const ticketSecret = randomBytes(32);

export type ControlUiMcpAppCsp = {
  connectDomains?: string[];
  resourceDomains?: string[];
  frameDomains?: string[];
  baseUriDomains?: string[];
};

const CSP_ORIGIN_PATTERN =
  /^(https?|wss?):\/\/(\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export const CONTROL_UI_MCP_APP_SANDBOX_PROXY_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body,iframe{border:0;height:100%;margin:0;padding:0;width:100%}body{overflow:hidden}</style>
</head>
<body>
<script>
(() => {
  if (window.parent === window) {
    document.body.textContent = "MCP App sandbox must be embedded";
    return;
  }
  const view = document.createElement("iframe");
  view.setAttribute("sandbox", "allow-scripts allow-same-origin");
  view.setAttribute("referrerpolicy", "no-referrer");
  view.setAttribute("title", "MCP App view");
  document.body.append(view);
  window.addEventListener("message", (event) => {
    if (event.source === window.parent) {
      const message = event.data;
      if (
        message &&
        typeof message === "object" &&
        message.jsonrpc === "2.0" &&
        message.method === "ui/notifications/sandbox-resource-ready" &&
        typeof message.params?.html === "string"
      ) {
        view.srcdoc = message.params.html;
        return;
      }
      view.contentWindow?.postMessage(message, "*");
      return;
    }
    if (event.source === view.contentWindow) {
      window.parent.postMessage(event.data, "*");
    }
  });
  window.parent.postMessage({
    jsonrpc: "2.0",
    method: "ui/notifications/sandbox-proxy-ready"
  }, "*");
})();
</script>
</body>
</html>`;

function sanitizeCspDomains(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (entry): entry is string =>
        typeof entry === "string" &&
        entry.length <= MAX_CSP_ORIGIN_CHARS &&
        CSP_ORIGIN_PATTERN.test(entry),
    )
    .slice(0, MAX_CSP_DOMAINS);
}

function parseCsp(raw: string | null): ControlUiMcpAppCsp {
  if (!raw) {
    return {};
  }
  try {
    const value = JSON.parse(raw) as Record<string, unknown> | null;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return {
      connectDomains: sanitizeCspDomains(value.connectDomains),
      resourceDomains: sanitizeCspDomains(value.resourceDomains),
      frameDomains: sanitizeCspDomains(value.frameDomains),
      baseUriDomains: sanitizeCspDomains(value.baseUriDomains),
    };
  } catch {
    return {};
  }
}

function joinCspSources(sources: string[]): string {
  return [...new Set(sources)].join(" ");
}

export function buildControlUiMcpAppSandboxCspHeader(csp: ControlUiMcpAppCsp): string {
  const resourceDomains = sanitizeCspDomains(csp.resourceDomains);
  const connectDomains = sanitizeCspDomains(csp.connectDomains);
  const frameDomains = sanitizeCspDomains(csp.frameDomains);
  const baseUriDomains = sanitizeCspDomains(csp.baseUriDomains);
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src ${joinCspSources(["'unsafe-inline'", "'unsafe-eval'", "blob:", "data:", ...resourceDomains])}`,
    `style-src ${joinCspSources(["'unsafe-inline'", ...resourceDomains])}`,
    `img-src ${joinCspSources(["data:", "blob:", ...resourceDomains])}`,
    `font-src ${joinCspSources(["data:", ...resourceDomains])}`,
    `media-src ${joinCspSources(["data:", "blob:", ...resourceDomains])}`,
    `connect-src ${joinCspSources(["data:", "blob:", ...connectDomains])}`,
    "worker-src blob:",
    `frame-src ${frameDomains.length > 0 ? joinCspSources(frameDomains) : "'none'"}`,
    `base-uri ${baseUriDomains.length > 0 ? joinCspSources(baseUriDomains) : "'self'"}`,
    "object-src 'none'",
    "frame-ancestors 'self'",
  ].join("; ");
}

export function createControlUiMcpAppSandboxTicket(now = Date.now()): string {
  const payload = Buffer.from(
    JSON.stringify({
      scope: TICKET_SCOPE,
      exp: now + TICKET_TTL_MS,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", ticketSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyTicket(ticket: string | null, now = Date.now()): boolean {
  if (!ticket) {
    return false;
  }
  const [payload, signature, extra] = ticket.split(".");
  if (!payload || !signature || extra) {
    return false;
  }
  const expected = createHmac("sha256", ticketSecret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(signature, "base64url");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return false;
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      scope?: unknown;
      exp?: unknown;
    };
    return (
      parsed.scope === TICKET_SCOPE &&
      typeof parsed.exp === "number" &&
      Number.isFinite(parsed.exp) &&
      parsed.exp >= now
    );
  } catch {
    return false;
  }
}

function readTicketHeader(req: IncomingMessage): string | null {
  const value = req.headers?.[CONTROL_UI_MCP_APP_TICKET_HEADER];
  return typeof value === "string" ? value : null;
}

function applyRejectedRequestHeaders(res: ServerResponse): void {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export function serveControlUiMcpAppSandboxProxy(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  const csp = parseCsp(url.searchParams.get("csp"));
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", buildControlUiMcpAppSandboxCspHeader(csp));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(CONTROL_UI_MCP_APP_SANDBOX_PROXY_HTML);
}

/** Resolve one unguessable, unexpired MCP App view for the trusted host page. */
export function serveControlUiMcpAppResource(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  loadView: (viewId: string) => McpAppViewPayload | undefined = loadMcpAppView,
): void {
  if (!verifyTicket(readTicketHeader(req))) {
    applyRejectedRequestHeaders(res);
    respondNotFound(res);
    return;
  }
  const viewId = url.searchParams.get("viewId") ?? "";
  const view = loadView(viewId);
  if (!view) {
    applyRejectedRequestHeaders(res);
    respondNotFound(res);
    return;
  }
  const body = JSON.stringify(view);
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}
