import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import {
  buildSandboxHostDocument,
  decodeSandboxHostCsp,
  SANDBOX_HOST_PATH,
} from "../agents/sandbox-host.js";
import { respondPlainText } from "./control-ui-http-utils.js";
import {
  getRemoteControlUiIngressContext,
  assertRemoteControlUiIngressCurrent,
} from "./ingress-attribution.js";
import type { GatewayClient } from "./server-methods/types.js";
import { handleSessionFilePreviewHttpRequest } from "./session-file-preview-http.js";

function handleMcpAppSandboxHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) {
    respondPlainText(res, 400, "Bad Request");
    return true;
  }
  if (url.pathname !== SANDBOX_HOST_PATH || (req.method !== "GET" && req.method !== "HEAD")) {
    return false;
  }

  let csp;
  try {
    csp = decodeSandboxHostCsp(url.searchParams.get("csp"));
  } catch {
    respondPlainText(res, 400, "invalid MCP App sandbox policy");
    return true;
  }

  const ingress = getRemoteControlUiIngressContext(req);
  assertRemoteControlUiIngressCurrent(ingress);
  const { html, headers, version } = buildSandboxHostDocument(
    csp,
    ingress ? [ingress.publicOrigin, ...ingress.frameAncestors] : undefined,
  );
  res.statusCode = 200;
  for (const [name, value] of Object.entries(headers)) {
    res.setHeader(name, value);
  }
  // A mismatched URL can come from another Gateway version sharing this host.
  // Serve the current shell, but never retain it under a different content hash.
  res.setHeader(
    "Cache-Control",
    url.searchParams.get("v") === version ? "public, max-age=31536000, immutable" : "no-store",
  );
  // Keep GET and HEAD representation metadata aligned while suppressing the HEAD body.
  res.setHeader("Content-Length", String(Buffer.byteLength(html)));
  res.end(req.method === "HEAD" ? undefined : html);
  return true;
}

type SandboxHostOptions = { clients: ReadonlySet<GatewayClient> };

/** Isolated shell and explicitly granted file resources, never arbitrary Gateway data. */
export function createSandboxHostHttpServer(
  tlsOptions?: TlsOptions,
  options?: SandboxHostOptions,
): HttpServer {
  const handler = createSandboxHostHttpRequestHandler(options);
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    void handler(req, res);
  };
  return tlsOptions ? createHttpsServer(tlsOptions, listener) : createHttpServer(listener);
}

/** Shared dedicated-surface owner for listener and virtual ingress transports. */
export function createSandboxHostHttpRequestHandler(
  options?: SandboxHostOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req: IncomingMessage, res: ServerResponse) => {
    assertRemoteControlUiIngressCurrent(getRemoteControlUiIngressContext(req));
    if (options && (await handleSessionFilePreviewHttpRequest(req, res, options.clients))) {
      return;
    }
    if (!handleMcpAppSandboxHttpRequest(req, res)) {
      respondPlainText(res, 404, "Not Found");
    }
  };
}
