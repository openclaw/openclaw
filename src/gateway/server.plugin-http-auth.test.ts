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
  withGatewayServer,
  withGatewayTempConfig,
} from "./server-http.test-harness.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  isPluginAuthenticatedRoutePath,
  shouldEnforceGatewayAuthForPluginPath,
} from "./server/plugins-http.js";
import { withTempConfig } from "./test-temp-config.js";

type ServerOptions = Parameters<typeof withGatewayServer>[0];
const log = createSubsystemLogger("test/plugin-http-auth");
function withServer(
  run: ServerOptions["run"],
  overrides: ServerOptions["overrides"] = {},
  resolvedAuth = AUTH_NONE,
) {
  return withGatewayServer({ prefix: "plugin-http-auth-", resolvedAuth, overrides, run });
}
function pluginRoutes(httpRoutes: PluginHttpRouteRegistration[]) {
  const registry = createGatewayTestRegistry({ httpRoutes });
  return { registry, handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }) };
}
function respond(res: ServerResponse, body: string) {
  res.statusCode = 200;
  res.end(body);
  return true;
}
function claimingPlugin(paths?: string[]) {
  return vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    return !paths || paths.includes(pathname) ? respond(res, "plugin-owned") : false;
  });
}
function withMattermost(callbackPath: string, run: ServerOptions["run"]) {
  return withTempConfig({
    cfg: {
      gateway: { trustedProxies: [] },
      channels: { mattermost: { commands: { callbackPath } } },
    },
    run: async () =>
      run(
        createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: {
            handlePluginRequest: claimingPlugin([
              "/api/channels/mattermost/command",
              "/api/channels/nostr/default/profile",
            ]),
          },
        }),
      ),
  });
}

describe("gateway plugin HTTP auth boundary", () => {
  beforeAll(async () => {
    // Compile the real Control UI owner before request deadlines begin.
    await import("./control-ui.js");
  });

  test.each([true, false])(
    "reserves public preview routes ahead of plugins (UI enabled: %s)",
    async (controlUiEnabled) => {
      const plugin = claimingPlugin();
      await withServer(
        async (server) => {
          const response = await sendRequest(server, {
            path: "/control/share/dashboard/example/session",
            host: "gateway.example.test",
          });
          expect(response.res.statusCode).toBe(controlUiEnabled ? 200 : 404);
          expect(response.getBody()).toContain(
            controlUiEnabled ? 'content="OpenClaw dashboard"' : "Not Found",
          );
          for (const path of ["/control/share", "/control/share/api/private"]) {
            expect((await sendRequest(server, { path })).res.statusCode).toBe(404);
          }
          expect(plugin).not.toHaveBeenCalled();
        },
        { controlUiEnabled, controlUiBasePath: "/control", handlePluginRequest: plugin },
        AUTH_TOKEN,
      );
    },
  );

  test.each([
    {
      surface: "write-default",
      header: "operator.read",
      expected: ["operator.write"],
      method: "node.invoke",
    },
    {
      surface: "trusted-operator",
      header: undefined,
      expected: ["operator.admin", "operator.read", "operator.write"],
      method: "set-heartbeats",
    },
  ] as const)(
    "preserves $surface runtime authority for shared-secret bearer auth",
    async ({ surface, header, expected, method }) => {
      const scopes: string[][] = [];
      const allowed: boolean[] = [];
      const { handlePluginRequest } = pluginRoutes([
        {
          pluginId: "runtime-scope",
          path: "/secure-hook",
          auth: "gateway",
          match: "exact",
          gatewayRuntimeScopeSurface: surface,
          handler: async (_req, res) => {
            const observed = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
            scopes.push([...observed]);
            allowed.push(authorizeOperatorScopesForMethod(method, observed).allowed);
            return respond(res, "ok");
          },
        },
      ]);
      await withServer(
        async (server) => {
          const response = await sendRequest(server, {
            path: "/secure-hook",
            authorization: "Bearer test-token",
            headers: header === undefined ? {} : { "x-openclaw-scopes": header },
          });
          expect(response.res.statusCode).toBe(200);
          expect(response.getBody()).toBe("ok");
        },
        { handlePluginRequest, shouldEnforcePluginGatewayAuth: () => true },
        AUTH_TOKEN,
      );
      expect(scopes).toEqual([
        surface === "trusted-operator" ? expect.arrayContaining([...expected]) : [...expected],
      ]);
      expect(allowed).toEqual([true]);
    },
  );

  test("allows unauthenticated Mattermost callbacks while protecting other channel routes", async () => {
    await withMattermost("/api/channels/mattermost/command", async (server) => {
      const callback = await sendRequest(server, {
        path: "/api/channels/mattermost/command",
        method: "POST",
      });
      expect(callback.res.statusCode).toBe(200);
      expect(callback.getBody()).toBe("plugin-owned");
      expectUnauthorizedResponse(
        await sendRequest(server, { path: "/api/channels/nostr/default/profile" }),
      );
    });
  });

  test("does not bypass auth when mattermost callbackPath names another channel", async () => {
    const plugin = claimingPlugin(["/api/channels/nostr/default/profile"]);
    await withTempConfig({
      cfg: {
        gateway: { trustedProxies: [] },
        channels: {
          mattermost: { commands: { callbackPath: "/api/channels/nostr/default/profile" } },
        },
      },
      run: async () => {
        const server = createTestGatewayServer({
          resolvedAuth: AUTH_TOKEN,
          overrides: { handlePluginRequest: plugin },
        });
        expectUnauthorizedResponse(
          await sendRequest(server, {
            path: "/api/channels/nostr/default/profile",
            method: "POST",
          }),
        );
        expect(plugin).not.toHaveBeenCalled();
      },
    });
  });

  test("routes unattributable proxy traffic only to plugin-authenticated webhooks", async () => {
    const ips: Array<string | undefined> = [];
    const { registry, handlePluginRequest } = pluginRoutes([
      {
        pluginId: "googlechat",
        path: "/googlechat",
        auth: "plugin",
        match: "exact",
        handler: async (_req, res) => {
          ips.push(getPluginRuntimeGatewayRequestScope()?.client?.clientIp);
          return respond(res, "ok");
        },
      },
      {
        pluginId: "diffs",
        path: "/plugins/diffs",
        auth: "plugin",
        match: "prefix",
        handler: async (_req, res) => respond(res, "plugin-prefix"),
      },
    ]);
    const hooks = vi.fn(async (req: IncomingMessage, res: ServerResponse) =>
      req.url?.startsWith("/plugins/diffs") ? respond(res, "hooks") : false,
    );
    await withServer(
      async (server) => {
        const proxy = (path: string, method = "GET") =>
          sendRequest(server, {
            path,
            method,
            remoteAddress: "127.0.0.1",
            headers: { "x-forwarded-for": "198.51.100.20" },
          });
        expect((await proxy("/googlechat", "POST")).res.statusCode).toBe(200);
        expect(ips).toEqual(["127.0.0.1"]);
        const prefix = await proxy("/plugins/diffs/view");
        expect(prefix.res.statusCode).toBe(200);
        expect(prefix.getBody()).toBe("plugin-prefix");
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
      AUTH_TOKEN,
    );
  });

  test("protects canonical and encoded channel paths while leaving wildcard routes ungated", async () => {
    const plugin = vi.fn(async (req: IncomingMessage, res: ServerResponse) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (canonicalizePathVariant(path) === "/api/channels/nostr/default/profile") {
        return respond(res, "channel");
      }
      return path === "/googlechat" ? respond(res, "wildcard") : false;
    });
    await withServer(
      async (server) => {
        for (const path of [
          "/googlechat",
          "/api/channels/nostr/default/profile",
          "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
        ]) {
          const isPublic = path === "/googlechat";
          const unauthenticated = await sendRequest(server, { path });
          if (isPublic) {
            expect(unauthenticated.res.statusCode).toBe(200);
            expect(unauthenticated.getBody()).toBe("wildcard");
          } else {
            expectUnauthorizedResponse(unauthenticated);
          }
          const authenticated = await sendRequest(server, {
            path,
            authorization: "Bearer test-token",
          });
          expect(authenticated.res.statusCode).toBe(200);
          expect(authenticated.getBody()).toBe(isPublic ? "wildcard" : "channel");
        }
      },
      { handlePluginRequest: plugin },
      AUTH_TOKEN,
    );
  });

  test("enforces auth before plugin handlers on encoded protected-path variants", async () => {
    const plugin = claimingPlugin();
    await withServer(
      async (server) => {
        await expectUnauthorizedVariants({
          server,
          variants: buildChannelPathFuzzCorpus().filter((variant) => variant.path.includes("%")),
        });
        expect(plugin).not.toHaveBeenCalled();
      },
      { handlePluginRequest: plugin },
      AUTH_TOKEN,
    );
  });

  test("rejects query-token hooks requests with bindHost=::", async () => {
    await withGatewayTempConfig("openclaw-plugin-http-hooks-query-token-", async () => {
      const server = createTestGatewayServer({
        resolvedAuth: AUTH_NONE,
        overrides: { handleHooksRequest: createHooksHandler("::") },
      });
      const response = await sendRequest(server, { path: "/hooks/wake?token=bad" });
      expect(response.res.statusCode).toBe(400);
      expect(response.getBody()).toContain("Hook token must be provided");
    });
  });
});
