import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { HooksConfigResolved } from "./hooks.js";
import { createGatewayHttpServer, createHooksRequestHandler } from "./server-http.js";
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

function createHooksConfig(): HooksConfigResolved {
  return {
    basePath: "/hooks",
    token: "hook-secret",
    maxBodyBytes: 1024,
    mappings: [],
    agentPolicy: {
      defaultAgentId: "main",
      knownAgentIds: new Set(["main"]),
      allowedAgentIds: undefined,
    },
    sessionPolicy: {
      allowRequestSessionKey: false,
      defaultSessionKey: undefined,
      allowedSessionKeyPrefixes: undefined,
    },
  };
}

function canonicalizePluginPath(pathname: string): string {
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname;
  }
  const collapsed = decoded.toLowerCase().replace(/\/{2,}/g, "/");
  if (collapsed.length <= 1) {
    return collapsed;
  }
  return collapsed.replace(/\/+$/, "");
}

type RouteVariant = {
  label: string;
  path: string;
};

const CANONICAL_UNAUTH_VARIANTS: RouteVariant[] = [
  { label: "case-variant", path: "/API/channels/nostr/default/profile" },
  { label: "encoded-slash", path: "/api/channels%2Fnostr%2Fdefault%2Fprofile" },
  { label: "encoded-segment", path: "/api/%63hannels/nostr/default/profile" },
  { label: "duplicate-slashes", path: "/api/channels//nostr/default/profile" },
  { label: "trailing-slash", path: "/api/channels/nostr/default/profile/" },
  { label: "malformed-short-percent", path: "/api/channels%2" },
  { label: "malformed-double-slash-short-percent", path: "/api//channels%2" },
];

const CANONICAL_AUTH_VARIANTS: RouteVariant[] = [
  { label: "auth-case-variant", path: "/API/channels/nostr/default/profile" },
  { label: "auth-encoded-segment", path: "/api/%63hannels/nostr/default/profile" },
  { label: "auth-duplicate-trailing-slash", path: "/api/channels//nostr/default/profile/" },
];

function buildChannelPathFuzzCorpus(): RouteVariant[] {
  const variants = [
    "/api/channels/nostr/default/profile",
    "/API/channels/nostr/default/profile",
    "/api/channels//nostr/default/profile/",
    "/api/channels%2Fnostr%2Fdefault%2Fprofile",
    "/api/channels%252Fnostr%252Fdefault%252Fprofile",
    "/api//channels/nostr/default/profile",
    "/api/channels%2",
    "/api/channels%zz",
    "/api//channels%2",
    "/api//channels%zz",
  ];
  return variants.map((path) => ({ label: `fuzz:${path}`, path }));
}

async function expectUnauthorizedVariants(params: {
  server: ReturnType<typeof createGatewayHttpServer>;
  variants: RouteVariant[];
}) {
  for (const variant of params.variants) {
    const response = createResponse();
    await dispatchRequest(params.server, createRequest({ path: variant.path }), response.res);
    expect(response.res.statusCode, variant.label).toBe(401);
    expect(response.getBody(), variant.label).toContain("Unauthorized");
  }
}

async function expectAuthorizedVariants(params: {
  server: ReturnType<typeof createGatewayHttpServer>;
  variants: RouteVariant[];
  authorization: string;
}) {
  for (const variant of params.variants) {
    const response = createResponse();
    await dispatchRequest(
      params.server,
      createRequest({
        path: variant.path,
        authorization: params.authorization,
      }),
      response.res,
    );
    expect(response.res.statusCode, variant.label).toBe(200);
    expect(response.getBody(), variant.label).toContain('"route":"channel-canonicalized"');
  }
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
          if (pathname === "/api/channels") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, route: "channel-root" }));
            return true;
          }
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

        const unauthenticatedRoot = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/api/channels" }),
          unauthenticatedRoot.res,
        );
        expect(unauthenticatedRoot.res.statusCode).toBe(401);
        expect(unauthenticatedRoot.getBody()).toContain("Unauthorized");
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

  test("requires gateway auth for canonicalized /api/channels variants", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-plugin-http-auth-canonicalized-test-",
      run: async () => {
        const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
          const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          const canonicalPath = canonicalizePluginPath(pathname);
          if (canonicalPath === "/api/channels/nostr/default/profile") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, route: "channel-canonicalized" }));
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

        await expectUnauthorizedVariants({ server, variants: CANONICAL_UNAUTH_VARIANTS });
        expect(handlePluginRequest).not.toHaveBeenCalled();

        await expectAuthorizedVariants({
          server,
          variants: CANONICAL_AUTH_VARIANTS,
          authorization: "Bearer test-token",
        });
        expect(handlePluginRequest).toHaveBeenCalledTimes(CANONICAL_AUTH_VARIANTS.length);
      },
    });
  });

  test("rejects unauthenticated plugin-channel fuzz corpus variants", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "token",
      token: "test-token",
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-plugin-http-auth-fuzz-corpus-test-",
      run: async () => {
        const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
          const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
          const canonicalPath = canonicalizePluginPath(pathname);
          if (canonicalPath === "/api/channels/nostr/default/profile") {
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ ok: true, route: "channel-canonicalized" }));
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

        for (const variant of buildChannelPathFuzzCorpus()) {
          const response = createResponse();
          await dispatchRequest(server, createRequest({ path: variant.path }), response.res);
          expect(response.res.statusCode, variant.label).not.toBe(200);
          expect(response.getBody(), variant.label).not.toContain(
            '"route":"channel-canonicalized"',
          );
        }
      },
    });
  });

  test.each(["0.0.0.0", "::"])(
    "returns 404 (not 500) for non-hook routes with hooks enabled and bindHost=%s",
    async (bindHost) => {
      const resolvedAuth: ResolvedGatewayAuth = {
        mode: "none",
        token: undefined,
        password: undefined,
        allowTailscale: false,
      };

      await withTempConfig({
        cfg: { gateway: { trustedProxies: [] } },
        prefix: "openclaw-plugin-http-hooks-bindhost-",
        run: async () => {
          const handleHooksRequest = createHooksRequestHandler({
            getHooksConfig: () => createHooksConfig(),
            bindHost,
            port: 18789,
            logHooks: {
              warn: vi.fn(),
              debug: vi.fn(),
              info: vi.fn(),
              error: vi.fn(),
            } as unknown as ReturnType<typeof createSubsystemLogger>,
            dispatchWakeHook: () => {},
            dispatchAgentHook: () => "run-1",
          });
          const server = createGatewayHttpServer({
            canvasHost: null,
            clients: new Set(),
            controlUiEnabled: false,
            controlUiBasePath: "/__control__",
            openAiChatCompletionsEnabled: false,
            openResponsesEnabled: false,
            handleHooksRequest,
            resolvedAuth,
          });

          const response = createResponse();
          await dispatchRequest(server, createRequest({ path: "/" }), response.res);

          expect(response.res.statusCode).toBe(404);
          expect(response.getBody()).toBe("Not Found");
        },
      });
    },
  );

  test("rejects query-token hooks requests with bindHost=::", async () => {
    const resolvedAuth: ResolvedGatewayAuth = {
      mode: "none",
      token: undefined,
      password: undefined,
      allowTailscale: false,
    };

    await withTempConfig({
      cfg: { gateway: { trustedProxies: [] } },
      prefix: "openclaw-plugin-http-hooks-query-token-",
      run: async () => {
        const handleHooksRequest = createHooksRequestHandler({
          getHooksConfig: () => createHooksConfig(),
          bindHost: "::",
          port: 18789,
          logHooks: {
            warn: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
            error: vi.fn(),
          } as unknown as ReturnType<typeof createSubsystemLogger>,
          dispatchWakeHook: () => {},
          dispatchAgentHook: () => "run-1",
        });
        const server = createGatewayHttpServer({
          canvasHost: null,
          clients: new Set(),
          controlUiEnabled: false,
          controlUiBasePath: "/__control__",
          openAiChatCompletionsEnabled: false,
          openResponsesEnabled: false,
          handleHooksRequest,
          resolvedAuth,
        });

        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/hooks/wake?token=bad" }),
          response.res,
        );

        expect(response.res.statusCode).toBe(400);
        expect(response.getBody()).toContain("Hook token must be provided");
      },
    });
  });
});
