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

type RouteSpec = [pluginId: string, path: string, match?: "exact" | "prefix"];
type RouteHandler = PluginHttpRouteRegistration["handler"];
type DeniedCase = [string, RouteSpec[], string, Parameters<typeof cookie>, string?];
const HOOK = "/secure-hook",
  CHILD = `${HOOK}/child`;
const OUTER = "/plugins/outer",
  NESTED = `${OUTER}/nested`;
const unusedHandler = () => vi.fn(async () => true);

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
  handler: RouteHandler,
  match: "exact" | "prefix" = "exact",
): PluginHttpRouteRegistration {
  return { pluginId, path, auth: "gateway", match, handler };
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
    const handler = unusedHandler();
    const nonce = "0123456789abcdef0123456789abcdef";
    const targetOrigin = "https://gateway.example";
    const path = `/secure-hook?${CONTROL_UI_PLUGIN_AUTH_PROBE_QUERY}=${nonce}&${CONTROL_UI_PLUGIN_AUTH_PROBE_ORIGIN_QUERY}=${encodeURIComponent(targetOrigin)}`;
    await withRoutes([route("frame", HOOK, handler)], async (server) => {
      const headers = { cookie: cookie("frame", HOOK) };
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

  test.each<DeniedCase>([
    ["rejects exact grants on child paths", [["frame", CHILD]], CHILD, ["frame", HOOK]],
    [
      "rejects encoded traversal",
      [
        ["frame", "/admin"],
        ["frame", "/plugins/same", "prefix"],
      ],
      "/plugins/same/%252e%252e/%252e%252e/admin",
      ["frame", "/plugins/same", "prefix", ["operator.admin"]],
    ],
    [
      "rejects cookie-only mutations",
      [["frame", HOOK, "prefix"]],
      `${HOOK}/action`,
      ["frame", HOOK, "prefix"],
      "POST",
    ],
    [
      "rejects another plugin's nested route",
      [
        ["outer", OUTER, "prefix"],
        ["nested", NESTED],
      ],
      NESTED,
      ["outer", OUTER, "prefix", ["operator.write"]],
    ],
  ])("%s", async (_name, specs, path, grant, method) => {
    const routes = specs.map(([id, root, match]) => route(id, root, unusedHandler(), match));
    await withRoutes(routes, async (server) => {
      const response = await sendRequest(server, {
        path,
        method,
        headers: { cookie: cookie(...grant) },
      });
      expect(response.res.statusCode).toBe(401);
    });
    for (const { handler } of routes) {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  test("does not accept a control ui plugin auth cookie for websocket upgrade auth", async () => {
    await withRoutes([], async () => {
      const result = await checkGatewayHttpRequestAuth({
        req: createRequest({
          path: HOOK,
          headers: {
            connection: "Upgrade",
            cookie: cookie("frame", HOOK),
            upgrade: "websocket",
          },
        }),
        auth: AUTH_TOKEN,
        cfg: getRuntimeConfig(),
      });
      expect(result.ok).toBe(false);
    });
  });

  test.each<[name: string, dispatch: boolean, scopes: OperatorScope[]]>([
    ["trusted-operator scope restriction", false, ["operator.read", "operator.write"]],
    ["first-dispatched-route grant selection", true, ["operator.write"]],
  ])("preserves %s", async (_name, dispatch, expectedScopes) => {
    const scopes: string[][] = [];
    const adminAllowed: boolean[] = [];
    const handler = vi.fn<PluginHttpRouteRegistration["handler"]>(async (_req, res) => {
      const observed = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
      scopes.push([...observed]);
      adminAllowed.push(authorizeOperatorScopesForMethod("set-heartbeats", observed).allowed);
      res.end("ok");
      return true;
    });
    const nested = unusedHandler();
    const outer = unusedHandler();
    const path = dispatch ? `${NESTED}/action` : HOOK;
    const routes = dispatch
      ? [
          route("outer", path, handler),
          route("nested", NESTED, nested, "prefix"),
          route("outer", OUTER, outer, "prefix"),
        ]
      : [
          {
            ...route("frame", path, handler),
            gatewayRuntimeScopeSurface: "trusted-operator" as const,
          },
        ];
    await withRoutes(routes, async (server) => {
      const grant = dispatch
        ? `${cookie("outer", OUTER, "prefix", expectedScopes)}; ${cookie("nested", NESTED, "prefix")}`
        : cookie("frame", path, "exact", expectedScopes);
      const response = await sendRequest(server, { path, headers: { cookie: grant } });
      expect(response.res.statusCode).toBe(200);
      expect(response.getBody()).toBe("ok");
    });
    expect(scopes).toEqual([expectedScopes]);
    expect(adminAllowed).toEqual([false]);
    expect(handler).toHaveBeenCalledOnce();
    expect(nested).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });

  test("does not fall through from a granted route into another plugin's gateway route", async () => {
    const nested = vi.fn(async () => false);
    const outer = vi.fn(async () => true);
    await withRoutes(
      [route("nested", NESTED, nested), route("outer", OUTER, outer, "prefix")],
      async (server) => {
        const response = await sendRequest(server, {
          path: NESTED,
          headers: { cookie: cookie("nested", NESTED) },
        });
        expect(response.res.statusCode).toBe(404);
      },
    );
    expect(nested).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });
});
