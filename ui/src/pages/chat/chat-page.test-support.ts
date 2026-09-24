import { onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
} from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import type { ChatPage } from "./chat-page.ts";
import type { ChatSplitLayout } from "./split-layout-types.ts";
import { insertPane } from "./split-layout.ts";

export function createChatPageSessions(
  gateway: Parameters<typeof createTestSessionCapability>[0] = {
    snapshot: { client: null, phase: "stopped", hello: null },
    subscribe: () => () => undefined,
    subscribeEvents: () => () => undefined,
  },
) {
  const sessions = createTestSessionCapability(gateway);
  onTestFinished(() => sessions.dispose());
  return sessions;
}

export function createChatPageNavigationContext() {
  const navigate = vi.fn();
  const replace = vi.fn();
  const patch = vi.fn(async () => null);
  const agentSelectionState = { selectedId: "main" };
  const setAgent = vi.fn((agentId: string) => {
    agentSelectionState.selectedId = agentId;
  });
  const chatAttachmentHandoff = {
    prepare: vi.fn(),
    consume: vi.fn(() => null),
    clearPane: vi.fn(),
    dispose: vi.fn(),
  };
  const context = {
    basePath: "",
    sessions: { ...createChatPageSessions(), patch },
    chatSubmissions: createChatSubmissions(),
    placementStartup: { get: vi.fn(() => null), subscribe: () => () => undefined },
    agents: { state: { agentsList: { defaultId: "main", mainKey: "main" } } },
    gateway: {
      snapshot: { hello: null },
      setSessionKey: vi.fn(),
      subscribe: () => () => undefined,
    },
    navigate,
    replace,
    agentSelection: { state: agentSelectionState, set: setAgent },
    chatAttachmentHandoff,
  } as unknown as ApplicationContext;
  return { chatAttachmentHandoff, context, navigate, replace, setAgent, patch };
}

export function setNavigationContext(page: ChatPage) {
  const navigation = createChatPageNavigationContext();
  (page as unknown as { context: ApplicationContext }).context = navigation.context;
  return navigation;
}

export function setViewerPresenceContext(page: ChatPage) {
  const navigation = setNavigationContext(page);
  const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ sessionKeys: [] });
  const client = { request } as unknown as GatewayBrowserClient;
  const hello = {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [] },
    features: { methods: ["sessions.viewers.set"] },
    snapshot: { sessionDefaults: { mainSessionKey: "agent:main:main" } },
  } as GatewayHelloOk;
  const snapshotListeners = new Set<(snapshot: ApplicationGatewaySnapshot) => void>();
  (navigation.context as unknown as { gateway: ApplicationContext["gateway"] }).gateway = {
    snapshot: {
      client,
      phase: "connected",
      offlineStable: false,
      hello,
      canvasPluginSurfaceUrl: null,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
      lastError: null,
      lastErrorCode: null,
    },
    connection: { gatewayUrl: "ws://example.test", token: "", bootstrapToken: "", password: "" },
    connectionRevision: 0,
    eventLog: [],
    eventLogRevision: 0,
    connect: vi.fn(),
    setSessionKey: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: (listener) => {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    subscribeEventLog: () => () => {},
    subscribeEvents: () => () => {},
  };
  Object.assign(navigation.context, {
    sessions: createChatPageSessions(navigation.context.gateway),
  });
  return { ...navigation, request };
}

export function createSessionTitleSource() {
  const listeners = new Set<() => void>();
  const state: {
    result: { sessions: Array<{ key: string; displayName?: string }> } | null;
  } = { result: null };
  return {
    sessions: {
      ...createChatPageSessions(),
      state,
      presentation: state,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    listeners,
    publish(key: string, displayName: string) {
      state.result = { sessions: [{ key, displayName }] };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

export function createSplitLayout(sessionKey: string): ChatSplitLayout {
  const singlePane: ChatSplitLayout = {
    columns: [{ id: "c1", panes: [{ id: "p1", sessionKey }], paneWeights: [1] }],
    columnWeights: [1],
    activePaneId: "p1",
  };
  return insertPane(singlePane, "p1", sessionKey, "right");
}

export function setLayout(page: ChatPage, layout: ChatSplitLayout | undefined) {
  (page as unknown as { layout: ChatSplitLayout | undefined }).layout = layout;
}

export function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

export function createChatPageStateContext() {
  const { gateway, publish } = createGatewayHarness(createTestGatewayClient(vi.fn()));
  publish(false, null);
  return {
    agents: {
      state: { agentsList: null },
      ensureList: vi.fn(async () => null),
    },
    agentSelection: { state: { selectedId: "main" } },
    basePath: "",
    config: {
      current: {
        allowExternalEmbedUrls: false,
        assistantIdentity: { name: "Assistant" },
        embedSandboxMode: "scripts",
      },
    },
    gateway,
    chatSubmissions: createChatSubmissions(),
    sessions: {},
  } as unknown as ApplicationContext;
}
