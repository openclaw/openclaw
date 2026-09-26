import type { IncomingMessage, ServerResponse } from "node:http";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import { dispatchGatewayMethod } from "../../plugin-sdk/gateway-method-runtime.js";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import { ensureProfileForEmail, linkEmail, setUserProfileRole } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { setControlUiPluginAuthCookie } from "../control-ui-plugin-auth-cookie.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import {
  authorizeControlUiPluginCookieRequest,
  resolveControlUiPluginAuthCookieGeneration,
} from "../http-auth-plugin-cookie.js";
import type { AuthorizedGatewayHttpRequest } from "../http-utils.js";
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
} from "./plugins-http.js";

const SECURE_HOOK_PATH = "/secure-hook";
const SECURE_ADMIN_HOOK_PATH = "/secure-admin-hook";

type PluginHttpRoute = ReturnType<typeof createRoute>;
type PluginRequestHandler = ReturnType<typeof createGatewayPluginRequestHandler>;
type PluginRequestAuthContext = NonNullable<Parameters<PluginRequestHandler>[3]>;

function createRoute(params: {
  path: string;
  auth: "gateway" | "plugin";
  match?: "exact" | "prefix";
  gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
  gatewayMethodDispatchAllowed?: boolean;
  handler?: (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;
}) {
  return {
    pluginId: "route",
    path: params.path,
    auth: params.auth,
    gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
    gatewayMethodDispatchAllowed: params.gatewayMethodDispatchAllowed,
    match: params.match ?? "exact",
    handler: params.handler ?? (() => true),
    source: "route",
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
  return logger as SubsystemLogger;
}

function assertWriteHelperAllowed() {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
  const auth = authorizeOperatorScopesForMethod("agent", scopes);
  if (!auth.allowed) {
    throw new Error(`missing scope: ${auth.missingScope}`);
  }
}

function assertAdminHelperAllowed() {
  const scopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes ?? [];
  const auth = authorizeOperatorScopesForMethod("set-heartbeats", scopes);
  if (!auth.allowed) {
    throw new Error(`missing scope: ${auth.missingScope}`);
  }
}

function createPluginRequestHandler(params: {
  routes: PluginHttpRoute[];
  log?: SubsystemLogger;
  getRouteRegistry?: () => ReturnType<typeof createGatewayTestRegistry>;
  getGatewayRequestContext?: () => GatewayRequestContext;
}) {
  return createGatewayPluginRequestHandler({
    registry: createGatewayTestRegistry({ httpRoutes: params.routes }),
    ...(params.getRouteRegistry ? { getRouteRegistry: params.getRouteRegistry } : {}),
    log: params.log ?? createMockLogger(),
    ...(params.getGatewayRequestContext
      ? { getGatewayRequestContext: params.getGatewayRequestContext }
      : {}),
  });
}

async function dispatchPluginRequest(
  handler: PluginRequestHandler,
  params: {
    path: string;
    authContext: PluginRequestAuthContext;
  },
) {
  const response = makeMockHttpResponse();
  const handled = await handler(
    { url: params.path } as IncomingMessage,
    response.res,
    undefined,
    params.authContext,
  );
  return { handled, ...response };
}

async function dispatchTrustedGatewayRequest(handler: PluginRequestHandler, path: string) {
  return await dispatchPluginRequest(handler, {
    path,
    authContext: {
      gatewayAuthSatisfied: true,
      gatewayRequestAuth: { authMethod: "token", trustDeclaredOperatorScopes: false },
      gatewayRequestOperatorScopes: ["operator.write"],
    },
  });
}

function expectMissingWriteScopeFailure(params: {
  res: ServerResponse;
  setHeader: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  log: SubsystemLogger;
}) {
  expect(params.res.statusCode).toBe(500);
  expect(params.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
  expect(params.end).toHaveBeenCalledWith("Internal Server Error");
  expect(params.log.warn).toHaveBeenCalledWith(
    "plugin http route failed (route): Error: missing scope: operator.write",
  );
}

describe("plugin HTTP route runtime scopes", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  async function invokeRoute(params: {
    path: string;
    auth: "gateway" | "plugin";
    gatewayRuntimeScopeSurface?: "write-default" | "trusted-operator";
    gatewayAuthSatisfied: boolean;
    gatewayRequestAuth?: AuthorizedGatewayHttpRequest;
    gatewayRequestOperatorScopes?: readonly string[];
  }) {
    const log = createMockLogger();
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: params.path,
          auth: params.auth,
          gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface,
          handler: async () => {
            const scope = getPluginRuntimeGatewayRequestScope();
            if (params.auth === "plugin") {
              expect(scope?.hasCurrentClientAuthority).toBeUndefined();
            }
            assertWriteHelperAllowed();
            return true;
          },
        }),
      ],
      log,
    });

    const response = await dispatchPluginRequest(handler, {
      path: params.path,
      authContext: {
        gatewayAuthSatisfied: params.gatewayAuthSatisfied,
        gatewayRequestAuth: params.gatewayRequestAuth,
        gatewayRequestOperatorScopes: params.gatewayRequestOperatorScopes,
      },
    });
    return { log, ...response };
  }

  it("keeps plugin-auth routes off write-capable runtime helpers", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      path: "/hook",
      auth: "plugin",
      gatewayAuthSatisfied: false,
    });

    expect(handled).toBe(true);
    expectMissingWriteScopeFailure({ res, setHeader, end, log });
  });

  it("preserves write-capable runtime helpers on gateway-auth routes", async () => {
    const { handled, res, log } = await invokeRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.write"],
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it.each(["unchanged", "request policy", "visitor grant"] as const)(
    "rechecks both authorities before the next matched route after %s changes",
    async (changed) => {
      const entered = createDeferred();
      const release = createDeferred();
      const grant = new AbortController();
      let current = true;
      const nextRoute = vi.fn(() => true);
      const firstRoute = createRoute({
        path: SECURE_HOOK_PATH,
        auth: "gateway",
        handler: async () => {
          expect(getPluginRuntimeGatewayRequestScope()?.signal).toBe(grant.signal);
          entered.resolve();
          await release.promise;
          return false;
        },
      });
      const handler = createPluginRequestHandler({
        routes: [firstRoute, { ...firstRoute, match: "prefix", handler: nextRoute }],
      });
      const pending = dispatchPluginRequest(handler, {
        path: SECURE_HOOK_PATH,
        authContext: {
          gatewayAuthSatisfied: true,
          gatewayRequestOperatorScopes: ["operator.write"],
          gatewayRequestAuth: {
            trustDeclaredOperatorScopes: true,
            hasCurrentClientAuthority: () => current,
            operatorAccessAuthority: {
              signal: grant.signal,
              assertCurrent: () => grant.signal.throwIfAborted(),
            },
          },
        },
      });
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("request ended before the first route prepared");
          }),
        ]);
        if (changed === "request policy") {
          current = false;
        } else if (changed === "visitor grant") {
          grant.abort();
        }
      } finally {
        release.resolve();
      }
      const { handled, res } = await pending;
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(
        changed === "unchanged" ? 200 : changed === "request policy" ? 401 : 403,
      );
      expect(nextRoute).toHaveBeenCalledTimes(changed === "unchanged" ? 1 : 0);
    },
  );

  it("threads plugin route identity and gateway dispatch entitlement into runtime scope", async () => {
    let observed:
      | {
          pluginId: string | undefined;
          pluginSource: string | undefined;
          gatewayMethodDispatchAllowed: boolean | undefined;
        }
      | undefined;
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          gatewayMethodDispatchAllowed: true,
          handler: async () => {
            const scope = getPluginRuntimeGatewayRequestScope();
            observed = {
              pluginId: scope?.pluginId,
              pluginSource: scope?.pluginSource,
              gatewayMethodDispatchAllowed: scope?.gatewayMethodDispatchAllowed,
            };
            return true;
          },
        }),
      ],
    });

    const { handled, res } = await dispatchPluginRequest(handler, {
      path: SECURE_HOOK_PATH,
      authContext: {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(observed).toEqual({
      pluginId: "route",
      pluginSource: "route",
      gatewayMethodDispatchAllowed: true,
    });
  });

  it("preserves the verified person on gateway-authenticated plugin runtime clients", async () => {
    const authenticatedUserProfile = {
      profileId: "profile-guest",
      displayName: "Guest",
      hasAvatar: false,
      updatedAt: 1,
    };
    let observedProfile: AuthorizedGatewayHttpRequest["authenticatedUserProfile"];
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          handler: async () => {
            observedProfile =
              getPluginRuntimeGatewayRequestScope()?.client?.authenticatedUserProfile;
            return true;
          },
        }),
      ],
    });

    const { handled } = await dispatchPluginRequest(handler, {
      path: SECURE_HOOK_PATH,
      authContext: {
        gatewayAuthSatisfied: true,
        gatewayRequestAuth: {
          authMethod: "trusted-proxy",
          trustDeclaredOperatorScopes: true,
          authenticatedUserProfile,
        },
        gatewayRequestOperatorScopes: ["operator.read"],
      },
    });

    expect(handled).toBe(true);
    expect(observedProfile).toEqual(authenticatedUserProfile);
  });

  it.each([
    { auth: "gateway" as const, authMethod: "token" as const, systemActor: true },
    { auth: "gateway" as const, authMethod: "password" as const, systemActor: true },
    { auth: "gateway" as const, authMethod: "trusted-proxy" as const, systemActor: false },
    { auth: "plugin" as const, authMethod: "token" as const, systemActor: false },
  ])(
    "preserves system authority only for authenticated shared-secret gateway routes ($auth/$authMethod)",
    async ({ auth, authMethod, systemActor }) => {
      const authenticatedUserProfile = {
        profileId: "profile-owner",
        displayName: "Owner",
        hasAvatar: false,
        updatedAt: 1,
      };
      let observedActor: unknown;
      let observedProfile: AuthorizedGatewayHttpRequest["authenticatedUserProfile"];
      const handler = createPluginRequestHandler({
        routes: [
          createRoute({
            path: SECURE_HOOK_PATH,
            auth,
            handler: async () => {
              observedActor =
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRoleActor;
              observedProfile =
                getPluginRuntimeGatewayRequestScope()?.client?.authenticatedUserProfile;
              return true;
            },
          }),
        ],
      });

      const { handled } = await dispatchPluginRequest(handler, {
        path: SECURE_HOOK_PATH,
        authContext: {
          gatewayAuthSatisfied: true,
          gatewayRequestAuth: {
            authMethod,
            trustDeclaredOperatorScopes: false,
            authenticatedUserProfile,
            ...(authMethod === "token" || authMethod === "password"
              ? { operatorRoleActor: { kind: "system" as const } }
              : {}),
          },
          gatewayRequestOperatorScopes: ["operator.write"],
        },
      });

      expect(handled).toBe(true);
      expect(observedActor).toEqual(systemActor ? { kind: "system" } : undefined);
      expect(observedProfile).toEqual(auth === "gateway" ? authenticatedUserProfile : undefined);
    },
  );

  it("uses server-local routes and gateway context when the active registry belongs to another gateway", async () => {
    const serverAContext = { label: "server-a" } as unknown as GatewayRequestContext;
    const serverBContext = { label: "server-b" } as unknown as GatewayRequestContext;
    const observed: Array<{ route: string; context?: GatewayRequestContext }> = [];
    const serverARegistry = createGatewayTestRegistry({
      httpRoutes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          handler: async () => {
            const context = getPluginRuntimeGatewayRequestScope()?.context;
            observed.push({ route: "server-a", ...(context ? { context } : {}) });
            return true;
          },
        }),
      ],
    });
    const serverBRegistry = createGatewayTestRegistry({
      httpRoutes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          handler: async () => {
            const context = getPluginRuntimeGatewayRequestScope()?.context;
            observed.push({ route: "server-b", ...(context ? { context } : {}) });
            return true;
          },
        }),
      ],
    });

    setActivePluginRegistry(serverBRegistry);

    const handlerA = createGatewayPluginRequestHandler({
      registry: serverARegistry,
      getRouteRegistry: () => serverARegistry,
      log: createMockLogger(),
      getGatewayRequestContext: () => serverAContext,
    });
    const handlerB = createGatewayPluginRequestHandler({
      registry: serverBRegistry,
      getRouteRegistry: () => serverBRegistry,
      log: createMockLogger(),
      getGatewayRequestContext: () => serverBContext,
    });

    const responseA = makeMockHttpResponse();
    const handledA = await handlerA(
      { url: SECURE_HOOK_PATH } as IncomingMessage,
      responseA.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );
    const responseB = makeMockHttpResponse();
    const handledB = await handlerB(
      { url: SECURE_HOOK_PATH } as IncomingMessage,
      responseB.res,
      undefined,
      {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.write"],
      },
    );

    expect(handledA).toBe(true);
    expect(handledB).toBe(true);
    expect(responseA.res.statusCode).toBe(200);
    expect(responseB.res.statusCode).toBe(200);
    expect(observed).toEqual([
      { route: "server-a", context: serverAContext },
      { route: "server-b", context: serverBContext },
    ]);
  });

  it.each(["HTTP", "WebSocket"] as const)(
    "binds reloaded %s handlers to the registry that owns their route",
    async (transport) => {
      const observed: Array<ReturnType<typeof createGatewayTestRegistry> | undefined> = [];
      const observeScope = () => {
        observed.push(getPluginRuntimeGatewayRequestScope()?.pluginRegistry);
        return true;
      };
      const createRegistry = () =>
        createGatewayTestRegistry({
          httpRoutes: [
            {
              ...createRoute({ path: SECURE_HOOK_PATH, auth: "gateway", handler: observeScope }),
              handleUpgrade: observeScope,
            },
          ],
        });
      const startupRegistry = createRegistry();
      let currentRegistry = startupRegistry;
      const options = {
        registry: startupRegistry,
        getRouteRegistry: () => currentRegistry,
        log: createMockLogger(),
      };
      const requestHandler = createGatewayPluginRequestHandler(options);
      const upgradeHandler = createGatewayPluginUpgradeHandler(options);
      const socket = new PassThrough();
      try {
        const dispatch = async () =>
          transport === "HTTP"
            ? (await dispatchTrustedGatewayRequest(requestHandler, SECURE_HOOK_PATH)).handled
            : await upgradeHandler(
                { url: SECURE_HOOK_PATH } as IncomingMessage,
                socket,
                Buffer.alloc(0),
                undefined,
                { gatewayAuthSatisfied: true, gatewayRequestOperatorScopes: ["operator.write"] },
              );
        expect(await dispatch()).toBe(true);
        currentRegistry = createRegistry();
        expect(await dispatch()).toBe(true);
        expect(observed).toHaveLength(2);
        expect(observed[0]).toBe(startupRegistry);
        expect(observed[1]).toBe(currentRegistry);
      } finally {
        socket.destroy();
      }
    },
  );

  it("does not give approval-scoped gateway-auth routes global approval visibility", async (testContext) => {
    const manager = createTestApprovalManager<{ command: string }>(testContext);
    const record = manager.create({ command: "echo ok" }, 60_000, "route-hidden-approval");
    record.requestedByDeviceId = "device-owner";
    record.requestedByConnId = "conn-owner";
    record.requestedByClientId = "client-owner";
    let observedApprovalRuntime: boolean | undefined;
    let observedVisibility: boolean | undefined;
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_HOOK_PATH,
          auth: "gateway",
          handler: async () => {
            const runtimeClient = getPluginRuntimeGatewayRequestScope()?.client;
            observedApprovalRuntime = runtimeClient?.internal?.approvalRuntime;
            observedVisibility = isApprovalRecordVisibleToClient({
              record,
              client: runtimeClient ?? null,
            });
            return true;
          },
        }),
      ],
    });

    const { handled, res } = await dispatchPluginRequest(handler, {
      path: SECURE_HOOK_PATH,
      authContext: {
        gatewayAuthSatisfied: true,
        gatewayRequestOperatorScopes: ["operator.approvals"],
      },
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(observedApprovalRuntime).not.toBe(true);
    expect(observedVisibility).toBe(false);
  });

  it("fails closed when gateway-auth route runtime scopes are missing", async () => {
    const { handled, res, log } = await invokeRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
    });

    expect(handled).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(log.warn).toHaveBeenCalledWith(
      "plugin http route blocked without caller scope context (/secure-hook)",
    );
  });

  it("does not allow write helpers for read-scoped gateway-auth requests", async () => {
    const { handled, res, setHeader, end, log } = await invokeRoute({
      path: "/secure-hook",
      auth: "gateway",
      gatewayAuthSatisfied: true,
      gatewayRequestOperatorScopes: ["operator.read"],
    });

    expect(handled).toBe(true);
    expectMissingWriteScopeFailure({ res, setHeader, end, log });
  });

  it("restores trusted-operator defaults for routes opting into trusted surface", async () => {
    let observedScopes: string[] | undefined;
    const log = createMockLogger();
    const handler = createPluginRequestHandler({
      routes: [
        createRoute({
          path: SECURE_ADMIN_HOOK_PATH,
          auth: "gateway",
          gatewayRuntimeScopeSurface: "trusted-operator",
          handler: async () => {
            observedScopes =
              getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
            assertAdminHelperAllowed();
            return true;
          },
        }),
      ],
      log,
    });

    const response = await dispatchTrustedGatewayRequest(handler, SECURE_ADMIN_HOOK_PATH);

    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
    expect(observedScopes).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it("scopes runtime privileges per matched route for exact/prefix overlap", async () => {
    const observed: Array<{ route: "exact" | "prefix"; scopes: string[] }> = [];
    const log = createMockLogger();
    const handler = createGatewayPluginRequestHandler({
      registry: createGatewayTestRegistry({
        httpRoutes: [
          createRoute({
            path: "/secure/admin-hook",
            auth: "gateway",
            match: "exact",
            handler: async () => {
              observed.push({
                route: "exact",
                scopes:
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
              });
              return false;
            },
          }),
          createRoute({
            path: "/secure",
            auth: "gateway",
            match: "prefix",
            gatewayRuntimeScopeSurface: "trusted-operator",
            handler: async () => {
              observed.push({
                route: "prefix",
                scopes:
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [],
              });
              assertAdminHelperAllowed();
              return true;
            },
          }),
        ],
      }),
      log,
    });

    const response = await dispatchTrustedGatewayRequest(handler, "/secure/admin-hook");

    expect(response.handled).toBe(true);
    expect(response.res.statusCode).toBe(200);
    expect(log.warn).not.toHaveBeenCalled();
    expect(observed).toHaveLength(2);
    expect(observed[0]).toEqual({
      route: "exact",
      scopes: ["operator.write"],
    });
    expect(observed[1]?.route).toBe("prefix");
    expect(observed[1]?.scopes).toEqual(CLI_DEFAULT_OPERATOR_SCOPES);
  });

  it.each([
    {
      auth: "plugin" as const,
      gatewayAuthSatisfied: false,
      path: "/hook",
      gatewayRequestOperatorScopes: undefined,
      expectedScopes: [],
    },
    {
      auth: "gateway" as const,
      gatewayAuthSatisfied: true,
      path: "/secure-hook",
      gatewayRequestOperatorScopes: ["operator.read"],
      expectedScopes: ["operator.read"],
    },
  ])(
    "maps $auth routes to $expectedScopes",
    async ({ auth, gatewayAuthSatisfied, gatewayRequestOperatorScopes, path, expectedScopes }) => {
      let observedScopes: string[] | undefined;
      const handler = createGatewayPluginRequestHandler({
        registry: createGatewayTestRegistry({
          httpRoutes: [
            createRoute({
              path,
              auth,
              handler: vi.fn(async () => {
                observedScopes =
                  getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes?.slice() ?? [];
                return true;
              }),
            }),
          ],
        }),
        log: createMockLogger(),
      });

      const { res } = makeMockHttpResponse();
      const handled = await handler({ url: path } as IncomingMessage, res, undefined, {
        gatewayAuthSatisfied,
        gatewayRequestOperatorScopes,
      });

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      expect(observedScopes).toEqual(expectedScopes);
    },
  );
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
          const handler = createPluginRequestHandler({
            getGatewayRequestContext: () => context,
            routes: [
              createRoute({
                path: SECURE_HOOK_PATH,
                auth: "gateway",
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
          });
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

  it("recognizes merged-profile draft ownership without substituting the default role", async () => {
    await withCookieSessionReader(true, async ({ readerId, ownerEmail, dispatch }) => {
      linkEmail(ownerEmail, readerId);
      expectSessionKeys(await dispatch("sessions.list"), [
        "agent:main:own-draft",
        "agent:main:foreign-draft",
        "agent:main:shared",
      ]);
      expect(await dispatch("sessions.describe", "agent:main:foreign-draft")).toMatchObject({
        ok: true,
        payload: { session: { sharingRole: "owner" } },
      });
    });
  });

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
        } finally {
          gate.release();
          await pending;
        }
      },
    );
  });

  it.each([false, true])(
    "releases HTTP profile subscriptions after handler failure=%s",
    async (fail) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const reader = ensureProfileForEmail("finished-http-reader@example.test");
        setUserProfileRole(reader.id, "reader");
        let retainedClient: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
        const handler = createPluginRequestHandler({
          routes: [
            createRoute({
              path: SECURE_HOOK_PATH,
              auth: "gateway",
              handler: async () => {
                retainedClient = getPluginRuntimeGatewayRequestScope();
                if (fail) {
                  throw new Error("expected route failure");
                }
                return true;
              },
            }),
          ],
        });
        await dispatchPluginRequest(handler, {
          path: SECURE_HOOK_PATH,
          authContext: {
            gatewayAuthSatisfied: true,
            gatewayRequestOperatorScopes: ["operator.read"],
            gatewayRequestAuth: {
              trustDeclaredOperatorScopes: false,
              authenticatedUserProfile: {
                profileId: reader.id,
                displayName: null,
                hasAvatar: false,
                updatedAt: 1,
              },
            },
          },
        });
        expect(retainedClient?.client?.preparedSessionProfile?.role).toBe("reader");
        setUserProfileRole(reader.id, "blocked");
        expect(retainedClient?.client?.preparedSessionProfile?.role).toBe("reader");
      });
    },
  );

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
