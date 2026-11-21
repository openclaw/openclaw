// Plugin tests drive Gateway HTTP without the core Vitest harness.
// Re-exporting server-http.test-harness pulls server-request-context.test-support
// into plugin-sdk declaration emit, which cannot name Vitest's Procedure type.
import { EventEmitter } from "node:events";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import type { ResolvedGatewayAuth } from "../gateway/auth.js";
import { createGatewayRequest } from "../gateway/hooks-test-helpers.js";
import { createGatewayHttpServer } from "../gateway/server-http.js";
import type { GatewayHttpServerOptions } from "../gateway/server-http.types.js";
import { withTempConfig } from "../gateway/test-temp-config.js";

export {
  createGatewayPluginRequestHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "../gateway/server/plugins-http.js";

export const AUTH_NONE: ResolvedGatewayAuth = {
  mode: "none",
  token: undefined,
  password: undefined,
  allowTailscale: false,
};

export type GatewayHttpTestResponse = {
  res: ServerResponse;
  headers: ReadonlyArray<readonly [string, unknown]>;
  getBody: () => string;
};

const REQUEST_TIMEOUT_MS = 15_000;

function chunkText(chunk: unknown): string {
  if (typeof chunk === "string") {
    return chunk;
  }
  if (chunk == null) {
    return "";
  }
  if (chunk instanceof Uint8Array) {
    return Buffer.from(chunk).toString("utf8");
  }
  return JSON.stringify(chunk);
}

function createCapturedResponse(req: IncomingMessage): {
  res: ServerResponse;
  ended: Promise<void>;
  response: GatewayHttpTestResponse;
} {
  const headers: Array<[string, unknown]> = [];
  let body = "";
  let resolveEnd = () => {};
  const ended = new Promise<void>((resolve) => {
    resolveEnd = resolve;
  });
  const res = Object.assign(new EventEmitter(), {
    req,
    destroyed: false,
    writableEnded: false,
    writableFinished: false,
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: unknown) {
      headers.push([name, value]);
    },
    removeHeader() {},
    write(chunk?: unknown) {
      body += chunkText(chunk);
      return true;
    },
    end(chunk?: unknown) {
      res.writableEnded = true;
      res.writableFinished = true;
      res.headersSent = true;
      body += chunkText(chunk);
      res.emit("finish");
      resolveEnd();
    },
  });
  return {
    res: toServerResponse(res),
    ended,
    response: {
      res: toServerResponse(res),
      headers,
      getBody: () => body,
    },
  };
}

function toServerResponse(response: EventEmitter): ServerResponse {
  // SAFETY: This emitter is the response the Gateway handler writes through setHeader and end.
  return response as ServerResponse;
}

/** Start one Gateway HTTP server against an isolated config and dispatch requests in-process. */
export async function withPluginGatewayHttpServer(params: {
  prefix: string;
  resolvedAuth: ResolvedGatewayAuth;
  overrides?: Partial<GatewayHttpServerOptions>;
  run: (server: HttpServer) => Promise<void>;
}): Promise<void> {
  await withTempConfig({
    cfg: { gateway: { trustedProxies: [] } },
    prefix: params.prefix,
    run: async () => {
      const server = createGatewayHttpServer({
        clients: new Set(),
        controlUiEnabled: false,
        controlUiBasePath: "/__control__",
        openAiChatCompletionsEnabled: false,
        openResponsesEnabled: false,
        handleHooksRequest: async () => false,
        ...params.overrides,
        resolvedAuth: params.resolvedAuth,
      });
      await params.run(server);
    },
  });
}

/** Emit one request through a Gateway HTTP server and wait until the response ends. */
export async function sendRequest(
  server: HttpServer,
  params: {
    path: string;
    authorization?: string;
    method?: string;
    remoteAddress?: string;
    host?: string;
    headers?: Record<string, string>;
  },
): Promise<GatewayHttpTestResponse> {
  const req = createGatewayRequest(params);
  const captured = createCapturedResponse(req);
  let timeout: NodeJS.Timeout | undefined;
  server.emit("request", req, captured.res);
  try {
    await Promise.race([
      captured.ended,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`gateway test request timed out: ${req.method ?? "GET"} ${req.url}`));
        }, REQUEST_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
  return captured.response;
}
