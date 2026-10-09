import { once } from "node:events";
import { createServer, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  prepareGatewaySuspend,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
} from "../../infra/gateway-suspend-coordinator.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { dispatchGatewayMethod } from "../../plugin-sdk/gateway-method-runtime.js";
import { registerPluginHttpRoute } from "../../plugins/http-registry.js";
import {
  createEmptyPluginRegistry,
  type PluginHttpRouteRegistration,
} from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../../process/gateway-work-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setControlUiPluginAuthCookie } from "../control-ui-plugin-auth-cookie.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import {
  authorizeControlUiPluginCookieRequest,
  resolveControlUiPluginAuthCookieGeneration,
} from "../http-auth-plugin-cookie.js";
import { authorizeOperatorScopesForMethod, CLI_DEFAULT_OPERATOR_SCOPES } from "../method-scopes.js";
import { invalidateOperatorRolePolicy } from "../operator-role-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { isApprovalRecordVisibleToClient } from "../server-methods/approval-shared.js";
import type { GatewayRequestContext } from "../server-methods/types.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { makeMockHttpResponse } from "../test-http-response.js";
import { withTempConfig } from "../test-temp-config.js";
import { createGatewayTestRegistry } from "./__tests__/test-utils.js";
import {
  createGatewayPluginRequestHandler,
  createGatewayPluginUpgradeHandler,
  isPluginAuthenticatedRoutePath,
  findRegisteredPluginHttpRoute,
  shouldEnforceGatewayAuthForPluginPath,
} from "./plugins-http.js";

const SECURE_HOOK_PATH = "/secure-hook";
type PluginRequestHandler = ReturnType<typeof createGatewayPluginRequestHandler>;
type PluginRequestAuthContext = NonNullable<Parameters<PluginRequestHandler>[3]>;
type RuntimeScope = ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
const trusted: PluginRequestAuthContext = {
  gatewayAuthSatisfied: true,
  gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
  gatewayRequestOperatorScopes: ["operator.write"],
};
function createRoute(params: Partial<PluginHttpRouteRegistration>): PluginHttpRouteRegistration {
  return {
    pluginId: "route",
    source: "route",
    path: SECURE_HOOK_PATH,
    auth: "gateway",
    match: "exact",
    handler: () => true,
    ...params,
  };
}
function createMockLogger(): SubsystemLogger {
  const child = vi.fn<(name: string) => SubsystemLogger>();
  const logger = {
    subsystem: "test/plugins-http-runtime-scopes",
    isEnabled: () => true,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child,
  } satisfies SubsystemLogger;
  child.mockImplementation(() => logger);
  return logger;
}
async function dispatchPluginRequest(
  handler: PluginRequestHandler,
  {
    path = SECURE_HOOK_PATH,
    authContext = trusted,
  }: { path?: string; authContext?: PluginRequestAuthContext } = {},
) {
  const response = makeMockHttpResponse();
  const handled = await handler(
    { url: path } as IncomingMessage,
    response.res,
    undefined,
    authContext,
  );
  return { handled, ...response };
}
async function invoke(routes: PluginHttpRouteRegistration[], authContext = trusted) {
  const { log, handler } = setup(routes);
  return { log, ...(await dispatchPluginRequest(handler, { authContext })) };
}

describe("plugin HTTP route runtime scopes", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it.each(["plugin", "gateway"] as const)(
    "denies write helpers for read-only %s routes",
    async (auth) => {
      let scope: RuntimeScope;
      const response = await invoke(
        [
          createRoute({
            auth,
            handler: () => {
              scope = getPluginRuntimeGatewayRequestScope();
              const allowed = authorizeOperatorScopesForMethod(
                "agent",
                scope?.client?.connect.scopes ?? [],
              );
              if (!allowed.allowed) {
                throw new Error(`missing scope: ${allowed.missingScope}`);
              }
              return true;
            },
          }),
        ],
        {
          gatewayAuthSatisfied: auth === "gateway",
          gatewayRequestOperatorScopes: ["operator.read"],
        },
      );
      expect(response.handled).toBe(true);
      expect(response.res.statusCode).toBe(500);
      expect(response.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
      expect(response.end).toHaveBeenCalledWith("Internal Server Error");
      expect(response.log.warn).toHaveBeenCalledWith(
        "plugin http route failed (route): Error: missing scope: operator.write",
      );
      expect(scope?.client?.connect.scopes).toEqual(auth === "plugin" ? [] : ["operator.read"]);
      expect(scope?.hasCurrentClientAuthority).toBeUndefined();
    },
  );

  it.each(["request policy", "visitor grant"] as const)(
    "rechecks %s before the next matched route",
    async (changed) => {
      const entered = createDeferred();
      const release = createDeferred();
      const grant = new AbortController();
      let current = true;
      const next = vi.fn(() => true);
      const first = createRoute({
        handler: async () => {
          expect(getPluginRuntimeGatewayRequestScope()?.signal).toBe(grant.signal);
          entered.resolve();
          await release.promise;
          return false;
        },
      });
      const pending = invoke([first, { ...first, match: "prefix", handler: next }], {
        ...trusted,
        gatewayRequestAuth: {
          trustDeclaredOperatorScopes: true,
          hasCurrentClientAuthority: () => current,
          operatorAccessAuthority: {
            signal: grant.signal,
            assertCurrent: () => grant.signal.throwIfAborted(),
          },
        },
      });
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          pending,
          "request ended before the first route prepared",
        );
        if (changed === "request policy") {
          current = false;
        } else {
          grant.abort();
        }
      } finally {
        release.resolve();
      }
      const response = await pending;
      expect(response.handled).toBe(true);
      expect(response.res.statusCode).toBe(changed === "request policy" ? 401 : 403);
      expect(next).not.toHaveBeenCalled();
    },
  );

  it.each(["gateway", "plugin"] as const)(
    "preserves system authority only on gateway routes (%s)",
    async (auth) => {
      const profile = {
        profileId: "profile-owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      };
      let scope: RuntimeScope;
      const response = await invoke(
        [
          createRoute({
            auth,
            handler: () => {
              scope = getPluginRuntimeGatewayRequestScope();
              return true;
            },
          }),
        ],
        {
          ...trusted,
          gatewayRequestAuth: {
            authMethod: "token",
            trustDeclaredOperatorScopes: false,
            authenticatedUserProfile: profile,
            operatorRoleActor: { kind: "system" },
          },
        },
      );
      expect(response.handled).toBe(true);
      expect(scope?.client?.internal?.operatorRoleActor).toEqual(
        auth === "gateway" ? { kind: "system" } : undefined,
      );
      expect(scope?.client?.authenticatedUserProfile).toEqual(
        auth === "gateway" ? profile : undefined,
      );
    },
  );

  it.each(["HTTP", "WebSocket"] as const)(
    "binds reloaded %s handlers to their server's registry and context",
    async (transport) => {
      const observed: RuntimeScope[] = [];
      const observe = () => {
        observed.push(getPluginRuntimeGatewayRequestScope());
        return true;
      };
      const registry = () =>
        createGatewayTestRegistry({
          httpRoutes: [createRoute({ handler: observe, handleUpgrade: observe })],
        });
      const startupRegistry = registry();
      let currentRegistry = startupRegistry;
      const context = createDirectChatContext();
      setActivePluginRegistry(registry());
      const options = {
        registry: startupRegistry,
        getRouteRegistry: () => currentRegistry,
        log: createMockLogger(),
        getGatewayRequestContext: () => context,
      };
      const request = createGatewayPluginRequestHandler(options);
      const upgrade = createGatewayPluginUpgradeHandler(options);
      const socket = new PassThrough();
      const dispatch = async () =>
        transport === "HTTP"
          ? (await dispatchPluginRequest(request)).handled
          : await upgrade(
              { url: SECURE_HOOK_PATH } as IncomingMessage,
              socket,
              Buffer.alloc(0),
              undefined,
              trusted,
            );
      try {
        expect(await dispatch()).toBe(true);
        currentRegistry = registry();
        expect(await dispatch()).toBe(true);
        expect(observed).toHaveLength(2);
        expect(observed[0]?.pluginRegistry).toBe(startupRegistry);
        expect(observed[1]?.pluginRegistry).toBe(currentRegistry);
        expect(observed.map((scope) => scope?.context)).toEqual([context, context]);
      } finally {
        socket.destroy();
      }
    },
  );

  it("does not give approval-scoped routes global approval visibility", async (testContext) => {
    const manager = createTestApprovalManager<{ command: string }>(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "route-hidden-approval");
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    let scope: RuntimeScope;
    let visible: boolean | undefined;
    const response = await invoke(
      [
        createRoute({
          handler: () => {
            scope = getPluginRuntimeGatewayRequestScope();
            visible = isApprovalRecordVisibleToClient({ record, client: scope?.client ?? null });
            return true;
          },
        }),
      ],
      { gatewayAuthSatisfied: true, gatewayRequestOperatorScopes: ["operator.approvals"] },
    );
    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(scope?.client?.internal?.approvalRuntime).not.toBe(true);
    expect(visible).toBe(false);
  });

  it("scopes privileges per matched route during exact/prefix fallthrough", async () => {
    const scopes: Array<string[] | undefined> = [];
    const response = await invoke([
      createRoute({
        handler: () => {
          scopes.push(getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes);
          return false;
        },
      }),
      createRoute({
        match: "prefix",
        gatewayRuntimeScopeSurface: "trusted-operator",
        handler: () => {
          const current = getPluginRuntimeGatewayRequestScope()?.client?.connect.scopes;
          scopes.push(current);
          const allowed = authorizeOperatorScopesForMethod("set-heartbeats", current ?? []);
          if (!allowed.allowed) {
            throw new Error(`missing scope: ${allowed.missingScope}`);
          }
          return true;
        },
      }),
    ]);
    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(response.log.warn).not.toHaveBeenCalled();
    expect(scopes).toEqual([["operator.write"], CLI_DEFAULT_OPERATOR_SCOPES]);
  });
});

type SessionReadMethod = "sessions.list" | "sessions.describe";

async function withCookieSessionReader(
  roles: boolean,
  run: (fixture: {
    readerId: string;
    ownerEmail: string;
    dispatch: (method: SessionReadMethod, key?: string) => ReturnType<typeof dispatchGatewayMethod>;
    dispatchHttp: (
      method: SessionReadMethod,
      key?: string,
    ) => Promise<{
      statusCode: number;
      result: Awaited<ReturnType<typeof dispatchGatewayMethod>> | undefined;
    }>;
    blockCatalog: () => { entered: Promise<void>; release: () => void };
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const config: OpenClawConfig = {
      agents: { entries: { main: {} } },
      ...(roles
        ? {
            gateway: {
              roles: {
                default: "blocked",
                definitions: {
                  reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
                  blocked: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
                },
              },
            },
          }
        : {}),
    };
    await state.writeConfig(config);
    await withTempConfig({
      cfg: config,
      run: async () => {
        const reader = ensureProfileForEmail("http-reader@example.test");
        const ownerEmail = "http-owner@example.test";
        const owner = ensureProfileForEmail(ownerEmail);
        setUserProfileRole(reader.id, "reader");
        for (const row of [
          { name: "own-draft", ownerId: reader.id, visibility: "draft" as const },
          { name: "foreign-draft", ownerId: owner.id, visibility: "draft" as const },
          { name: "shared", ownerId: owner.id, visibility: "shared" as const },
          {
            name: "dashboard:incognito-http-reader",
            ownerId: owner.id,
            visibility: "shared" as const,
            incognito: true,
          },
        ]) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: `agent:main:${row.name}` },
            {
              sessionId: row.name,
              updatedAt: 1,
              visibility: row.visibility,
              ...(row.incognito ? { incognito: true } : {}),
              createdActor: { type: "human", source: "profile", id: row.ownerId },
            },
          );
        }
        const context = createDirectChatContext({
          getRuntimeConfig: () => config,
          trackExecution: trackAsyncWork,
        });
        let catalogGate: ReturnType<typeof createDeferred<void>> | undefined;
        let catalogEntered: ReturnType<typeof createDeferred<void>> | undefined;
        const projection = await createSessionRowProjection({
          cfg: config,
          context,
          getModelCatalog: async () => {
            catalogEntered?.resolve();
            await catalogGate?.promise;
            return undefined;
          },
        });
        bindSessionRowProjection(context, () => projection);
        const cookieResponse = makeMockHttpResponse();
        const grant = {
          pluginId: "route",
          path: SECURE_HOOK_PATH,
          match: "exact" as const,
          scopes: ["operator.read" as const],
        };
        setControlUiPluginAuthCookie(cookieResponse.res, [grant], {
          generation: resolveControlUiPluginAuthCookieGeneration("http-generation", config),
          profileId: reader.id,
        });
        const value = cookieResponse.setHeader.mock.calls.at(-1)?.[1]?.[0];
        if (typeof value !== "string") {
          throw new Error("expected signed HTTP plugin cookie");
        }
        const cookie = value.split(";", 1)[0]!;
        const dispatchHttp = async (method: SessionReadMethod, key = "agent:main:shared") => {
          let result: Awaited<ReturnType<typeof dispatchGatewayMethod>> | undefined;
          const handler = setup(
            [
              createRoute({
                gatewayMethodDispatchAllowed: true,
                handler: async () => {
                  result = await dispatchGatewayMethod(
                    method,
                    method === "sessions.list" ? {} : { key },
                  );
                  return true;
                },
              }),
            ],
            { getGatewayRequestContext: () => context },
          ).handler;
          const req = {
            method: "GET",
            url: SECURE_HOOK_PATH,
            headers: { cookie },
          } as IncomingMessage;
          const authorized = authorizeControlUiPluginCookieRequest(req, {
            requestPath: SECURE_HOOK_PATH,
            authGeneration: "http-generation",
          });
          expect(authorized).not.toBeNull();
          const response = makeMockHttpResponse();
          expect(
            await handler(req, response.res, undefined, {
              gatewayAuthSatisfied: true,
              gatewayRequestAuth: authorized!.requestAuth,
              gatewayRequestOperatorScopes: authorized!.operatorScopes,
            }),
          ).toBe(true);
          return { statusCode: response.res.statusCode, result };
        };
        const dispatch = async (method: SessionReadMethod, key?: string) => {
          const { statusCode, result } = await dispatchHttp(method, key);
          expect(statusCode).toBe(200);
          if (!result) {
            throw new Error("plugin handler did not dispatch the session read");
          }
          return result;
        };
        try {
          await projection.ensureMaterialized();
          await run({
            readerId: reader.id,
            ownerEmail,
            dispatch,
            dispatchHttp,
            blockCatalog: () => {
              catalogGate = createDeferred();
              catalogEntered = createDeferred();
              sessionChanges.emit({ all: true, scope: "catalog" });
              return { entered: catalogEntered.promise, release: () => catalogGate?.resolve() };
            },
          });
        } finally {
          catalogGate?.resolve();
          await projection.ensureMaterialized();
          projection.dispose();
          invalidateOperatorRolePolicy(reader.id);
        }
      },
    });
  });
}

function expectSessionKeys(
  result: Awaited<ReturnType<typeof dispatchGatewayMethod>>,
  keys: string[],
) {
  expect(result.ok).toBe(true);
  const payload = result.payload as { sessions: Array<{ key: string }> };
  expect(payload.sessions.map((session) => session.key).toSorted()).toEqual(keys.toSorted());
}

describe("plugin HTTP authenticated session reads", () => {
  it.each([false, true])(
    "keeps signed viewer privacy and shared access (roles=%s)",
    async (roles) => {
      await withCookieSessionReader(roles, async ({ dispatch }) => {
        expectSessionKeys(await dispatch("sessions.list"), [
          "agent:main:own-draft",
          "agent:main:shared",
        ]);
        expect(await dispatch("sessions.describe")).toMatchObject({
          ok: true,
          payload: { session: { key: "agent:main:shared", sharingRole: "viewer" } },
        });
        // Discovery always hides foreign drafts. Existing no-roles deployments
        // still allow an explicitly addressed draft; named roles return a null row.
        expect(await dispatch("sessions.describe", "agent:main:foreign-draft")).toMatchObject({
          ok: true,
          payload: {
            session: roles ? null : { key: "agent:main:foreign-draft", sharingRole: "viewer" },
          },
        });
        expect(
          await dispatch("sessions.describe", "agent:main:dashboard:incognito-http-reader"),
        ).toMatchObject({ ok: false });
      });
    },
  );

  it("refreshes merged-profile ownership during HTTP projection readiness", async () => {
    await withCookieSessionReader(
      true,
      async ({ readerId, ownerEmail, dispatch, blockCatalog }) => {
        const gate = blockCatalog();
        const pending = dispatch("sessions.list");
        try {
          await gate.entered;
          linkEmail(ownerEmail, readerId);
          gate.release();
          expectSessionKeys(await pending, [
            "agent:main:own-draft",
            "agent:main:foreign-draft",
            "agent:main:shared",
          ]);
          expect(await dispatch("sessions.describe", "agent:main:foreign-draft")).toMatchObject({
            ok: true,
            payload: { session: { sharingRole: "owner" } },
          });
        } finally {
          gate.release();
          await pending;
        }
      },
    );
  });

  it("withdraws foreign-session access during HTTP projection readiness", async () => {
    await withCookieSessionReader(
      true,
      async ({ readerId, dispatch, dispatchHttp, blockCatalog }) => {
        expectSessionKeys(await dispatch("sessions.list"), [
          "agent:main:own-draft",
          "agent:main:shared",
        ]);
        const gate = blockCatalog();
        const pending = dispatchHttp("sessions.list");
        try {
          await gate.entered;
          setUserProfileRole(readerId, "blocked");
          invalidateOperatorRolePolicy(readerId);
          gate.release();
          expect(await pending).toEqual({ statusCode: 500, result: undefined });
          expectSessionKeys(await dispatch("sessions.list"), ["agent:main:own-draft"]);
          expect(await dispatch("sessions.describe")).toMatchObject({ ok: false });
        } finally {
          gate.release();
          await pending;
        }
      },
    );
  });
});

function route(params: Partial<PluginHttpRouteRegistration> = {}) {
  return createRoute({ path: "/hook", auth: "plugin", ...params });
}
function setup(
  routes: PluginHttpRouteRegistration[],
  extra: { getGatewayRequestContext?: () => GatewayRequestContext } = {},
) {
  const log = createMockLogger();
  const registry = createGatewayTestRegistry({ httpRoutes: routes });
  const options = { registry, log, getGatewayRequestContext: extra.getGatewayRequestContext };
  const handler = createGatewayPluginRequestHandler(options);
  return { registry, log, handler, upgrade: createGatewayPluginUpgradeHandler(options) };
}
function createMockUpgradeSocket() {
  const chunks: string[] = [];
  const socket = Object.assign(new PassThrough(), { chunks });
  socket.on("data", (chunk: Buffer) => chunks.push(chunk.toString()));
  return socket;
}

describe("plugin HTTP routing", () => {
  it("matches current owned registrations after warming, replacement, and removal", async () => {
    const { registry, handler } = setup([]);
    const calls: string[] = [];
    const register = (
      path: string,
      match: "exact" | "prefix",
      label: string,
      replaceExisting = false,
    ) =>
      registerPluginHttpRoute({
        registry,
        path,
        match,
        auth: "plugin",
        pluginId: "route",
        source: "route",
        replaceExisting,
        throwOnFailure: true,
        handler: () => {
          calls.push(label);
          return true;
        },
      });
    const removePrefix = register("/demo", "prefix", "prefix");
    const removeOriginal = register("/DEMO/%2569tem", "exact", "original");
    const routes = registry.httpRoutes;
    const invokeRegistration = async () =>
      (await dispatchPluginRequest(handler, { path: "/demo/%69tem" })).handled;
    expect(await invokeRegistration()).toBe(true);
    const removeReplacement = register("/demo/item", "exact", "replacement", true);
    expect(registry.httpRoutes).toBe(routes);
    expect(await invokeRegistration()).toBe(true);
    removeOriginal();
    expect(await invokeRegistration()).toBe(true);
    removeReplacement();
    expect(await invokeRegistration()).toBe(true);
    removePrefix();
    expect(await invokeRegistration()).toBe(false);
    expect(calls).toEqual(["original", "replacement", "replacement", "prefix"]);
  });

  it.each([
    { auth: { gatewayAuthSatisfied: false }, reason: "gateway auth" },
    { auth: { gatewayAuthSatisfied: true }, reason: "caller scope context" },
  ])(
    "rejects overlapping routes without $reason and redacts bearer queries",
    async ({ auth, reason }) => {
      const exact = vi.fn(() => false);
      const prefix = vi.fn(() => true);
      const { handler, log } = setup([
        route({ path: "/plugin/secure/report", handler: exact }),
        route({ path: "/plugin/secure", match: "prefix", auth: "gateway", handler: prefix }),
      ]);
      const tokenParam = `__openclaw_mms_token_${"a".repeat(24)}`;
      const result = await dispatchPluginRequest(handler, {
        path: `/plugin/secure/report?upstream-token=proxy-secret&${tokenParam}=media-secret`,
        authContext: auth,
      });
      expect(result.handled).toBe(false);
      expect(exact).not.toHaveBeenCalled();
      expect(prefix).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        `plugin http route blocked without ${reason} (/plugin/secure/report)`,
      );
      expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain("proxy-secret");
      expect(JSON.stringify(vi.mocked(log.warn).mock.calls)).not.toContain("media-secret");
    },
  );

  it("aborts an incomplete unframed response when the plugin route throws", async () => {
    const { handler, log } = setup([
      route({
        handler: (_req, res) => {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.write("partial");
          throw new Error("boom");
        },
      }),
    ]);
    const server = createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("server did not bind to a TCP port");
    }
    try {
      await expect(
        fetch(`http://127.0.0.1:${address.port}/hook`, { signal: AbortSignal.timeout(1_000) }).then(
          (res) => res.text(),
        ),
      ).rejects.toMatchObject({ name: "TypeError" });
      expect(log.warn).toHaveBeenCalledWith("plugin http route failed (route): Error: boom");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("does not end a response the plugin already destroyed before throwing", async () => {
    const { handler, log } = setup([
      route({
        handler: (_req, res) => {
          Object.defineProperty(res, "headersSent", { value: true, configurable: true });
          res.destroy();
          throw new Error("boom");
        },
      }),
    ]);
    const { handled, res, end } = await dispatchPluginRequest(handler, { path: "/hook" });
    expect(handled).toBe(true);
    expect(res.destroyed).toBe(true);
    expect(end).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("plugin http route failed (route): Error: boom");
  });

  it("claims and rejects matched gateway upgrades when auth was not satisfied", async () => {
    const handleUpgrade = vi.fn(() => true);
    const { upgrade } = setup([route({ auth: "gateway", handleUpgrade })]);
    const socket = createMockUpgradeSocket();
    const closed = once(socket, "close");
    expect(await upgrade({ url: "/hook" } as IncomingMessage, socket, Buffer.alloc(0))).toBe(true);
    await closed;
    expect(handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroyed).toBe(true);
    expect(socket.chunks.join("")).toContain("HTTP/1.1 401 Unauthorized");
  });
});

describe("plugin HTTP route auth checks", () => {
  const decodeOverflowPublicPath = `/googlechat%${"25".repeat(39)}2fpublic`;
  it("matches canonicalized variants and observes direct route mutation", () => {
    const entry = route({ path: "/api/demo" });
    const { registry } = setup([entry]);
    expect(findRegisteredPluginHttpRoute(registry, "/api//demo")).toBe(entry);
    expect(findRegisteredPluginHttpRoute(registry, "/API/demo")).toBe(entry);
    expect(findRegisteredPluginHttpRoute(registry, "/api/%2564emo")).toBe(entry);
    entry.path = "/api/other";
    expect(findRegisteredPluginHttpRoute(registry, "/api/demo")).toBeUndefined();
    expect(findRegisteredPluginHttpRoute(registry, "/api/%256fther")).toBe(entry);
  });

  it("enforces auth for protected, encoded, and overlapping gateway routes", () => {
    const { registry } = setup([
      route({ path: "/googlechat", match: "prefix" }),
      route({ path: "/api/demo", auth: "gateway" }),
      route({ path: "/plugin/secure", match: "prefix", auth: "gateway" }),
      route({ path: "/plugin/secure/report" }),
    ]);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api//demo")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/plugin/secure/report")).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/googlechat/public")).toBe(false);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/api/channels/status")).toBe(true);
    expect(
      shouldEnforceGatewayAuthForPluginPath(
        registry,
        "/api%2525252fchannels%2525252fnostr%2525252fdefault%2525252fprofile",
      ),
    ).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, decodeOverflowPublicPath)).toBe(true);
    expect(shouldEnforceGatewayAuthForPluginPath(registry, "/not-plugin")).toBe(false);
  });

  it("recognizes only existing, unambiguous plugin-authenticated routes", () => {
    const { registry } = setup([
      route({ path: "/googlechat", match: "prefix" }),
      route({ path: "/plugin/secure", match: "prefix", auth: "gateway" }),
      route({ path: "/plugin/secure/report" }),
    ]);
    expect(isPluginAuthenticatedRoutePath(registry, "/googlechat")).toBe(true);
    expect(isPluginAuthenticatedRoutePath(registry, "/googlechat/events")).toBe(true);
    expect(isPluginAuthenticatedRoutePath(registry, "/missing")).toBe(false);
    expect(isPluginAuthenticatedRoutePath(registry, "/api/channels/status")).toBe(false);
    expect(isPluginAuthenticatedRoutePath(registry, "/plugin/secure/report")).toBe(false);
    expect(isPluginAuthenticatedRoutePath(registry, decodeOverflowPublicPath)).toBe(false);
  });
});

describe("plugin suspension admission", () => {
  const ROUTE_PATH = "/plugin/suspension-proof";
  let rateLimitEpochMs = Date.now();

  function suspensionRoute(params: Partial<PluginHttpRouteRegistration>) {
    return createRoute({ path: ROUTE_PATH, auth: "plugin", ...params });
  }

  function suspensionSetup(
    routes: PluginHttpRouteRegistration[],
    getGatewayRequestContext?: () => GatewayRequestContext,
  ) {
    const { handler: http, upgrade } = setup(routes, { getGatewayRequestContext });
    const req = () => ({ url: ROUTE_PATH, headers: {} }) as IncomingMessage;
    return {
      request: (res: ReturnType<typeof makeMockHttpResponse>["res"], auth = trusted) =>
        http(req(), res, undefined, auth),
      upgrade: (socket: ReturnType<typeof createMockUpgradeSocket>) =>
        upgrade(req(), socket, Buffer.alloc(0)),
    };
  }

  beforeEach(() => {
    rateLimitEpochMs += 60_000;
    vi.spyOn(Date, "now").mockReturnValue(rateLimitEpochMs);
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetGatewaySuspendCoordinatorForLifecycleRestart();
    resetGatewayWorkAdmission();
  });

  describe("plugin HTTP suspension admission", () => {
    it.each(["HTTP", "upgrade"] as const)(
      "keeps an in-flight %s route visible to suspension",
      async (transport) => {
        const started = createDeferred();
        const finish = createDeferred();
        const run = async () => {
          started.resolve();
          await finish.promise;
          return true;
        };
        const routes = [suspensionRoute({ handler: run, handleUpgrade: run })];
        const socket = createMockUpgradeSocket();
        const pending =
          transport === "HTTP"
            ? suspensionSetup(routes).request(makeMockHttpResponse().res)
            : suspensionSetup(routes).upgrade(socket);
        try {
          await started.promise;
          expect(getActiveGatewayRootWorkCount()).toBe(1);
          expect(
            prepareGatewaySuspend({
              requestId: "plugin-active",
              pauseScheduling: vi.fn(),
              resumeScheduling: vi.fn(),
            }),
          ).toMatchObject({
            status: "busy",
            reason: "active-work",
            activeCount: 1,
            blockers: [expect.objectContaining({ kind: "root-request", count: 1 })],
          });
        } finally {
          finish.resolve();
        }
        await expect(pending).resolves.toBe(true);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        socket.destroy();
      },
    );

    it("keeps an ordinary sibling from an entitled plugin behind admission", async () => {
      const ordinaryHandler = vi.fn(() => true);
      const { request } = suspensionSetup([
        suspensionRoute({
          auth: "gateway",
          gatewayMethodDispatchAllowed: true,
          handler: ordinaryHandler,
        }),
        suspensionRoute({
          path: `${ROUTE_PATH}/control`,
          auth: "gateway",
          gatewayRuntimeScopeSurface: "trusted-operator",
          gatewayMethodDispatchAllowed: true,
        }),
      ]);
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const response = makeMockHttpResponse();

      await expect(request(response.res)).resolves.toBe(true);

      expect(ordinaryHandler).not.toHaveBeenCalled();
      expect(response.res.statusCode).toBe(503);
      expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "1");
      expect(JSON.parse(String(response.end.mock.calls[0]?.[0]))).toMatchObject({
        error: { code: "gateway_unavailable" },
      });
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(suspension?.release()).toBe(true);
    });

    it("keeps entitled Gateway suspension dispatch outside the plugin route root", async () => {
      const cron = {
        pauseScheduling: vi.fn(),
        resumeScheduling: vi.fn(),
        getSuspensionBlockerCount: vi.fn(() => 0),
      };
      const context = {
        trackExecution: trackAsyncWork,
        cron,
        logGateway: { warn: vi.fn() },
        chatAbortControllers: new Map(),
        chatQueuedTurns: new Map(),
        terminalSessions: new Map(),
      } as unknown as GatewayRequestContext;
      const invokeSuspension = async (method: string, params: Record<string, unknown>) => {
        let result: Awaited<ReturnType<typeof dispatchGatewayMethod>> | undefined;
        const { request } = suspensionSetup(
          [
            suspensionRoute({
              auth: "gateway",
              gatewayRuntimeScopeSurface: "trusted-operator",
              gatewayMethodDispatchAllowed: true,
              handler: async () => {
                expect(getActiveGatewayRootWorkCount()).toBe(0);
                result = await dispatchGatewayMethod(method, params);
                return true;
              },
            }),
          ],
          () => context,
        );
        expect(
          await request(makeMockHttpResponse().res, {
            ...trusted,
            gatewayRequestOperatorScopes: ["operator.admin"],
          }),
        ).toBe(true);
        expect(result).toBeDefined();
        return result!;
      };

      const prepared = await invokeSuspension("gateway.suspend.prepare", {
        requestId: "admin-http-suspension",
      });
      expect(prepared).toMatchObject({
        ok: true,
        payload: { status: "ready", activeCount: 0, blockers: [] },
      });
      const suspensionId = (prepared.payload as { suspensionId: string }).suspensionId;

      await expect(
        invokeSuspension("gateway.suspend.status", { suspensionId }),
      ).resolves.toMatchObject({
        ok: true,
        payload: { status: "ready" },
      });
      await expect(
        invokeSuspension("gateway.suspend.resume", { suspensionId }),
      ).resolves.toMatchObject({
        ok: true,
        payload: { status: "running", resumed: true },
      });
      expect(cron.pauseScheduling).toHaveBeenCalledOnce();
      expect(cron.resumeScheduling).toHaveBeenCalledOnce();
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
  });

  describe("plugin upgrade suspension admission", () => {
    it("rejects a new upgrade with HTTP 503 after admission closes", async () => {
      const upgrade = vi.fn(() => true);
      const { upgrade: dispatch } = suspensionSetup([
        suspensionRoute({ handler: () => false, handleUpgrade: upgrade }),
      ]);
      const suspension = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspension?.commit()).toBe(true);
      const socket = createMockUpgradeSocket();
      const closed = once(socket, "close");

      await expect(dispatch(socket)).resolves.toBe(true);
      await closed;

      expect(upgrade).not.toHaveBeenCalled();
      expect(socket.destroyed).toBe(true);
      expect(socket.chunks.join("")).toContain("HTTP/1.1 503 Service Unavailable");
      expect(socket.chunks.join("")).toContain("Gateway websocket admission closed");
      expect(getActiveGatewayRootWorkCount()).toBe(0);
      expect(suspension?.release()).toBe(true);
    });

    it("releases upgrade admission after fallthrough and failure", async () => {
      const fallthrough = vi.fn(() => false);
      const handled = vi.fn(() => true);
      const { upgrade: fallthroughHandler } = suspensionSetup([
        suspensionRoute({ handler: () => false, handleUpgrade: fallthrough }),
        suspensionRoute({
          path: "/plugin",
          match: "prefix",
          handler: () => false,
          handleUpgrade: handled,
        }),
      ]);
      const fallthroughSocket = createMockUpgradeSocket();

      await expect(fallthroughHandler(fallthroughSocket)).resolves.toBe(true);
      expect(fallthrough).toHaveBeenCalledOnce();
      expect(handled).toHaveBeenCalledOnce();
      expect(fallthroughSocket.destroyed).toBe(false);
      expect(getActiveGatewayRootWorkCount()).toBe(0);

      const { upgrade: failingHandler } = suspensionSetup([
        suspensionRoute({
          handler: () => false,
          handleUpgrade: () => {
            throw new Error("upgrade failed");
          },
        }),
      ]);
      const failureSocket = createMockUpgradeSocket();
      await expect(failingHandler(failureSocket)).resolves.toBe(true);
      expect(failureSocket.destroyed).toBe(true);
      expect(getActiveGatewayRootWorkCount()).toBe(0);
    });
  });
});
