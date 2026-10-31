import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginHttpRouteRegistration } from "../plugins/registry.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { canonicalizePathVariant } from "./security-path.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  buildChannelPathFuzzCorpus,
  createHooksHandler,
  createTestGatewayServer,
  expectUnauthorizedResponse,
  expectUnauthorizedVariants,
  sendRequest,
} from "./server-http.test-harness.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  isPluginAuthenticatedRoutePath,
  shouldEnforceGatewayAuthForPluginPath,
} from "./server/plugins-http.js";
import { withTempConfig } from "./test-temp-config.js";

type ServerOptions = Parameters<typeof createTestGatewayServer>[0];
type RequestOptions = Parameters<typeof sendRequest>[1];
type Request = (
  path: string,
  options?: Omit<RequestOptions, "path">,
) => ReturnType<typeof sendRequest>;
const log = createSubsystemLogger("test/plugin-http-auth");
const requestFor =
  (server: Parameters<typeof sendRequest>[0]): Request =>
  (path, options) =>
    sendRequest(server, { path, ...options });
function withServer(
  run: (request: Request, server: Parameters<typeof sendRequest>[0]) => Promise<void>,
  overrides: ServerOptions["overrides"] = {},
  resolvedAuth = AUTH_TOKEN,
  cfg: Parameters<typeof withTempConfig>[0]["cfg"] = { gateway: { trustedProxies: [] } },
) {
  return withTempConfig({
    prefix: "plugin-http-auth-",
    cfg,
    run: async () => {
      const server = createTestGatewayServer({ resolvedAuth, overrides });
      await run(requestFor(server), server);
    },
  });
}
function pluginRoutes(
  routes: [string, PluginHttpRouteRegistration["handler"], Partial<PluginHttpRouteRegistration>][],
) {
  const httpRoutes = routes.map(([path, handler, options]) => ({
    pluginId: path,
    path,
    handler,
    match: "exact" as const,
    auth: "plugin" as const,
    ...options,
  }));
  const registry = createGatewayTestRegistry({ httpRoutes });
  return { registry, handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }) };
}
function respond(res: ServerResponse, body: string) {
  res.statusCode = 200;
  res.end(body);
  return true;
}
function expectResponse(
  response: Awaited<ReturnType<typeof sendRequest>>,
  status: number,
  body: string,
) {
  expect(response.res.statusCode).toBe(status);
  expect(response.getBody()).toBe(body);
}
function claimingPlugin(paths?: string[]) {
  return vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    return !paths || paths.includes(pathname) ? respond(res, "plugin-owned") : false;
  });
}
const callbackPath = "/api/channels/mattermost/command";
const profilePath = "/api/channels/nostr/default/profile";

describe("gateway plugin HTTP auth boundary", () => {
  beforeAll(async () => {
    await import("./control-ui.js");
  });

  test.each([
    ["preview", true, "GET", 200, 'content="OpenClaw dashboard"'],
    ["preview", false, "GET", 404, "Not Found"],
    ["approval", true, "GET", 503, "Control UI assets not found"],
    ["approval", true, "POST", 404, "Not Found"],
    ["approval", false, "GET", 404, "Not Found"],
  ] as const)(
    "reserves %s routes ahead of plugins (UI: %s, method: %s)",
    async (surface, controlUiEnabled, method, status, body) => {
      const plugin = claimingPlugin();
      const preview = surface === "preview";
      await withServer(
        async (request) => {
          const response = await request(
            preview ? "/control/share/dashboard/example/session" : "/approve/plugin%3Arequest.json",
            preview ? { host: "gateway.example.test" } : { method },
          );
          expect(response.res.statusCode).toBe(status);
          expect(response.getBody()).toContain(body);
          if (preview) {
            for (const path of ["/control/share", "/control/share/api/private"]) {
              expect((await request(path)).res.statusCode).toBe(404);
            }
          }
          expect(plugin).not.toHaveBeenCalled();
        },
        {
          controlUiEnabled,
          controlUiBasePath: preview ? "/control" : "",
          ...(preview ? {} : { controlUiRoot: { kind: "missing" as const } }),
          handlePluginRequest: plugin,
        },
        preview ? AUTH_TOKEN : AUTH_NONE,
      );
    },
  );

  test.each(["write-default", "trusted-operator"] as const)(
    "preserves %s runtime authority for shared-secret bearer auth",
    async (surface) => {
      const trusted = surface === "trusted-operator";
      const scopes: string[][] = [];
      const allowed: boolean[] = [];
      const { handlePluginRequest } = pluginRoutes([
        [
          "/secure-hook",
          async (_req, res) => {
            const observed = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
            scopes.push([...observed]);
            allowed.push(
              authorizeOperatorScopesForMethod(trusted ? "set-heartbeats" : "node.invoke", observed)
                .allowed,
            );
            return respond(res, "ok");
          },
          { pluginId: "runtime-scope", auth: "gateway", gatewayRuntimeScopeSurface: surface },
        ],
      ]);
      await withServer(
        async (request) => {
          const response = await request("/secure-hook", {
            authorization: "Bearer test-token",
            headers: trusted ? {} : { "x-openclaw-scopes": "operator.read" },
          });
          expectResponse(response, 200, "ok");
        },
        { handlePluginRequest, shouldEnforcePluginGatewayAuth: () => true },
      );
      expect(scopes).toEqual([
        trusted
          ? expect.arrayContaining(["operator.admin", "operator.read", "operator.write"])
          : ["operator.write"],
      ]);
      expect(allowed).toEqual([true]);
    },
  );

  test.each([callbackPath, profilePath])(
    "limits Mattermost auth bypass to its own channel (%s)",
    async (path) => {
      const plugin = claimingPlugin(
        path === callbackPath ? [callbackPath, profilePath] : [profilePath],
      );
      await withServer(
        async (request) => {
          if (path === callbackPath) {
            expectResponse(await request(callbackPath, { method: "POST" }), 200, "plugin-owned");
            expectUnauthorizedResponse(await request(profilePath));
          } else {
            expectUnauthorizedResponse(await request(profilePath, { method: "POST" }));
            expect(plugin).not.toHaveBeenCalled();
          }
        },
        { handlePluginRequest: plugin },
        AUTH_TOKEN,
        {
          gateway: { trustedProxies: [] },
          channels: { mattermost: { commands: { callbackPath: path } } },
        },
      );
    },
  );

  test("routes unattributable proxy traffic only to plugin-authenticated webhooks", async () => {
    const ips: Array<string | undefined> = [];
    const { registry, handlePluginRequest } = pluginRoutes([
      [
        "/googlechat",
        async (_req, res) => {
          ips.push(getPluginRuntimeGatewayRequestScope()?.client?.clientIp);
          return respond(res, "ok");
        },
        { pluginId: "googlechat" },
      ],
      [
        "/plugins/diffs",
        async (_req, res) => respond(res, "plugin-prefix"),
        { pluginId: "diffs", match: "prefix" },
      ],
    ]);
    const hooks = vi.fn(async (req: IncomingMessage, res: ServerResponse) =>
      req.url?.startsWith("/plugins/diffs") ? respond(res, "hooks") : false,
    );
    await withServer(
      async (request) => {
        const proxy = (path: string, method = "GET") =>
          request(path, {
            method,
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "198.51.100.20" },
          });
        expect((await proxy("/googlechat", "POST")).res.statusCode).toBe(200);
        expect(ips).toEqual(["127.0.0.1"]);
        expectResponse(await proxy("/plugins/diffs/view"), 200, "plugin-prefix");
        expect(hooks).not.toHaveBeenCalled();
        const gateway = await proxy("/ready");
        expect(gateway.res.statusCode).toBe(403);
        expect(gateway.getBody()).toContain("proxy_attribution_required");
      },
      {
        handlePluginRequest,
        handleHooksRequest: hooks,
        shouldEnforcePluginGatewayAuth: (path) =>
          shouldEnforceGatewayAuthForPluginPath(registry, path),
        isPluginAuthenticatedRoute: (path) => isPluginAuthenticatedRoutePath(registry, path),
      },
    );
  });

  test("protects canonical and encoded channel paths while leaving wildcard routes ungated", async () => {
    const plugin = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (canonicalizePathVariant(path) === profilePath) {
        return respond(res, "channel");
      }
      return path === "/googlechat" ? respond(res, "wildcard") : false;
    });
    await withServer(
      async (request) => {
        for (const path of [
          "/googlechat",
          profilePath,
          "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
        ]) {
          const isPublic = path === "/googlechat";
          const unauthenticated = await request(path);
          if (isPublic) {
            expectResponse(unauthenticated, 200, "wildcard");
          } else {
            expectUnauthorizedResponse(unauthenticated);
          }
          const authenticated = await request(path, { authorization: "Bearer test-token" });
          expectResponse(authenticated, 200, isPublic ? "wildcard" : "channel");
        }
      },
      { handlePluginRequest: plugin },
    );
  });

  test("enforces auth before plugin handlers on encoded protected-path variants", async () => {
    const plugin = claimingPlugin();
    await withServer(
      async (_request, server) => {
        await expectUnauthorizedVariants({
          server,
          variants: buildChannelPathFuzzCorpus().filter((variant) => variant.path.includes("%")),
        });
        expect(plugin).not.toHaveBeenCalled();
      },
      { handlePluginRequest: plugin },
    );
  });

  test("rejects query-token hooks requests with bindHost=::", async () => {
    await withServer(
      async (request) => {
        const response = await request("/hooks/wake?token=bad");
        expect(response.res.statusCode).toBe(400);
        expect(response.getBody()).toContain("Hook token must be provided");
      },
      { handleHooksRequest: createHooksHandler("::") },
      AUTH_NONE,
    );
  });
});
