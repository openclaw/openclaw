import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import type { ResolvedGatewayAuth } from "./auth.js";
import { createGatewayHttpServer } from "./server-http.js";
import { withTempConfig } from "./test-temp-config.js";

function createRequest(params: {
  path: string;
  authorization?: string;
  method?: string;
}): IncomingMessage {
  const headers: Record<string, string> = {
    host: "localhost:18789",
  };
  if (params.authorization) {
    headers.authorization = params.authorization;
  }
  return {
    method: params.method ?? "GET",
    url: params.path,
    headers,
    socket: { remoteAddress: "127.0.0.1" },
  } as IncomingMessage;
}

function createResponse(): {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  getBody: () => string;
} {
  const setHeader = vi.fn();
  let body = "";
  const end = vi.fn((chunk?: unknown) => {
    if (typeof chunk === "string") {
      body = chunk;
      return;
    }
    if (chunk == null) {
      body = "";
      return;
    }
    body = JSON.stringify(chunk);
  });
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader,
    end,
  } as unknown as ServerResponse;
  return {
    res,
    setHeader,
    end,
    getBody: () => body,
  };
}

async function dispatchRequest(
  server: ReturnType<typeof createGatewayHttpServer>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  server.emit("request", req, res);
  await new Promise((resolve) => setImmediate(resolve));
}

describe("gateway plugin HTTP auth boundary", () => {
  test("applies default security headers and optional strict transport security", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-plugin-http-security-headers-test-",
      run: async () => {
        const withoutHsts = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const withoutHstsResponse = createResponse();
        await dispatchRequest(
          withoutHsts,
          createRequest({ path: "/missing" }),
          withoutHstsResponse.res,
        );
        expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith(
          "X-Content-Type-Options",
          "nosniff",
        );
        expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith(
          "Referrer-Policy",
          "no-referrer",
        );
        expect(withoutHstsResponse.setHeader).not.toHaveBeenCalledWith(
          "Strict-Transport-Security",
          expect.any(String),
        );

        const withHsts = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          strictTransportSecurityHeader: "max-age=31536000; includeSubDomains",
          handleHooksRequest: async () => false,
          resolvedAuth,
        });
        const withHstsResponse = createResponse();
        await dispatchRequest(withHsts, createRequest({ path: "/missing" }), withHstsResponse.res);
        expect(withHstsResponse.setHeader).toHaveBeenCalledWith(
          "Strict-Transport-Security",
          "max-age=31536000; includeSubDomains",
        );
      },
    });
  });

  test("requires gateway auth for /api/channels/* plugin routes and allows authenticated pass-through", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-plugin-http-auth-test-",
      run: async () => {
        const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
          const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          if (pathname === "/api/channels/nostr/default/profile") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, route: "channel" }));
            return true;
          }
          if (pathname === "/plugin/public") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, route: "public" }));
            return true;
          }
          return false;
        });

        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest: async () => false,
          handlePluginRequest,
          resolvedAuth,
        });

        const unauthenticated = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/api/channels/nostr/default/profile" }),
          unauthenticated.res,
        );
        expect(unauthenticated.res.statusCode).toBe(401);
        expect(unauthenticated.getBody()).toContain("Unauthorized");
        expect(handlePluginRequest).not.toHaveBeenCalled();

        const authenticated = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/api/channels/nostr/default/profile",
            authorization: "Bearer test-token",
          }),
          authenticated.res,
        );
        expect(authenticated.res.statusCode).toBe(200);
        expect(authenticated.getBody()).toContain('"route":"channel"');

        const unauthenticatedPublic = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/plugin/public" }),
          unauthenticatedPublic.res,
        );
        expect(unauthenticatedPublic.res.statusCode).toBe(200);
        expect(unauthenticatedPublic.getBody()).toContain('"route":"public"');

        expect(handlePluginRequest).toHaveBeenCalledTimes(2);
      },
    });
  });
});
