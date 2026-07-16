// Plugin HTTP auth tests cover protected route canonicalization, operator scope
// checks, hook/plugin route precedence, and unauthorized variant handling.
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
} from "./control-ui-contract.js";
import { setControlUiPluginAuthCookie } from "./control-ui-plugin-auth-cookie.js";
import { checkGatewayHttpRequestAuth } from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { OperatorScope } from "./operator-scopes.js";
import { canonicalizePathVariant } from "./security-path.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  buildChannelPathFuzzCorpus,
  createHooksHandler,
  createRequest,
  createResponse,
  createTestGatewayServer,
  dispatchRequest,
  expectUnauthorizedResponse,
  expectUnauthorizedVariants,
  sendRequest,
  withGatewayServer,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";
import { createTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { withTempConfig } from "./test-temp-config.js";

type PluginRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

function canonicalizePluginPath(pathname: string): string {
  return canonicalizePathVariant(pathname);
}

function respondJsonRoute(res: ServerResponse, route: string): true {
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ ok: true, route }));
  return true;
}

function createControlUiPluginAuthCookieForTest(
  scopes: string[],
  params: {
    pluginId?: string;
    path?: string;
    match?: "exact" | "prefix";
    generation?: string;
    nowMs?: number;
  } = {},
): string {
  const response = createResponse();
  setControlUiPluginAuthCookie(
    response.res,
    [
      {
        pluginId: params.pluginId ?? "runtime-scope-control-ui-cookie",
        path: params.path ?? "/secure-hook",
        match: params.match ?? "exact",
        scopes: scopes as OperatorScope[],
      },
    ],
    {
      generation: params.generation ?? resolveSharedGatewaySessionGeneration(AUTH_TOKEN),
      nowMs: params.nowMs,
    },
  );
  const setCookie = response.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
  const cookie = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof cookie !== "string") {
    throw new Error("Expected control ui plugin auth cookie");
  }
  return cookie;
}

function createHealthzPluginHandler() {
  return vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/healthz") {
      return false;
    }
    return respondJsonRoute(res, "plugin-health");
  });
}

async function expectHealthzProbeReserved(params: {
  server: Parameters<typeof sendRequest>[0];
  handlePluginRequest: ReturnType<typeof createHealthzPluginHandler>;
}) {
  const response = await sendRequest(params.server, { path: "/healthz" });
  expect(response.res.statusCode).toBe(200);
  expect(response.getBody()).toBe(JSON.stringify({ ok: true, status: "live" }));
  expect(params.handlePluginRequest).not.toHaveBeenCalled();
}

function createMattermostCallbackConfig(callbackPath: string) {
  return {
    gateway: { trustedProxies: [] },
    channels: {
      mattermost: {
        commands: { callbackPath },
      },
    },
  };
}

function createRootMountedControlUiOverrides(handlePluginRequest: PluginRequestHandler) {
  return {
    controlUiEnabled: true,
    controlUiBasePath: "",
    controlUiRoot: { kind: "missing" as const },
    handlePluginRequest,
  };
}

const withRootMountedControlUiServer = (params: {
  prefix: string;
  handlePluginRequest: PluginRequestHandler;
  run: Parameters<typeof withGatewayServer>[0]["run"];
}) =>
  withPluginGatewayServer({
    prefix: params.prefix,
    resolvedAuth: AUTH_NONE,
    overrides: createRootMountedControlUiOverrides(params.handlePluginRequest),
    run: params.run,
  });

const withPluginGatewayServer = (params: Parameters<typeof withGatewayServer>[0]) =>
  withGatewayServer(params);

const PROBE_CASES = [
  { path: "/health", status: "live" },
  { path: "/healthz", status: "live" },
  { path: "/ready", status: "ready" },
  { path: "/readyz", status: "ready" },
] as const;

async function expectProbeRoutesHealthy(server: Parameters<typeof sendRequest>[0]) {
  for (const probeCase of PROBE_CASES) {
    const response = await sendRequest(server, { path: probeCase.path });
    expect(response.res.statusCode, probeCase.path).toBe(200);
    expect(response.getBody(), probeCase.path).toBe(
      JSON.stringify({ ok: true, status: probeCase.status }),
    );
  }
}

function createRuntimeScopeRecorderHandler(params: {
  pluginId: string;
  path: string;
  method: string;
  observedRuntimeScopes: string[][];
  allowedResults: boolean[];
  gatewayRuntimeScopeSurface?: "trusted-operator";
  match?: "exact" | "prefix";
}) {
  return createGatewayPluginRequestHandler({
    registry: createTestRegistry({
      httpRoutes: [
        {
          pluginId: params.pluginId,
          source: params.pluginId,
          path: params.path,
          auth: "gateway",
          ...(params.gatewayRuntimeScopeSurface
            ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface }
            : {}),
          match: params.match ?? "exact",
          handler: async (_req: IncomingMessage, res: ServerResponse) => {
            const runtimeScopes =
              getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
            params.observedRuntimeScopes.push(runtimeScopes);
            const auth = authorizeOperatorScopesForMethod(params.method, runtimeScopes);
            params.allowedResults.push(auth.allowed);
            res.statusCode = 200;
            res.end("ok");
            return true;
          },
        },
      ],
    }),
    log: { warn: vi.fn() } as unknown as Parameters<
      typeof createGatewayPluginRequestHandler
    >[0]["log"],
  });
}

async function expectPluginRequestOk(
  server: Parameters<typeof dispatchRequest>[0],
  request: Parameters<typeof createRequest>[0],
): Promise<void> {
  const response = createResponse();
  await dispatchRequest(server, createRequest(request), response.res);
  expect(response.res.statusCode).toBe(200);
  expect(response.getBody()).toBe("ok");
}

describe("gateway plugin HTTP auth boundary", () => {
  test("applies default security headers and optional strict transport security", async () => {
    await withGatewayTempConfig("openclaw-plugin-http-security-headers-test-", async () => {
      const withoutHsts = createTestGatewayServer({ resolvedAuth: AUTH_NONE });
      const withoutHstsResponse = await sendRequest(withoutHsts, { path: "/missing" });
      expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith(
        "X-Content-Type-Options",
        "nosniff",
      );
      expect(withoutHstsResponse.setHeader).toHaveBeenCalledWith("Referrer-Policy", "no-referrer");
      expect(
        withoutHstsResponse.setHeader.mock.calls.some(
          ([headerName]) => headerName === "Strict-Transport-Security",
        ),
      ).toBe(false);

      const withHsts = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: {
          strictTransportSecurityHeader: "max-age=31536000; includeSubDomains",
        },
      });
      const withHstsResponse = await sendRequest(withHsts, { path: "/missing" });
      expect(withHstsResponse.setHeader).toHaveBeenCalledWith(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains",
      );
    });
  });

  test("serves unauthenticated liveness/readiness probe routes when no other route handles them", async () => {
    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-test-",
      resolvedAuth: AUTH_TOKEN,
      run: async (server) => {
        await expectProbeRoutesHealthy(server);
      },
    });
  });

  test("reserves gateway probe routes ahead of plugin routes", async () => {
    const handlePluginRequest = createHealthzPluginHandler();

    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-shadow-test-",
      resolvedAuth: AUTH_NONE,
      overrides: { handlePluginRequest },
      run: async (server) => {
        await expectHealthzProbeReserved({ server, handlePluginRequest });
      },
    });
  });

  test("rejects non-GET/HEAD methods on probe routes", async () => {
    await withGatewayServer({
      prefix: "openclaw-plugin-http-probes-method-test-",
      resolvedAuth: AUTH_NONE,
      run: async (server) => {
        const postResponse = await sendRequest(server, { path: "/healthz", method: "POST" });
        expect(postResponse.res.statusCode).toBe(405);
        expect(postResponse.setHeader).toHaveBeenCalledWith("Allow", "GET, HEAD");
        expect(postResponse.getBody()).toBe("Method Not Allowed");

        const headResponse = await sendRequest(server, { path: "/readyz", method: "HEAD" });
        expect(headResponse.res.statusCode).toBe(200);
        expect(headResponse.getBody()).toBe("");
      },
    });
  });

  test("preserves trusted-proxy read scopes for gateway-auth plugin runtime routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const writeAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope",
      path: "/secure-hook",
      method: "node.invoke",
      observedRuntimeScopes,
      allowedResults: writeAllowedResults,
    });

    await withTempConfig({
      cfg: {
        gateway: {
          trustedProxies: ["203.0.113.10"],
        },
      },
      prefix: "openclaw-plugin-http-runtime-scope-trusted-proxy-test-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: {
            mode: "trusted-proxy",
            allowTailscale: false,
            trustedProxy: { userHeader: "x-forwarded-user" },
          },
          overrides: {
            handlePluginRequest,
            shouldEnforcePluginGatewayAuth: (pathContext) =>
              pathContext.pathname === "/secure-hook",
          },
        });

        await expectPluginRequestOk(server, {
          path: "/secure-hook",
          remoteAddress: "203.0.113.10",
          headers: {
            "x-forwarded-user": "operator",
            "x-forwarded-for": "198.51.100.20",
            "x-openclaw-scopes": "operator.read",
          },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read"]]);
    expect(writeAllowedResults).toEqual([false]);
  });

  test("keeps write runtime scopes for shared-secret bearer gateway-auth plugin routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const writeAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-bearer",
      path: "/secure-hook",
      method: "node.invoke",
      observedRuntimeScopes,
      allowedResults: writeAllowedResults,
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-bearer-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-hook",
          authorization: "Bearer test-token",
          headers: {
            "x-openclaw-scopes": "operator.read",
          },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.write"]]);
    expect(writeAllowedResults).toEqual([true]);
  });

  test("accepts control ui plugin auth cookies for gateway-auth plugin routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const writeAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie",
      path: "/secure-hook",
      method: "node.invoke",
      observedRuntimeScopes,
      allowedResults: writeAllowedResults,
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read", "operator.write"]);

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-hook",
          headers: {
            cookie,
          },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read", "operator.write"]]);
    expect(writeAllowedResults).toEqual([true]);
  });

  test("probes cookie availability inside the sandbox without invoking plugin code", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie",
      path: "/secure-hook",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"]);
    const nonce = "0123456789abcdef0123456789abcdef";
    const targetOrigin = "https://gateway.example";
    const path = `/secure-hook?${CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY}=${nonce}&${CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY}=${encodeURIComponent(targetOrigin)}`;

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-probe-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        const unauthorized = createResponse();
        await dispatchRequest(server, createRequest({ path }), unauthorized.res);
        expect(unauthorized.res.statusCode).toBe(401);

        const authorized = createResponse();
        await dispatchRequest(server, createRequest({ path, headers: { cookie } }), authorized.res);
        expect(authorized.res.statusCode).toBe(200);
        expect(authorized.getBody()).toContain(
          JSON.stringify({ type: CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE, nonce }),
        );
        expect(authorized.getBody()).toContain(JSON.stringify(targetOrigin));
        expect(authorized.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
        expect(authorized.setHeader).toHaveBeenCalledWith(
          "Content-Security-Policy",
          expect.stringContaining("frame-ancestors 'self'"),
        );

        const invalid = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: `/secure-hook?${CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY}=${nonce}`,
            headers: { cookie },
          }),
          invalid.res,
        );
        expect(invalid.res.statusCode).toBe(400);
      },
    });

    expect(observedRuntimeScopes).toEqual([]);
  });

  test("rejects control ui plugin auth cookies on sibling gateway-auth plugin routes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-route-bound",
      path: "/other-secure-hook",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "runtime-scope-control-ui-cookie-route-bound",
      path: "/secure-hook",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-route-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/other-secure-hook",
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/other-secure-hook",
            headers: {
              cookie,
            },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(observedRuntimeScopes).toEqual([]);
  });

  test("does not broaden an exact-route grant to child paths", async () => {
    const childHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "exact-plugin",
            path: "/secure-hook/child",
            auth: "gateway",
            match: "exact",
            handler: childHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "exact-plugin",
      path: "/secure-hook",
      match: "exact",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-exact-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/secure-hook/child", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(childHandler).not.toHaveBeenCalled();
  });

  test("rejects encoded path traversal outside the signed route root", async () => {
    const outerHandler = vi.fn(async () => true);
    const adminHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "same-plugin",
            path: "/admin",
            auth: "gateway",
            match: "exact",
            handler: adminHandler,
          },
          {
            pluginId: "same-plugin",
            path: "/plugins/same",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.admin"], {
      pluginId: "same-plugin",
      path: "/plugins/same",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-canonical-path-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/plugins/same/%252e%252e/%252e%252e/admin",
            headers: { cookie },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(outerHandler).not.toHaveBeenCalled();
    expect(adminHandler).not.toHaveBeenCalled();
  });

  test("accepts control ui plugin auth cookies on child paths under the bound tab route", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-route-child",
      path: "/secure-hook",
      match: "prefix",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "runtime-scope-control-ui-cookie-route-child",
      path: "/secure-hook",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-route-child-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/secure-hook/assets/app.js",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-hook/assets/app.js",
          headers: {
            cookie,
          },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read"]]);
  });

  test("rejects mutation requests that present only a control ui plugin auth cookie", async () => {
    const handlePluginRequest = vi.fn(async () => true);
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "read-only-plugin",
      path: "/secure-hook",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-read-only-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/secure-hook/action",
            method: "POST",
            headers: { cookie },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(handlePluginRequest).not.toHaveBeenCalled();
  });

  test("does not accept a control ui plugin auth cookie for websocket upgrade auth", async () => {
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"]);
    const result = await checkGatewayHttpRequestAuth({
      req: createRequest({
        path: "/secure-hook",
        method: "GET",
        headers: {
          connection: "Upgrade",
          cookie,
          upgrade: "websocket",
        },
      }),
      auth: AUTH_TOKEN,
      cfg: {},
    });

    expect(result.ok).toBe(false);
  });

  test("rejects control ui plugin auth cookies after shared auth generation changes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-generation-bound",
      path: "/secure-hook",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "runtime-scope-control-ui-cookie-generation-bound",
      generation: "stale-generation",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-generation-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) => pathContext.pathname === "/secure-hook",
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({
            path: "/secure-hook",
            headers: {
              cookie,
            },
          }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(observedRuntimeScopes).toEqual([]);
  });

  test("keeps trusted-operator routes constrained to control ui plugin auth cookie scopes", async () => {
    const observedRuntimeScopes: string[][] = [];
    const adminAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-control-ui-cookie-trusted-operator",
      path: "/secure-admin-hook",
      method: "set-heartbeats",
      observedRuntimeScopes,
      allowedResults: adminAllowedResults,
      gatewayRuntimeScopeSurface: "trusted-operator",
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read", "operator.write"], {
      pluginId: "runtime-scope-control-ui-cookie-trusted-operator",
      path: "/secure-admin-hook",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-cookie-trusted-operator-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/secure-admin-hook",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-admin-hook",
          headers: {
            cookie,
          },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read", "operator.write"]]);
    expect(adminAllowedResults).toEqual([false]);
  });

  test("rejects a broader plugin grant when a nested gateway route belongs to another plugin", async () => {
    const outerHandler = vi.fn(async () => true);
    const nestedHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
          {
            pluginId: "nested-plugin",
            path: "/plugins/outer/nested",
            auth: "gateway",
            match: "exact",
            handler: nestedHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.write"], {
      pluginId: "outer-plugin",
      path: "/plugins/outer",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-plugin-bound-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/plugins/outer/nested", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(401);
      },
    });

    expect(outerHandler).not.toHaveBeenCalled();
    expect(nestedHandler).not.toHaveBeenCalled();
  });

  test("selects the most-specific valid plugin grant independent of cookie header order", async () => {
    const observedRuntimeScopes: string[][] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
      method: "assistant.media.get",
      observedRuntimeScopes,
      allowedResults: [],
    });
    const broadCookie = createControlUiPluginAuthCookieForTest(["operator.write"], {
      pluginId: "outer-plugin",
      path: "/plugins/outer",
      match: "prefix",
    });
    const nestedCookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-specificity-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/plugins/outer/nested",
          headers: { cookie: `${broadCookie}; ${nestedCookie}` },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.read"]]);
  });

  test("selects the grant owned by the first dispatched gateway route", async () => {
    const observedRuntimeScopes: string[][] = [];
    const exactOuterHandler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      observedRuntimeScopes.push(
        getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
      );
      res.statusCode = 200;
      res.end("ok");
      return true;
    });
    const nestedHandler = vi.fn(async () => true);
    const outerHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer/nested/action",
            auth: "gateway",
            match: "exact",
            handler: exactOuterHandler,
          },
          {
            pluginId: "nested-plugin",
            path: "/plugins/outer/nested",
            auth: "gateway",
            match: "prefix",
            handler: nestedHandler,
          },
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const outerCookie = createControlUiPluginAuthCookieForTest(["operator.write"], {
      pluginId: "outer-plugin",
      path: "/plugins/outer",
      match: "prefix",
    });
    const nestedCookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
      match: "prefix",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-dispatch-owner-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/plugins/outer/nested/action",
          headers: { cookie: `${outerCookie}; ${nestedCookie}` },
        });
      },
    });

    expect(observedRuntimeScopes).toEqual([["operator.write"]]);
    expect(exactOuterHandler).toHaveBeenCalledOnce();
    expect(nestedHandler).not.toHaveBeenCalled();
    expect(outerHandler).not.toHaveBeenCalled();
  });

  test("does not fall through from a granted route into another plugin's gateway route", async () => {
    const nestedHandler = vi.fn(async () => false);
    const outerHandler = vi.fn(async () => true);
    const handlePluginRequest = createGatewayPluginRequestHandler({
      registry: createTestRegistry({
        httpRoutes: [
          {
            pluginId: "nested-plugin",
            path: "/plugins/outer/nested",
            auth: "gateway",
            match: "exact",
            handler: nestedHandler,
          },
          {
            pluginId: "outer-plugin",
            path: "/plugins/outer",
            auth: "gateway",
            match: "prefix",
            handler: outerHandler,
          },
        ],
      }),
      log: { warn: vi.fn() } as unknown as Parameters<
        typeof createGatewayPluginRequestHandler
      >[0]["log"],
    });
    const cookie = createControlUiPluginAuthCookieForTest(["operator.read"], {
      pluginId: "nested-plugin",
      path: "/plugins/outer/nested",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-cookie-fallthrough-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const response = createResponse();
        await dispatchRequest(
          server,
          createRequest({ path: "/plugins/outer/nested", headers: { cookie } }),
          response.res,
        );
        expect(response.res.statusCode).toBe(404);
      },
    });

    expect(nestedHandler).toHaveBeenCalledOnce();
    expect(outerHandler).not.toHaveBeenCalled();
  });

  test("allows trusted-operator plugin routes to resolve admin-capable runtime scopes for shared-secret bearer auth without scope headers", async () => {
    const observedRuntimeScopes: string[][] = [];
    const adminAllowedResults: boolean[] = [];
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "runtime-scope-bearer-trusted-operator",
      path: "/secure-admin-hook",
      method: "set-heartbeats",
      observedRuntimeScopes,
      allowedResults: adminAllowedResults,
      gatewayRuntimeScopeSurface: "trusted-operator",
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-runtime-scope-bearer-trusted-operator-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname === "/secure-admin-hook",
      },
      run: async (server) => {
        await expectPluginRequestOk(server, {
          path: "/secure-admin-hook",
          authorization: "Bearer test-token",
        });
      },
    });

    expect(observedRuntimeScopes).toHaveLength(1);
    expect(observedRuntimeScopes[0]).toContain("operator.admin");
    expect(observedRuntimeScopes[0]).toContain("operator.read");
    expect(observedRuntimeScopes[0]).toContain("operator.write");
    expect(adminAllowedResults).toEqual([true]);
  });

  test("allows unauthenticated Mattermost slash callback routes while keeping other channel routes protected", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/channels/mattermost/command") {
        res.statusCode = 200;
        res.end("ok:mm-callback");
        return true;
      }
      if (pathname === "/api/channels/nostr/default/profile") {
        res.statusCode = 200;
        res.end("ok:nostr");
        return true;
      }
      return false;
    });

    await withTempConfig({
      cfg: createMattermostCallbackConfig("/api/channels/mattermost/command"),
      prefix: "openclaw-plugin-http-auth-mm-callback-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: { handlePluginRequest },
        });

        const slashCallback = await sendRequest(server, {
          path: "/api/channels/mattermost/command",
          method: "POST",
        });
        expect(slashCallback.res.statusCode).toBe(200);
        expect(slashCallback.getBody()).toBe("ok:mm-callback");

        const otherChannelUnauthed = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
        });
        expect(otherChannelUnauthed.res.statusCode).toBe(401);
        expect(otherChannelUnauthed.getBody()).toContain("Unauthorized");
      },
    });
  });

  test("does not bypass auth when mattermost callbackPath points to non-mattermost channel routes", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/api/channels/nostr/default/profile") {
        res.statusCode = 200;
        res.end("ok:nostr");
        return true;
      }
      return false;
    });

    await withTempConfig({
      cfg: createMattermostCallbackConfig("/api/channels/nostr/default/profile"),
      prefix: "openclaw-plugin-http-auth-mm-misconfig-",
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: { handlePluginRequest },
        });

        const unauthenticated = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
          method: "POST",
        });

        expect(unauthenticated.res.statusCode).toBe(401);
        expect(unauthenticated.getBody()).toContain("Unauthorized");
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("keeps wildcard plugin handlers ungated when auth enforcement predicate excludes their paths", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/plugin/routed") {
        return respondJsonRoute(res, "routed");
      }
      if (pathname === "/googlechat") {
        return respondJsonRoute(res, "wildcard-handler");
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-wildcard-handler-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: (pathContext) =>
          pathContext.pathname.startsWith("/api/channels") ||
          pathContext.pathname === "/plugin/routed",
      },
      run: async (server) => {
        const unauthenticatedRouted = await sendRequest(server, { path: "/plugin/routed" });
        expectUnauthorizedResponse(unauthenticatedRouted);

        const unauthenticatedWildcard = await sendRequest(server, { path: "/googlechat" });
        expect(unauthenticatedWildcard.res.statusCode).toBe(200);
        expect(unauthenticatedWildcard.getBody()).toContain('"route":"wildcard-handler"');

        const authenticatedRouted = await sendRequest(server, {
          path: "/plugin/routed",
          authorization: "Bearer test-token",
        });
        expect(authenticatedRouted.res.statusCode).toBe(200);
        expect(authenticatedRouted.getBody()).toContain('"route":"routed"');
      },
    });
  });

  test("uses /api/channels auth by default while keeping wildcard handlers ungated with no predicate", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (canonicalizePluginPath(pathname) === "/api/channels/nostr/default/profile") {
        return respondJsonRoute(res, "channel-default");
      }
      if (pathname === "/googlechat") {
        return respondJsonRoute(res, "wildcard-default");
      }
      return false;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-wildcard-default-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handlePluginRequest },
      run: async (server) => {
        const unauthenticated = await sendRequest(server, { path: "/googlechat" });
        expect(unauthenticated.res.statusCode).toBe(200);
        expect(unauthenticated.getBody()).toContain('"route":"wildcard-default"');

        const unauthenticatedChannel = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
        });
        expectUnauthorizedResponse(unauthenticatedChannel);

        const unauthenticatedDeepEncodedChannel = await sendRequest(server, {
          path: "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
        });
        expectUnauthorizedResponse(unauthenticatedDeepEncodedChannel);

        const authenticated = await sendRequest(server, {
          path: "/googlechat",
          authorization: "Bearer test-token",
        });
        expect(authenticated.res.statusCode).toBe(200);
        expect(authenticated.getBody()).toContain('"route":"wildcard-default"');

        const authenticatedChannel = await sendRequest(server, {
          path: "/api/channels/nostr/default/profile",
          authorization: "Bearer test-token",
        });
        expect(authenticatedChannel.res.statusCode).toBe(200);
        expect(authenticatedChannel.getBody()).toContain('"route":"channel-default"');

        const authenticatedDeepEncodedChannel = await sendRequest(server, {
          path: "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
          authorization: "Bearer test-token",
        });
        expect(authenticatedDeepEncodedChannel.res.statusCode).toBe(200);
        expect(authenticatedDeepEncodedChannel.getBody()).toContain('"route":"channel-default"');
      },
    });
  });

  test("serves plugin routes before control ui spa fallback", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/plugins/diffs/view/demo-id/demo-token") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end("<!doctype html><title>diff-view</title>");
        return true;
      }
      return false;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-precedence-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, {
          path: "/plugins/diffs/view/demo-id/demo-token",
        });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toContain("diff-view");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test.each([
    { label: "root-mounted", basePath: "", path: "/settings/plugins" },
    {
      label: "base-path-mounted",
      basePath: "/openclaw",
      path: "/openclaw/settings/plugins",
    },
  ])(
    "reserves the $label plugin manager GET while preserving writes",
    async ({ basePath, path }) => {
      const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== path) {
          return false;
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("plugin-handled");
        return true;
      });

      await withGatewayServer({
        prefix: "openclaw-plugin-http-plugin-manager-reserved-test-",
        resolvedAuth: AUTH_NONE,
        overrides: {
          controlUiEnabled: true,
          controlUiBasePath: basePath,
          controlUiRoot: { kind: "missing" },
          handlePluginRequest,
        },
        run: async (server) => {
          const read = await sendRequest(server, { path });
          expect(read.res.statusCode).toBe(503);
          expect(read.getBody()).toContain("Control UI assets not found");
          expect(handlePluginRequest).not.toHaveBeenCalled();

          const write = await sendRequest(server, { path, method: "POST" });
          expect(write.res.statusCode).toBe(200);
          expect(write.getBody()).toBe("plugin-handled");
          expect(handlePluginRequest).toHaveBeenCalledTimes(1);
        },
      });
    },
  );

  test("reserves standalone approval documents ahead of plugin routes", async () => {
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("plugin-shadowed-approval");
      return true;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-approval-reservation-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, { path: "/approve/plugin%3Arequest.json" });

        expect(response.res.statusCode).toBe(503);
        expect(response.getBody()).toContain("Control UI assets not found");
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("terminates approval-document writes at the reservation stage", async () => {
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("plugin-shadowed-approval-write");
      return true;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-approval-write-reservation-test-",
      handlePluginRequest,
      run: async (server) => {
        for (const method of ["POST", "PUT"] as const) {
          const response = await sendRequest(server, {
            path: "/approve/plugin%3Arequest.json",
            method,
          });

          // The server approval-document stage owns the terminal 404 for all
          // methods; writes never fall through to plugin HTTP handlers.
          expect(response.res.statusCode, method).toBe(404);
          expect(response.getBody(), method).toBe("Not Found");
        }
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("keeps approval documents reserved when control ui serving is disabled", async () => {
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("plugin-shadowed-disabled-approval");
      return true;
    });

    await withPluginGatewayServer({
      prefix: "openclaw-plugin-http-disabled-approval-reservation-test-",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: false,
        controlUiBasePath: "",
        handlePluginRequest,
      },
      run: async (server) => {
        const response = await sendRequest(server, { path: "/approve/exec%3Arequest" });

        expect(response.res.statusCode).toBe(404);
        expect(response.getBody()).toBe("Not Found");
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("passes POST webhook routes through root-mounted control ui to plugins", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (req.method !== "POST" || pathname !== "/imessage-webhook") {
        return false;
      }
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("plugin-webhook");
      return true;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-webhook-post-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, {
          path: "/imessage-webhook",
          method: "POST",
        });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("plugin-webhook");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("plugin routes take priority over control ui catch-all", async () => {
    const handlePluginRequest = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/my-plugin/inbound") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("plugin-handled");
        return true;
      }
      return false;
    });

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-shadow-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, { path: "/my-plugin/inbound" });

        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toContain("plugin-handled");
        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
      },
    });
  });

  test("unmatched plugin paths fall through to control ui", async () => {
    const handlePluginRequest = vi.fn(async () => false);

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-fallthrough-test-",
      handlePluginRequest,
      run: async (server) => {
        const response = await sendRequest(server, { path: "/chat" });

        expect(handlePluginRequest).toHaveBeenCalledTimes(1);
        expect(response.res.statusCode).toBe(503);
        expect(response.getBody()).toContain("Control UI assets not found");
      },
    });
  });

  test("root-mounted control ui does not swallow gateway probe routes", async () => {
    const handlePluginRequest = vi.fn(async () => false);

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-probes-test-",
      handlePluginRequest,
      run: async (server) => {
        await expectProbeRoutesHealthy(server);
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test("root-mounted control ui keeps gateway probe routes reserved ahead of plugins", async () => {
    const handlePluginRequest = createHealthzPluginHandler();

    await withRootMountedControlUiServer({
      prefix: "openclaw-plugin-http-control-ui-probe-shadow-test-",
      handlePluginRequest,
      run: async (server) => {
        await expectHealthzProbeReserved({ server, handlePluginRequest });
      },
    });
  });

  test("enforces auth before plugin handlers on encoded protected-path variants", async () => {
    const encodedVariants = buildChannelPathFuzzCorpus().filter((variant) =>
      variant.path.includes("%"),
    );
    const handlePluginRequest = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: true, route: "should-not-run" }));
      return true;
    });

    await withGatewayServer({
      prefix: "openclaw-plugin-http-auth-encoded-order-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: { handlePluginRequest },
      run: async (server) => {
        await expectUnauthorizedVariants({ server, variants: encodedVariants });
        expect(handlePluginRequest).not.toHaveBeenCalled();
      },
    });
  });

  test.each(["0.0.0.0", "::"])(
    "returns 404 (not 500) for non-hook routes with hooks enabled and bindHost=%s",
    async (bindHost) => {
      await withGatewayTempConfig("openclaw-plugin-http-hooks-bindhost-", async () => {
        const handleHooksRequest = createHooksHandler(bindHost);
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_NONE,
          overrides: { handleHooksRequest },
        });

        const response = await sendRequest(server, { path: "/" });

        expect(response.res.statusCode).toBe(404);
        expect(response.getBody()).toBe("Not Found");
      });
    },
  );

  test("rejects query-token hooks requests with bindHost=::", async () => {
    await withGatewayTempConfig("openclaw-plugin-http-hooks-query-token-", async () => {
      const handleHooksRequest = createHooksHandler("::");
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: { handleHooksRequest },
      });

      const response = await sendRequest(server, { path: "/hooks/wake?token=bad" });

      expect(response.res.statusCode).toBe(400);
      expect(response.getBody()).toContain("Hook token must be provided");
    });
  });
});
