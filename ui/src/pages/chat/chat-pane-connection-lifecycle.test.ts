// Keep the registered pane class on this file's module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-connection-lifecycle.test/"} */
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { applySelectedChatAgent } from "./chat-state-refresh.ts";
import * as chatThread from "./components/chat-thread-interactions.ts";
import { scheduleChatScroll } from "./scroll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  chatThread.resetThreadPresentation();
  window.localStorage.removeItem("openclaw:skip-rewind-confirm");
  vi.unstubAllGlobals();
});

describe("chat pane connection lifecycle", () => {
  it("notifies the owning shell after a pane leaves its DOM subtree", async () => {
    const { pane } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const lifecycle = pane as TestChatPane & {
      render: () => unknown;
      readonly conversationPresented: boolean;
    };
    lifecycle.render = () => null;
    const shell = document.createElement("openclaw-app-shell");
    const presentations: Array<{ paneCount: number; conversationPresented: boolean }> = [];
    shell.addEventListener("openclaw-chat-pane-lifecycle-changed", () => {
      presentations.push({
        paneCount: shell.querySelectorAll("openclaw-chat-pane").length,
        conversationPresented: lifecycle.conversationPresented,
      });
    });
    shell.append(pane);
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await lifecycle.updateComplete;
    pane.remove();
    ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);

    expect(presentations).toEqual([
      { paneCount: 1, conversationPresented: false },
      { paneCount: 1, conversationPresented: true },
      { paneCount: 0, conversationPresented: false },
    ]);
  });

  it("renders once while initially hidden, then reconciles hidden invalidations", async () => {
    let visibilityState: DocumentVisibilityState = "hidden";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibilityState);
    const { pane, requestUpdate, state } = createTestChatPane({
      client: { request: vi.fn() } as unknown as GatewayBrowserClient,
      sessions: {} as SessionCapability,
    });
    const lifecycle = pane as TestChatPane & {
      performUpdate: () => void;
      hasUpdated: boolean;
      render: () => unknown;
      requestUpdate: () => void;
    };
    lifecycle.render = () => null;
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await vi.waitFor(() => expect(lifecycle.hasUpdated).toBe(true), { interval: 1, timeout: 50 });
    await lifecycle.updateComplete;
    const performUpdate = vi.spyOn(lifecycle, "performUpdate");
    const cancelAnimationFrame = vi.spyOn(globalThis, "cancelAnimationFrame");

    state.chatStreamRenderFrame = 7;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(state.chatStreamRenderFrame).toBeNull();
    expect(requestUpdate).toHaveBeenCalledOnce();
    lifecycle.requestUpdate();
    lifecycle.requestUpdate();
    await Promise.resolve();
    expect(performUpdate).not.toHaveBeenCalled();

    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await lifecycle.updateComplete;
    expect(performUpdate).toHaveBeenCalledOnce();

    const addVisibilityListener = vi.spyOn(document, "addEventListener");
    const removeVisibilityListener = vi.spyOn(document, "removeEventListener");
    visibilityState = "hidden";
    lifecycle.requestUpdate();
    await Promise.resolve();
    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
    ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
    expect(removeVisibilityListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: true });
    ChatPaneBase.prototype.connectedCallback.call(lifecycle);
    await Promise.resolve();
    visibilityState = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await lifecycle.updateComplete;
    expect(performUpdate).toHaveBeenCalledTimes(2);

    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
    ChatPaneBase.prototype.disconnectedCallback.call(lifecycle);
    addVisibilityListener.mockClear();
    lifecycle.requestUpdate();
    await lifecycle.updateComplete;
    expect(addVisibilityListener).not.toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  it("fully tears down realtime Talk when the gateway disconnects", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture(),
    });
    const stop = vi.fn(() => {
      expect(state.realtimeTalkSession).toBeNull();
    });
    state.realtimeTalkSession = { stop } as unknown as ChatPageHost["realtimeTalkSession"];
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "listening";
    state.realtimeTalkDetail = "live";
    state.realtimeTalkInputLevel.set(0.7);
    state.realtimeTalkConversation = [
      { id: "utterance", role: "user", text: "stale", isStreaming: true },
    ];
    state.realtimeTalkVideoStream = {} as MediaStream;
    state.realtimeTalkCameraDevices = [{ deviceId: "camera", label: "Camera" }];
    state.realtimeTalkVideoCapable = true;
    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = true;

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      phase: "reconnecting",
      hello: null,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(state.realtimeTalkActive).toBe(false);
    expect(state.realtimeTalkStatus).toBe("idle");
    expect(state.realtimeTalkDetail).toBeNull();
    expect(state.realtimeTalkInputLevel.value).toBe(0);
    expect(state.realtimeTalkConversation).toEqual([]);
    expect(state.realtimeTalkVideoStream).toBeNull();
    expect(state.realtimeTalkCameraDevices).toEqual([]);
    expect(state.realtimeTalkVideoCapable).toBe(false);
    expect(state.realtimeTalkVideoPending).toBe(false);
    expect(state.realtimeTalkCameraError).toBe(false);
  });

  it("advances session ownership once per same-client connection transition", async () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture(),
    });
    const initialGeneration = pane.connectionGeneration;
    const snapshot = { ...pane.context.gateway.snapshot, client };

    state.chatLoading = true;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });

    expect(pane.connectionGeneration).toBe(initialGeneration + 1);
    expect(state.connectionEpoch).toBe(initialGeneration + 1);
    expect(state.chatLoading).toBe(false);

    state.chatLoading = true;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });

    expect(pane.connectionGeneration).toBe(initialGeneration + 1);
    expect(state.connectionEpoch).toBe(initialGeneration + 1);
    expect(state.chatLoading).toBe(true);

    pane.connectedClient = client;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });

    expect(pane.connectionGeneration).toBe(initialGeneration + 2);
    expect(state.connectionEpoch).toBe(initialGeneration + 2);
    await vi.waitFor(() => expect(state.chatLoading).toBe(false));

    state.chatLoading = true;
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });

    expect(pane.connectionGeneration).toBe(initialGeneration + 2);
    expect(state.connectionEpoch).toBe(initialGeneration + 2);
    expect(state.chatLoading).toBe(true);
  });

  it("cancels scroll work owned by the prior Gateway connection", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture(),
    });
    const cancelCommit = vi.fn();
    state.renderLifecycle.afterCommit = () => cancelCommit;
    scheduleChatScroll(state);

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(cancelCommit).toHaveBeenCalledOnce();
  });

  it("retires pending model selection state when the Gateway owner changes", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const retireModelOverride = vi.fn();
    const sessions = createSessionCapabilityFixture({ retireModelOverride });
    const { pane, state } = createTestChatPane({ client, sessions });
    state.sessionKey = "global";
    state.chatModelSwitchPromises = {
      global: new Promise<boolean>(() => {}),
    };

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.chatModelSwitchPromises).toEqual({});
    expect(retireModelOverride).toHaveBeenCalledWith("global");
  });

  it("discards Guardian and system notices when Gateway ownership changes", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture(),
    });
    state.guardianNotices = [
      {
        key: "guardian:old-run:review:denied",
        runId: "old-run",
        timestamp: 1,
        kind: "denied",
        command: "private command",
      },
    ];

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.guardianNotices).toEqual([]);
  });

  it("releases sending state when the Gateway owner changes", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture(),
    });
    state.chatSending = true;
    state.chatSendingScopeKey = "agent:main";

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "reconnecting",
      hello: null,
    });

    expect(state.chatSending).toBe(false);
    expect(state.chatSendingScopeKey).toBeNull();
  });

  it.each([
    { sessionKey: "agent:work:main", mainKey: "main" },
    { sessionKey: "agent:work:home", mainKey: "home" },
  ])(
    "preserves owner-qualified model and identity state when global selection changes for $sessionKey",
    ({ sessionKey, mainKey }) => {
      const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
      const retireModelOverride = vi.fn();
      const sessions = { retireModelOverride } as unknown as SessionCapability;
      const { state } = createTestChatPane({ client, sessions });
      state.sessionKey = sessionKey;
      state.agentsList = { defaultId: "main", mainKey, scope: "global", agents: [] };
      state.assistantAgentId = "work";
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      state.chatModelSwitchPromises = {
        global: new Promise<boolean>(() => {}),
      };
      const pending = state.chatModelSwitchPromises;
      applySelectedChatAgent(state, "main");
      expect(state.chatModelSwitchPromises).toBe(pending);
      expect(state.assistantAgentId).toBe("work");
      expect(retireModelOverride).not.toHaveBeenCalled();
      expect(state.loadAssistantIdentity).not.toHaveBeenCalled();
    },
  );

  it("refreshes the transcript before secondary hydration after a same-client reconnect", () => {
    const request = vi.fn(() => new Promise<never>(() => {}));
    const client = {
      request,
    } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client });
    const deferHydration = vi.spyOn(pane, "deferSessionHydrationUntilTranscript");
    state.connected = false;
    pane.connectedClient = client;

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "connected",
    });

    expect(request).toHaveBeenCalledWith(
      "chat.startup",
      expect.objectContaining({ limit: 80, maxBytes: 256 * 1024, sessionKey: state.sessionKey }),
      { signal: expect.any(AbortSignal) },
    );
    expect(deferHydration).toHaveBeenCalledWith(state.sessionKey, expect.any(Promise));
  });

  it("replays a pending exact-run stop when the gateway reconnects", async () => {
    const request = vi.fn((method: string) =>
      method === "chat.abort" ? Promise.resolve({ aborted: true }) : new Promise<never>(() => {}),
    );
    const client = { request } as unknown as GatewayBrowserClient;
    const { pane, state } = createTestChatPane({ client });
    const sessionKey = "agent:main";
    pane.context = {
      ...pane.context,
      config: {
        current: {
          assistantIdentity: { name: "Assistant" },
          terminalEnabled: false,
        },
      },
    } as unknown as ApplicationContext;
    state.loadAssistantIdentity = vi.fn(async () => {});
    state.realtimeTalkInputLevel = {
      set: vi.fn(),
    } as unknown as ChatPageHost["realtimeTalkInputLevel"];
    state.resetToolStream = vi.fn();
    const snapshot = {
      ...pane.context.gateway.snapshot,
      client,
      assistantAgentId: "main",
    };

    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    state.pendingAbort = { sourceClient: client, runId: "run-main", sessionKey };

    pane.applyGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: { role: "operator", scopes: ["operator.write"] },
        features: { methods: ["chat.abort"] },
      },
    });

    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith("chat.abort", {
        sessionKey,
        runId: "run-main",
      }),
    );
    expect(state.pendingAbort).toBeNull();

    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
    expect(request.mock.calls.filter(([method]) => method === "chat.abort")).toHaveLength(1);
  });
});
