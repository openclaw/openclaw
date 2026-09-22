import { onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createTestSessionCapability } from "../../lib/sessions/session-capability.test-support.ts";
import type { ChatPage } from "./chat-page.ts";

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

export function setNavigationContext(page: ChatPage) {
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
  (page as unknown as { context: ApplicationContext }).context = context;
  return { chatAttachmentHandoff, context, navigate, replace, setAgent, patch };
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
