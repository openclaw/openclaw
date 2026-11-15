import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveGatewayAuth } from "./auth.js";
import { authorizeOperatorScopesForMethod, CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "./server-constants.js";
import { attachGatewayUpgradeHandler } from "./server-http-upgrades.js";
import {
  createRequest,
  createResponse,
  createTestGatewayServer,
  dispatchRequest,
  sendRequest,
} from "./server-http.test-harness.js";
import { createGatewayTestRegistry } from "./server/__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  createGatewayPluginUpgradeHandler,
  shouldEnforceGatewayAuthForPluginPath,
} from "./server/plugins-http.js";
import { createPreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import { withTempConfig } from "./test-temp-config.js";

const routePath = "/role-scoped-plugin";
const proxyAddress = "203.0.113.10";
const email = "plugin-role@example.test";
const proxyAuth = {
  mode: "trusted-proxy",
  allowTailscale: false,
  trustedProxy: { userHeader: "x-forwarded-user" },
} as const;
type Scope = GatewayOperatorRoleDefinition["scopes"];
const read: Scope = ["operator.read"];
const write: Scope = ["operator.write"];
const roleCases: Array<["write-default" | "trusted-operator", string, Scope, Scope, Scope]> = [
  ["write-default", "empty", [], [], []],
  ["trusted-operator", "empty", [], [], []],
  ["trusted-operator", "reader", read, read, read],
  ["write-default", "reader", read, read, read],
  ["write-default", "writer", write, write, read],
  ["trusted-operator", "writer", write, [...read, ...write], read],
  ["write-default", "admin", ["operator.admin"], write, read],
  ["trusted-operator", "admin", ["operator.admin"], [...CLI_DEFAULT_OPERATOR_SCOPES], read],
];
const roleDefinition = (scopes: Scope): GatewayOperatorRoleDefinition => ({
  sessions: { others: "view" },
  agents: "*",
  scopes,
});
const route = {
  pluginId: "role-scoped-plugin",
  path: routePath,
  auth: "gateway",
  match: "exact",
} as const;
const pluginRequest = (headers = {}) => ({
  path: routePath,
  remoteAddress: proxyAddress,
  headers: { "x-forwarded-user": email, "x-forwarded-for": "198.51.100.20", ...headers },
});

const roleConfig = (
  defaultRole: string,
  definitions: Record<string, GatewayOperatorRoleDefinition>,
): OpenClawConfig => ({
  gateway: {
    trustedProxies: [proxyAddress],
    auth: proxyAuth,
    roles: { default: defaultRole, definitions },
  },
});

function withRoleConfig(
  cfg: OpenClawConfig,
  run: (profile: ReturnType<typeof ensureProfileForEmail>, cfg: OpenClawConfig) => Promise<void>,
) {
  return withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail(email);
    try {
      await withTempConfig({ cfg, run: () => run(profile, cfg) });
    } finally {
      invalidateOperatorRolePolicy(profile.id);
    }
  });
}

type Route = ReturnType<typeof createGatewayTestRegistry>["httpRoutes"][number];
function pluginServer(
  registration: Omit<Route, keyof typeof route | "source">,
  overrides: Parameters<typeof createTestGatewayServer>[0]["overrides"] = {},
  wss?: WebSocketServer,
) {
  const registry = createGatewayTestRegistry({
    httpRoutes: [{ ...route, source: "fixture", ...registration }],
  });
  const log = createSubsystemLogger("test/plugin-role-scopes");
  const shouldEnforcePluginGatewayAuth = shouldEnforceGatewayAuthForPluginPath.bind(null, registry);
  const server = createTestGatewayServer({
    resolvedAuth: proxyAuth,
    overrides: {
      handlePluginRequest: createGatewayPluginRequestHandler({ registry, log }),
      shouldEnforcePluginGatewayAuth,
      ...overrides,
    },
  });
  if (wss) {
    attachGatewayUpgradeHandler({
      httpServer: server,
      wss,
      handlePluginUpgrade: createGatewayPluginUpgradeHandler({ registry, log }),
      shouldEnforcePluginGatewayAuth,
      clients: new Set(),
      preauthConnectionBudget: createPreauthConnectionBudget(),
      resolvedAuth: proxyAuth,
    });
  }
  return server;
}

function observeRuntimeScope() {
  const client = getPluginRuntimeGatewayRequestScope()?.client;
  const scopes = client?.connect?.scopes;
  return {
    scopes,
    profileId: client?.authenticatedUserProfile?.profileId,
    readAllowed: authorizeOperatorScopesForMethod("status", scopes ?? []).allowed,
    writeAllowed: authorizeOperatorScopesForMethod("node.invoke", scopes ?? []).allowed,
    adminAllowed: authorizeOperatorScopesForMethod("config.set", scopes ?? []).allowed,
  };
}

async function dispatchPluginUpgrade(
  server: ReturnType<typeof createTestGatewayServer>,
  req: IncomingMessage,
): Promise<string> {
  const socket = new PassThrough();
  let body = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    body += chunk;
  });
  const closed = once(socket, "close");
  try {
    server.emit("upgrade", req, socket, Buffer.alloc(0));
    await closed;
    return body;
  } finally {
    socket.destroy();
  }
}

it.each(roleCases)(
  "caps %s HTTP and upgrade clients for %s",
  async (surface, role, scopes, defaultScopes, declaredRead) =>
    withRoleConfig(
      roleConfig("denied", {
        denied: { sessions: { others: "none" }, agents: [], scopes: [] },
        [role]: roleDefinition(scopes),
      }),
      async (profile) => {
        setUserProfileRole(profile.id, role);
        const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PREAUTH_PAYLOAD_BYTES });
        try {
          const server = pluginServer(
            {
              gatewayRuntimeScopeSurface: surface,
              handler: async (_req, res) => {
                res.end(JSON.stringify(observeRuntimeScope()));
                return true;
              },
              handleUpgrade: async (_req, socket) => {
                socket.end(JSON.stringify(observeRuntimeScope()));
                return true;
              },
            },
            {},
            wss,
          );
          for (const [header, expectedScopes] of [
            [undefined, defaultScopes],
            ["operator.read", declaredRead],
            ["", []],
          ] as const) {
            const request = pluginRequest(
              header === undefined ? {} : { "x-openclaw-scopes": header },
            );
            const expected = {
              scopes: expectedScopes,
              profileId: profile.id,
              readAllowed: expectedScopes.some((scope) =>
                [...read, ...write, "operator.admin"].includes(scope),
              ),
              adminAllowed: expectedScopes.some((scope) => scope === "operator.admin"),
              writeAllowed: expectedScopes.some(
                (scope) => scope === "operator.write" || scope === "operator.admin",
              ),
            };
            const response = await sendRequest(server, request);
            expect(response.res.statusCode).toBe(200);
            expect.soft(JSON.parse(response.getBody()), `HTTP header=${header}`).toEqual(expected);
            const upgraded = await dispatchPluginUpgrade(
              server,
              createRequest({
                ...request,
                headers: { ...request.headers, connection: "upgrade", upgrade: "websocket" },
              }),
            );
            expect.soft(JSON.parse(upgraded), `upgrade header=${header}`).toEqual(expected);
          }
        } finally {
          wss.close();
        }
      },
    ),
);

it("retires prepared plugin effects when role or proxy policy changes", async () =>
  withRoleConfig(
    roleConfig("writer", {
      writer: roleDefinition(write),
      reader: roleDefinition(read),
    }),
    async (profile, initial) => {
      let current = initial;
      let prepared = createDeferred();
      let resume = createDeferred();
      let effects = 0;
      const server = pluginServer(
        {
          gatewayRuntimeScopeSurface: "trusted-operator",
          handler: async (_req, res) => {
            const scope = getPluginRuntimeGatewayRequestScope();
            prepared.resolve();
            await resume.promise;
            await scope?.revalidate?.();
            const allowed = observeRuntimeScope().writeAllowed;
            if (allowed) {
              effects += 1;
            }
            res.statusCode = allowed ? 200 : 403;
            res.end();
            return true;
          },
        },
        {
          getRuntimeConfig: () => current,
          getResolvedAuth: () => resolveGatewayAuth({ authConfig: current.gateway?.auth }),
          shouldEnforcePluginGatewayAuth: (path) => path.pathname === routePath,
        },
      );
      const request = { ...pluginRequest(), method: "POST" };
      for (const change of [
        "unrelated",
        "role-definition",
        "role-assignment",
        "proxy-trust",
      ] as const) {
        current = structuredClone(initial);
        setUserProfileRole(profile.id, null);
        invalidateOperatorRolePolicy(profile.id);
        setRuntimeConfigSnapshot(current, current);
        prepared = createDeferred();
        resume = createDeferred();
        const response = createResponse();
        const dispatch = dispatchRequest(server, createRequest(request), response.res);
        await prepared.promise;
        const before = effects;
        if (change === "role-assignment") {
          setUserProfileRole(profile.id, "reader");
          invalidateOperatorRolePolicy(profile.id);
        } else {
          current = structuredClone(current);
          if (change === "unrelated") {
            current.logging = { level: "debug" };
          } else if (change === "role-definition") {
            current.gateway!.roles!.default = "reader";
          } else {
            current.gateway!.trustedProxies = [];
          }
          setRuntimeConfigSnapshot(current, current);
        }
        resume.resolve();
        await dispatch;
        const settled = [response.res.statusCode, effects - before];
        expect([...settled, (await sendRequest(server, request)).res.statusCode], change).toEqual(
          change === "unrelated" ? [200, 1, 200] : [401, 0, 403],
        );
      }
    },
  ));
