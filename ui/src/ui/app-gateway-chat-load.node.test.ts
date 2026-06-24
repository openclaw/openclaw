// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteId } from "../app-routes.ts";
import { connectGateway } from "./app-gateway.ts";
import type { GatewayConnectTiming, GatewayHelloOk } from "./gateway.ts";

const appRouterRevalidateMock = vi.hoisted(() => vi.fn(async (_host?: unknown) => undefined));
const currentRoute = vi.hoisted(() => ({ id: "chat" as RouteId }));
const refreshChatMock = vi.hoisted(() =>
  vi.fn(async (_host?: unknown, _opts?: unknown) => undefined),
);
const refreshChatAvatarMock = vi.hoisted(() => vi.fn(async () => undefined));
const scheduleChatScrollMock = vi.hoisted(() => vi.fn());
const loadControlUiBootstrapConfigMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAgentsMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadAssistantIdentityMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadDevicesMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadHealthStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadModelAuthStatusStateMock = vi.hoisted(() => vi.fn(async () => undefined));
const loadNodesMock = vi.hoisted(() => vi.fn(async () => undefined));
const subscribeSessionsMock = vi.hoisted(() => vi.fn(async () => undefined));
const syncUrlWithSessionKeyMock = vi.hoisted(() => vi.fn());
const verifyPushMock = vi.hoisted(() => vi.fn(async () => undefined));

type GatewayClientMock = {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  emitConnectTiming: (timing?: Partial<GatewayConnectTiming>) => void;
  emitHello: (hello?: GatewayHelloOk) => void;
};

const gatewayClients: GatewayClientMock[] = [];

function createDeferred() {
  let resolve: () => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<undefined>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, reject, resolve };
}

vi.mock("../app-routes.ts", () => ({
  appRouter: { revalidate: appRouterRevalidateMock },
  getVisibleRouteId: () => currentRoute.id,
  normalizeBasePath: (value: string) => value.replace(/\/+$/, ""),
  routeLoadContext: (host: unknown) => host,
}));

vi.mock("./gateway.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./gateway.ts")>();

  class GatewayBrowserClient {
    readonly start = vi.fn();
    readonly stop = vi.fn();
    readonly request = vi.fn(async () => ({}));

    constructor(
      private opts: {
        onConnectTiming?: (timing: GatewayConnectTiming) => void;
        onHello?: (hello: GatewayHelloOk) => void;
      },
    ) {
      gatewayClients.push({
        start: this.start,
        stop: this.stop,
        emitConnectTiming: (timing) => {
          this.opts.onConnectTiming?.({
            generation: 1,
            phase: "hello",
            durationMs: 20,
            phaseDurationMs: 2,
            hasChallenge: true,
            usedFallback: false,
            ...timing,
          });
        },
        emitHello: (hello) => {
          this.opts.onHello?.(
            hello ?? {
              type: "hello-ok",
              protocol: 4,
              snapshot: {},
              auth: { role: "operator", scopes: [] },
            },
          );
        },
      });
    }
  }

  return {
    ...actual,
    GatewayBrowserClient,
    resolveGatewayErrorDetailCode: () => null,
  };
});

vi.mock("../pages/chat/data.ts", () => ({
  CHAT_SESSIONS_ACTIVE_MINUTES: 60,
  CHAT_SESSIONS_REFRESH_LIMIT: 50,
  createChatSessionsLoadOverrides: () => ({ activeMinutes: 60, limit: 50 }),
  scopedAgentListParamsForSession: (_host: unknown, sessionKey: string) => {
    const [, agentId] = sessionKey.split(":");
    return sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
  scopedAgentListParamsForRefreshTarget: (
    _host: unknown,
    target: { sessionKey: string; agentId?: string },
  ) => {
    if (target.agentId) {
      return { agentId: target.agentId };
    }
    const [, agentId] = target.sessionKey.split(":");
    return target.sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
  clearPendingQueueItemsForRun: vi.fn(),
  flushChatQueueForEvent: vi.fn(),
  hasReconnectableQueuedChatSends: vi.fn(() => false),
  markQueuedChatSendsWaitingForReconnect: vi.fn(),
  retryReconnectableQueuedChatSends: vi.fn(async () => undefined),
  refreshChat: refreshChatMock,
  refreshChatAvatar: refreshChatAvatarMock,
}));

vi.mock("../pages/chat/chat-avatar.ts", () => ({
  refreshChatAvatar: refreshChatAvatarMock,
}));

vi.mock("../pages/chat/session-scope.ts", () => ({
  createChatSessionsLoadOverrides: () => ({ activeMinutes: 60, limit: 50 }),
  scopedAgentListParamsForSession: (_host: unknown, sessionKey: string) => {
    const [, agentId] = sessionKey.split(":");
    return sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
  scopedAgentListParamsForRefreshTarget: (
    _host: unknown,
    target: { sessionKey: string; agentId?: string },
  ) => {
    if (target.agentId) {
      return { agentId: target.agentId };
    }
    const [, agentId] = target.sessionKey.split(":");
    return target.sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
  scopedAgentParamsForSession: (_host: unknown, sessionKey: string) => {
    const [, agentId] = sessionKey.split(":");
    return sessionKey.startsWith("agent:") && agentId ? { agentId } : {};
  },
}));

vi.mock("../pages/chat/scroll.ts", () => ({
  scheduleChatScroll: scheduleChatScrollMock,
}));

vi.mock("../pages/chat/last-active-session.ts", () => ({
  setLastActiveSessionKey: vi.fn(),
}));

vi.mock("./app-settings.ts", () => ({
  applySettings: vi.fn(),
  syncUrlWithSessionKey: syncUrlWithSessionKeyMock,
}));

vi.mock("../pages/agents/data.ts", () => ({
  loadAgents: loadAgentsMock,
}));

vi.mock("./controllers/assistant-identity.ts", () => ({
  loadAssistantIdentity: loadAssistantIdentityMock,
}));

vi.mock("./controllers/control-ui-bootstrap.ts", () => ({
  loadControlUiBootstrapConfig: loadControlUiBootstrapConfigMock,
}));

vi.mock("../pages/nodes/devices.ts", () => ({
  loadDevices: loadDevicesMock,
}));

vi.mock("../app/exec-approval.ts", () => ({
  addExecApproval: vi.fn((queue, entry) => [...queue, entry]),
  clearResolvedExecApprovalPrompt: vi.fn(),
  enqueueExecApprovalPrompt: vi.fn(),
  parseExecApprovalRequested: vi.fn(() => null),
  parseExecApprovalResolved: vi.fn(() => null),
  parsePluginApprovalRequested: vi.fn(() => null),
  pruneExecApprovalQueue: vi.fn((queue) => queue),
  removeExecApproval: vi.fn((queue) => queue),
}));

vi.mock("./controllers/health.ts", () => ({
  loadHealthState: loadHealthStateMock,
}));

vi.mock("./controllers/model-auth-status.ts", () => ({
  loadModelAuthStatusState: loadModelAuthStatusStateMock,
}));

vi.mock("../pages/nodes/data.ts", () => ({
  loadNodes: loadNodesMock,
}));

vi.mock("../pages/sessions/data.ts", () => ({
  applySessionsChangedEvent: vi.fn(() => ({ applied: false })),
  loadSessions: vi.fn(async () => undefined),
  subscribeSessions: subscribeSessionsMock,
  syncSelectedSessionMessageSubscription: vi.fn(),
}));

afterAll(() => {
  vi.doUnmock("../app-routes.ts");
  vi.doUnmock("./gateway.ts");
  vi.doUnmock("../pages/chat/data.ts");
  vi.doUnmock("../pages/chat/scroll.ts");
  vi.doUnmock("./app-settings.ts");
  vi.doUnmock("../pages/agents/data.ts");
  vi.doUnmock("./controllers/assistant-identity.ts");
  vi.doUnmock("./controllers/control-ui-bootstrap.ts");
  vi.doUnmock("../pages/nodes/devices.ts");
  vi.doUnmock("../app/exec-approval.ts");
  vi.doUnmock("./controllers/health.ts");
  vi.doUnmock("./controllers/model-auth-status.ts");
  vi.doUnmock("../pages/nodes/data.ts");
  vi.doUnmock("../pages/sessions/data.ts");
  vi.resetModules();
});

function createHost(routeId: RouteId) {
  currentRoute.id = routeId;
  return {
    settings: {
      gatewayUrl: "ws://127.0.0.1:18789",
      token: "",
      sessionKey: "main",
    },
    password: "",
    clientInstanceId: "control-ui-test",
    client: null,
    connected: false,
    hello: null,
    lastError: null,
    lastErrorCode: null,
    eventLogBuffer: [],
    eventLog: [],
    routeId,
    presenceEntries: [],
    presenceError: null,
    presenceStatus: null,
    agentsLoading: false,
    agentsList: null,
    agentsError: null,
    healthLoading: false,
    healthResult: null,
    healthError: null,
    debugHealth: null,
    assistantName: "OpenClaw",
    assistantAvatar: null,
    assistantAgentId: null,
    serverVersion: null,
    pendingUpdateExpectedVersion: null,
    pendingUpdateHandoff: false,
    updateStatusBanner: null,
    sessionKey: "main",
    chatRunId: null,
    chatStream: null,
    chatStreamSegments: [],
    chatStreamStartedAt: null,
    chatToolMessages: [],
    toolStreamById: new Map(),
    toolStreamOrder: [],
    toolStreamSyncTimer: null,
    pendingAbort: null,
    refreshSessionsAfterChat: new Map(),
    execApprovalQueue: [],
    execApprovalError: null,
    updateAvailable: null,
    reconcileWebPushState: verifyPushMock,
  } as unknown as Parameters<typeof connectGateway>[0];
}

function connectHost(routeId: RouteId) {
  const host = createHost(routeId);
  connectGateway(host);
  const client = gatewayClients[0];
  if (!client) {
    throw new Error("Expected gateway client instance");
  }
  return { host, client };
}

function eventPayloads(
  host: ReturnType<typeof createHost>,
  event: string,
): Record<string, unknown>[] {
  const buffer = host.eventLogBuffer as { event?: string; payload?: unknown }[];
  return buffer
    .filter((entry) => entry.event === event && entry.payload && typeof entry.payload === "object")
    .map((entry) => entry.payload as Record<string, unknown>);
}

beforeEach(() => {
  gatewayClients.length = 0;
  appRouterRevalidateMock.mockClear();
  refreshChatMock.mockClear();
  refreshChatAvatarMock.mockClear();
  scheduleChatScrollMock.mockClear();
  loadControlUiBootstrapConfigMock.mockClear();
  loadAgentsMock.mockClear();
  loadAssistantIdentityMock.mockClear();
  loadDevicesMock.mockClear();
  loadHealthStateMock.mockClear();
  loadModelAuthStatusStateMock.mockClear();
  loadNodesMock.mockClear();
  subscribeSessionsMock.mockClear();
  syncUrlWithSessionKeyMock.mockClear();
  verifyPushMock.mockClear();
});

describe("connectGateway chat load startup work", () => {
  it("starts the active chat refresh before agents.list finishes", async () => {
    const agentsList = createDeferred();
    loadAgentsMock.mockReturnValueOnce(agentsList.promise);
    const { host, client } = connectHost("chat");

    client.emitHello();

    await vi.waitFor(() =>
      expect(refreshChatMock).toHaveBeenCalledWith(host, { awaitHistory: true, startup: true }),
    );
    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));
    expect(appRouterRevalidateMock).not.toHaveBeenCalled();

    agentsList.resolve();
    await agentsList.promise;
    await Promise.resolve();
    expect(appRouterRevalidateMock).not.toHaveBeenCalled();
  });

  it("skips agents.list when the startup chat refresh returns agents", async () => {
    refreshChatMock.mockImplementationOnce(async (target: unknown) => {
      (target as { agentsList: unknown }).agentsList = {
        agents: [{ id: "main", name: "Main" }],
        defaultId: "main",
        mainKey: "main",
        scope: "agent",
      };
    });
    const { host, client } = connectHost("chat");

    client.emitHello();

    await vi.waitFor(() =>
      expect(refreshChatMock).toHaveBeenCalledWith(host, { awaitHistory: true, startup: true }),
    );
    await Promise.resolve();
    expect(loadAgentsMock).not.toHaveBeenCalled();
    expect(appRouterRevalidateMock).not.toHaveBeenCalled();
  });

  it("does not let slow startup bootstrap block the first chat refresh", async () => {
    const bootstrap = createDeferred();
    const { host, client } = connectHost("chat");
    (host as typeof host & { controlUiBootstrapReady?: Promise<void> }).controlUiBootstrapReady =
      bootstrap.promise;

    client.emitHello();

    await vi.waitFor(() =>
      expect(refreshChatMock).toHaveBeenCalledWith(host, { awaitHistory: true, startup: true }),
    );
    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));

    bootstrap.resolve();
  });

  it("records connect timing through the Control UI performance buffer", () => {
    const { host, client } = connectHost("chat");

    client.emitConnectTiming({ phase: "request-sent", hasAuthToken: true });

    expect(eventPayloads(host, "control-ui.connect")).toContainEqual(
      expect.objectContaining({
        generation: 1,
        phase: "request-sent",
        durationMs: 20,
        hasChallenge: true,
        hasAuthToken: true,
      }),
    );
  });

  it("starts chat refresh before lower-priority hello work", async () => {
    const agentsList = createDeferred();
    loadAgentsMock.mockReturnValueOnce(agentsList.promise);
    const { host, client } = connectHost("chat");

    client.emitHello();

    await vi.waitFor(() =>
      expect(refreshChatMock).toHaveBeenCalledWith(host, { awaitHistory: true, startup: true }),
    );
    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));

    await vi.waitFor(() =>
      expect(loadControlUiBootstrapConfigMock).toHaveBeenCalledWith(host, {
        applyIdentity: false,
      }),
    );
    expect(refreshChatMock.mock.invocationCallOrder[0]).toBeLessThan(
      loadControlUiBootstrapConfigMock.mock.invocationCallOrder[0],
    );
    expect(loadAssistantIdentityMock).toHaveBeenCalledWith(host);
    expect(loadHealthStateMock).toHaveBeenCalledWith(host);
    expect(verifyPushMock).toHaveBeenCalledWith();
  });

  it("starts literal global chat refresh before agents.list when hello names the default agent", async () => {
    const agentsList = createDeferred();
    loadAgentsMock.mockReturnValueOnce(agentsList.promise);
    const { host, client } = connectHost("chat");
    host.sessionKey = "global";

    client.emitHello({
      type: "hello-ok",
      protocol: 4,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "ops",
          mainKey: "main",
          mainSessionKey: "agent:ops:main",
        },
      },
      auth: { role: "operator", scopes: [] },
    });

    await vi.waitFor(() =>
      expect(refreshChatMock).toHaveBeenCalledWith(host, { awaitHistory: true, startup: true }),
    );
    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));
    expect(appRouterRevalidateMock).not.toHaveBeenCalled();

    agentsList.resolve();
    await agentsList.promise;
    await Promise.resolve();
    expect(appRouterRevalidateMock).not.toHaveBeenCalled();
  });

  it("waits for agents.list when a stale agent session may need fallback", async () => {
    const agentsList = createDeferred();
    const { host, client } = connectHost("chat");
    loadAgentsMock.mockImplementationOnce(async () => {
      await agentsList.promise;
      host.agentsList = {
        defaultId: "new-default",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "new-default" }],
      };
    });
    host.sessionKey = "agent:old-default:main";
    host.agentsList = {
      defaultId: "old-default",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "old-default" }],
    };

    client.emitHello({
      type: "hello-ok",
      protocol: 4,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "new-default",
          mainKey: "main",
          mainSessionKey: "agent:new-default:main",
        },
      },
      auth: { role: "operator", scopes: [] },
    });

    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));
    expect(appRouterRevalidateMock).not.toHaveBeenCalled();

    agentsList.resolve();
    await vi.waitFor(() => expect(appRouterRevalidateMock).toHaveBeenCalledWith(host));
    expect(host.sessionKey).toBe("agent:new-default:main");
    expect(appRouterRevalidateMock).toHaveBeenCalledTimes(1);
  });

  it("waits for agents.list before refreshing selected-global chat", async () => {
    const agentsList = createDeferred();
    const { host, client } = connectHost("chat");
    loadAgentsMock.mockImplementationOnce(async () => {
      await agentsList.promise;
      host.agentsList = {
        defaultId: "new-default",
        mainKey: "main",
        scope: "global",
        agents: [{ id: "new-default" }],
      };
    });
    host.sessionKey = "global";
    host.assistantAgentId = "old-default";
    host.agentsList = {
      defaultId: "old-default",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "old-default" }],
    };

    client.emitHello({
      type: "hello-ok",
      protocol: 4,
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "new-default",
          mainKey: "main",
          mainSessionKey: "agent:new-default:main",
        },
      },
      auth: { role: "operator", scopes: [] },
    });

    await vi.waitFor(() => expect(loadAgentsMock).toHaveBeenCalledWith(host));
    expect(appRouterRevalidateMock).not.toHaveBeenCalled();

    agentsList.resolve();
    await vi.waitFor(() => expect(appRouterRevalidateMock).toHaveBeenCalledWith(host));
    expect(host.sessionKey).toBe("global");
    expect(appRouterRevalidateMock).toHaveBeenCalledTimes(1);
  });

  it("lets the active chat refresh own avatar loading on initial chat hello", async () => {
    const { host, client } = connectHost("chat");

    client.emitHello();

    await vi.waitFor(() =>
      expect(refreshChatMock).toHaveBeenCalledWith(host, { awaitHistory: true, startup: true }),
    );
    expect(refreshChatAvatarMock).not.toHaveBeenCalled();
  });

  it("still preloads the chat avatar when connecting outside the chat tab", async () => {
    const { host, client } = connectHost("overview");

    client.emitHello();

    await vi.waitFor(() => expect(appRouterRevalidateMock).toHaveBeenCalledWith(host));
    expect(refreshChatAvatarMock).toHaveBeenCalledWith(host);
  });

  it("lets the active tab refresh own node and device loading after hello", async () => {
    const { host, client } = connectHost("overview");

    client.emitHello();

    await vi.waitFor(() => expect(appRouterRevalidateMock).toHaveBeenCalledWith(host));
    expect(loadNodesMock).not.toHaveBeenCalled();
    expect(loadDevicesMock).not.toHaveBeenCalled();
  });
});
