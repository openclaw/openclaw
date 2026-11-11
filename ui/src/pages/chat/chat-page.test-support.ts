import { createRouter } from "@openclaw/uirouter";
import { flush } from "solid-js";
import { onTestFinished, vi } from "vitest";
import { registerListener } from "../../../../src/shared/listeners.ts";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ApplicationContext } from "../../app/context.ts";
import {
  createApplicationGateway,
  createApplicationGatewaySnapshot,
} from "../../test-helpers/application-context-fixtures.ts";
import { createChatPageSessions } from "./chat-page-sessions.test-support.ts";
import { insertPane, singlePaneLayout } from "./split-layout.ts";
import "./chat-page.tsx";

export function createChatPageNavigationContext() {
  const router = createRouter({ routes: [] });
  onTestFinished(() => router.stop());
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
    router,
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

export function setNavigationContext(page: HTMLElementTagNameMap["openclaw-chat-page"]) {
  const navigation = createChatPageNavigationContext();
  (page as unknown as { context: ApplicationContext }).context = navigation.context;
  return navigation;
}

export function setViewerPresenceContext(page: HTMLElementTagNameMap["openclaw-chat-page"]) {
  const navigation = setNavigationContext(page);
  const request = vi.fn<GatewayBrowserClient["request"]>().mockResolvedValue({ sessionKeys: [] });
  const client = { request } as unknown as GatewayBrowserClient;
  const hello: GatewayHelloOk = {
    type: "hello-ok",
    protocol: 1,
    auth: { role: "operator", scopes: [] },
    features: { methods: ["sessions.viewers.set"] },
    snapshot: {
      sessionDefaults: {
        defaultAgentId: "main",
        mainKey: "main",
        mainSessionKey: "agent:main:main",
      },
    },
  };
  const { gateway } = createApplicationGateway(
    createApplicationGatewaySnapshot({
      client,
      phase: "connected",
      hello,
      assistantAgentId: "main",
      sessionKey: "agent:main:main",
    }),
  );
  Object.assign(navigation.context, {
    gateway: Object.assign(gateway, { setSessionKey: vi.fn() }),
  });
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
      subscribe: (listener: () => void) => registerListener(listeners, listener),
    },
    listeners,
    publish(key: string, displayName: string) {
      state.result = { sessions: [{ key, displayName }] };
      listeners.forEach((listener) => listener());
    },
  };
}

export function createSplitLayout(sessionKey: string) {
  return insertPane(singlePaneLayout("c1", "p1", sessionKey), "p1", sessionKey, "right");
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

/** Settles the bridge and the page-owned Solid projection without a browser timer. */
export async function settleChatPage(
  page: HTMLElementTagNameMap["openclaw-chat-page"],
): Promise<void> {
  await page.updateComplete;
  flush();
  await Promise.resolve();
  flush();
}

export async function showSession(
  page: HTMLElementTagNameMap["openclaw-chat-page"],
  sessionKey: string,
): Promise<void> {
  page.data = { sessionKey };
  await settleChatPage(page);
  await settleChatPage(page);
}
