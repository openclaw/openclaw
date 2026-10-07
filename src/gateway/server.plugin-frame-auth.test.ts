import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, test, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHttpRouteRegistration } from "../plugins/registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  CONTROL_UI_PLUGIN_AUTH_PROBE_MESSAGE,
  CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY,
  CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY,
} from "./control-ui-contract.js";
import { setControlUiPluginAuthCookie } from "./control-ui-plugin-auth-cookie.js";
import { resolveControlUiPluginAuthCookieGeneration } from "./http-auth-plugin-cookie.js";
import { checkGatewayHttpRequestAuth } from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import type { OperatorScope } from "./operator-scopes.js";
import {
  AUTH_TOKEN,
  createRequest,
  createResponse,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "./server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

function cookie(
  pluginId: string,
  path: string,
  match: "exact" | "prefix" = "exact",
  scopes: OperatorScope[] = ["operator.read"],
) {
  const response = createResponse();
  setControlUiPluginAuthCookie(response.res, [{ pluginId, path, match, scopes }], {
    generation: resolveControlUiPluginAuthCookieGeneration(
      resolveSharedGatewaySessionGeneration(AUTH_TOKEN),
      getRuntimeConfig(),
    ),
  });
  const value = response.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") {
    throw new Error("Expected plugin cookie");
  }
  return header;
}

function route(
  pluginId: string,
  path: string,
  handler: PluginHttpRouteRegistration["handler"],
  match: "exact" | "prefix" = "exact",
): PluginHttpRouteRegistration {
  return { pluginId, path, auth: "gateway", match, handler };
}

function createRuntimeScopeRecorderHandler(params: {
  pluginId: string;
  path: string;
  method: string;
  observedRuntimeScopes: string[][];
  allowedResults: boolean[];
  match?: "exact" | "prefix";
}) {
  return createGatewayPluginRequestHandler({
    registry: createGatewayTestRegistry({
      httpRoutes: [
        {
          pluginId: params.pluginId,
          source: params.pluginId,
          path: params.path,
          auth: "gateway",
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

function withRoutes(
  httpRoutes: PluginHttpRouteRegistration[],
  run: Parameters<typeof withGatewayServer>[0]["run"],
) {
  return withGatewayServer({
    prefix: "plugin-frame-auth-",
    resolvedAuth: AUTH_TOKEN,
    overrides: {
      handlePluginRequest: createGatewayPluginRequestHandler({
        registry: createGatewayTestRegistry({ httpRoutes }),
        log: createSubsystemLogger("test/plugin-frame-auth"),
      }),
      shouldEnforcePluginGatewayAuth: () => true,
    },
    run,
  });
}

describe("control ui plugin frame auth route boundaries", () => {
  test("probes cookie availability inside the sandbox without invoking plugin code", async () => {
    const handler = vi.fn(async () => true);
    const nonce = "0123456789abcdef0123456789abcdef";
    const targetOrigin = "https://gateway.example";
    const path = `/secure-hook?${CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY}=${nonce}&${CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY}=${encodeURIComponent(targetOrigin)}`;
    await withRoutes([route("frame", "/secure-hook", handler)], async (server) => {
      const headers = { cookie: cookie("frame", "/secure-hook") };
      expect((await sendRequest(server, { path })).res.statusCode).toBe(401);
      const authorized = await sendRequest(server, { path, headers });
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
      const invalid = await sendRequest(server, {
        path: `/secure-hook?${CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY}=${nonce}`,
        headers,
      });
      expect(invalid.res.statusCode).toBe(400);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("does not broaden an exact-route grant to child paths", async () => {
    const handler = vi.fn(async () => true);
    await withRoutes([route("frame", "/secure-hook/child", handler)], async (server) => {
      const response = await sendRequest(server, {
        path: "/secure-hook/child",
        headers: { cookie: cookie("frame", "/secure-hook") },
      });
      expect(response.res.statusCode).toBe(401);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("rejects encoded path traversal outside the signed route root", async () => {
    const outer = vi.fn(async () => true);
    const admin = vi.fn(async () => true);
    await withRoutes(
      [route("frame", "/admin", admin), route("frame", "/plugins/same", outer, "prefix")],
      async (server) => {
        const response = await sendRequest(server, {
          path: "/plugins/same/%252e%252e/%252e%252e/admin",
          headers: { cookie: cookie("frame", "/plugins/same", "prefix", ["operator.admin"]) },
        });
        expect(response.res.statusCode).toBe(401);
      },
    );
    expect(outer).not.toHaveBeenCalled();
    expect(admin).not.toHaveBeenCalled();
  });

  test("rejects mutation requests that present only a control ui plugin auth cookie", async () => {
    const handler = vi.fn(async () => true);
    await withRoutes([route("frame", "/secure-hook", handler, "prefix")], async (server) => {
      const response = await sendRequest(server, {
        path: "/secure-hook/action",
        method: "POST",
        headers: { cookie: cookie("frame", "/secure-hook", "prefix") },
      });
      expect(response.res.statusCode).toBe(401);
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("does not accept a control ui plugin auth cookie for websocket upgrade auth", async () => {
    await withRoutes([], async () => {
      const result = await checkGatewayHttpRequestAuth({
        req: createRequest({
          path: "/secure-hook",
          headers: {
            connection: "Upgrade",
            cookie: cookie("frame", "/secure-hook"),
            upgrade: "websocket",
          },
        }),
        auth: AUTH_TOKEN,
        cfg: getRuntimeConfig(),
      });
      expect(result.ok).toBe(false);
    });
  });

  test("keeps trusted-operator routes constrained to control ui plugin auth cookie scopes", async () => {
    const scopes: string[][] = [];
    const adminAllowed: boolean[] = [];
    await withRoutes(
      [
        {
          ...route("frame", "/secure-hook", async (_req, res) => {
            const observed = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
            scopes.push([...observed]);
            adminAllowed.push(authorizeOperatorScopesForMethod("set-heartbeats", observed).allowed);
            res.end("ok");
            return true;
          }),
          gatewayRuntimeScopeSurface: "trusted-operator",
        },
      ],
      async (server) => {
        const response = await sendRequest(server, {
          path: "/secure-hook",
          headers: {
            cookie: cookie("frame", "/secure-hook", "exact", ["operator.read", "operator.write"]),
          },
        });
        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("ok");
      },
    );
    expect(scopes).toEqual([["operator.read", "operator.write"]]);
    expect(adminAllowed).toEqual([false]);
  });

  test("rejects a broader plugin grant when a nested gateway route belongs to another plugin", async () => {
    const outer = vi.fn(async () => true);
    const nested = vi.fn(async () => true);
    await withRoutes(
      [
        route("outer", "/plugins/outer", outer, "prefix"),
        route("nested", "/plugins/outer/nested", nested),
      ],
      async (server) => {
        const response = await sendRequest(server, {
          path: "/plugins/outer/nested",
          headers: { cookie: cookie("outer", "/plugins/outer", "prefix", ["operator.write"]) },
        });
        expect(response.res.statusCode).toBe(401);
      },
    );
    expect(outer).not.toHaveBeenCalled();
    expect(nested).not.toHaveBeenCalled();
  });

  test("selects the grant owned by the first dispatched gateway route", async () => {
    const scopes: string[][] = [];
    const exact = vi.fn<PluginHttpRouteRegistration["handler"]>(async (_req, res) => {
      scopes.push([...(getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [])]);
      res.end("ok");
      return true;
    });
    const nested = vi.fn(async () => true);
    const outer = vi.fn(async () => true);
    await withRoutes(
      [
        route("outer", "/plugins/outer/nested/action", exact),
        route("nested", "/plugins/outer/nested", nested, "prefix"),
        route("outer", "/plugins/outer", outer, "prefix"),
      ],
      async (server) => {
        const response = await sendRequest(server, {
          path: "/plugins/outer/nested/action",
          headers: {
            cookie: `${cookie("outer", "/plugins/outer", "prefix", ["operator.write"])}; ${cookie("nested", "/plugins/outer/nested", "prefix")}`,
          },
        });
        expect(response.res.statusCode).toBe(200);
        expect(response.getBody()).toBe("ok");
      },
    );
    expect(scopes).toEqual([["operator.write"]]);
    expect(exact).toHaveBeenCalledOnce();
    expect(nested).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });

  test("does not fall through from a granted route into another plugin's gateway route", async () => {
    const nested = vi.fn(async () => false);
    const outer = vi.fn(async () => true);
    await withRoutes(
      [
        route("nested", "/plugins/outer/nested", nested),
        route("outer", "/plugins/outer", outer, "prefix"),
      ],
      async (server) => {
        const response = await sendRequest(server, {
          path: "/plugins/outer/nested",
          headers: { cookie: cookie("nested", "/plugins/outer/nested") },
        });
        expect(response.res.statusCode).toBe(404);
      },
    );
    expect(nested).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  test("rejects cookie auth from a cross-site Origin (#116241)", async () => {
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "csrf-origin-cookie",
      path: "/csrf-hook",
      method: "assistant.media.get",
      observedRuntimeScopes: [],
      allowedResults: [],
    });
    await withGatewayServer({
      prefix: "openclaw-plugin-cookie-csrf-origin-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        // Cross-site Origin → cookie must NOT authorize even with a valid cookie.
        const cookieHeader = cookie("csrf-origin-cookie", "/csrf-hook");
        const blocked = await sendRequest(server, {
          path: "/csrf-hook",
          headers: { cookie: cookieHeader, origin: "https://attacker.example.test" },
        });
        expect(blocked.res.statusCode).toBe(401);
      },
    });
  });

  test("allows cookie auth from null Origin (sandbox opaque iframe) regardless of Fetch Metadata", async () => {
    const handlePluginRequest = createRuntimeScopeRecorderHandler({
      pluginId: "sandbox-origin-cookie",
      path: "/sandbox-hook",
      method: "assistant.media.get",
      observedRuntimeScopes: [],
      allowedResults: [],
    });
    await withGatewayServer({
      prefix: "openclaw-plugin-cookie-sandbox-origin-test-",
      resolvedAuth: AUTH_TOKEN,
      overrides: {
        handlePluginRequest,
        shouldEnforcePluginGatewayAuth: () => true,
      },
      run: async (server) => {
        const cookieHeader = cookie("sandbox-origin-cookie", "/sandbox-hook");
        // Null Origin + same-origin → sandbox iframe, allowed.
        const sameOrigin = await sendRequest(server, {
          path: "/sandbox-hook",
          headers: { cookie: cookieHeader, origin: "null", "sec-fetch-site": "same-origin" },
        });
        expect(sameOrigin.res.statusCode).toBe(200);

        // Null Origin + cross-site → sandbox iframe default mode, also allowed
        // (opaque origin is cross-site by spec; blocking it breaks the tab).
        const crossSite = await sendRequest(server, {
          path: "/sandbox-hook",
          headers: { cookie: cookieHeader, origin: "null", "sec-fetch-site": "cross-site" },
        });
        expect(crossSite.res.statusCode).toBe(200);

        // Null Origin + no Fetch Metadata → allowed.
        const noFetch = await sendRequest(server, {
          path: "/sandbox-hook",
          headers: { cookie: cookieHeader, origin: "null" },
        });
        expect(noFetch.res.statusCode).toBe(200);
      },
    });
  });

  test("allows cookie auth without Origin header (non-browser client)", async () => {
    const handler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.end("ok");
      return true;
    });
    await withRoutes([route("no-origin-cookie", "/no-origin-hook", handler)], async (server) => {
      const response = await sendRequest(server, {
        path: "/no-origin-hook",
        headers: { cookie: cookie("no-origin-cookie", "/no-origin-hook") },
      });
      expect(response.res.statusCode).toBe(200);
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});
