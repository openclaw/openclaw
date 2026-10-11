// Keep the registered pane class on this file's module graph.
import { afterEach, describe, expect, it, vi } from "vitest";
/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-connection-lifecycle.test/"} */
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { applyChatAgentsList, loadChatHistory } from "./chat-history.ts";
import { makeRequestMock } from "./chat-host.test-support.ts";
import { ChatPaneBase } from "./chat-pane-base.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { applySelectedChatAgent } from "./chat-state-refresh.ts";
import * as chatThread from "./components/chat-thread-interactions.ts";
import type { AfterCommitEffect } from "./render-lifecycle.ts";
import { handleAbortChat, replayPendingChatAbort } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  chatThread.resetThreadPresentation();
  window.localStorage.removeItem("openclaw:skip-rewind-confirm");
  document.documentElement.removeAttribute("data-openclaw-remote-ingress");
  vi.unstubAllGlobals();
});

function createReconnectRequest(startup: ChatHistoryResult | Promise<ChatHistoryResult>) {
  return makeRequestMock({
    "chat.startup": startup,
    "agents.list": {
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main" }],
    },
    "chat.metadata": { commands: [] },
    "models.list": { models: [] },
    "models.authStatus": { ts: 1, providers: [] },
    "sessions.branches.list": { branches: [] },
    "sessions.subscribe": { subscribed: true },
    "sessions.list": sessionsResult([], 0),
    "sessions.messages.subscribe": (params: { key: string }) => ({ key: params.key }),
    "question.list": { questions: [] },
    "taskSuggestions.list": { suggestions: [] },
    "sessions.companion.state": { exchanges: [] },
  });
}

function disconnect(pane: TestChatPane) {
  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    phase: "reconnecting",
    hello: null,
  });
}

describe("chat pane connection lifecycle", () => {
  it("keeps the initial transcript pending while the first client connects", async () => {
    const client = createTestGatewayClient(createReconnectRequest({ messages: [] }));
    const { pane, state } = createTestChatPane({ client });
    state.connected = false;
    state.client = null;
    await loadChatHistory(state, { startup: true });
    expect(state.chatLoading).toBe(true);

    pane.applyGatewaySnapshot({
      ...pane.context.gateway.snapshot,
      client,
      phase: "connecting",
      hello: null,
    });

    expect(chatHistoryRequests(state).historyLoad.phase).toBe("pending-connection");
    expect(state.chatLoading).toBe(true);
  });

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

  it("retires connection-owned work and fully tears down realtime Talk on disconnect", () => {
    const client = { request: vi.fn() } as unknown as GatewayBrowserClient;
    const retireModelOverride = vi.fn();
    const { pane, state } = createTestChatPane({
      client,
      sessions: createSessionCapabilityFixture({ retireModelOverride }),
    });
    state.sessionKey = "global";
    state.chatModelSwitchPromises = { global: new Promise<boolean>(() => {}) };
    state.chatSending = true;
    state.chatSendingScopeKey = "agent:main";
    state.guardianNotices = [
      {
        key: "guardian:old-run:review:denied",
        runId: "old-run",
        timestamp: 1,
        kind: "denied",
        command: "private command",
      },
    ];
    const cancelCommit = vi.fn();
    state.renderLifecycle.afterCommit = () => cancelCommit;
    scheduleChatScroll(state);
    const stop = vi.fn(() => {
      expect(state.realtimeTalkSession).toBeNull();
    });
    state.realtimeTalkSession = { stop } as unknown as ChatPageHost["realtimeTalkSession"];
    state.realtimeTalkActive = true;
    state.realtimeTalkStatus = "listening";
    state.realtimeTalkDetail = "live";
    state.realtimeTalkInputLevel.set(0.7);
    state.realtimeTalkConversationState.entries = [
      { id: "utterance", role: "user", text: "stale", isStreaming: true },
    ];
    state.realtimeTalkVideoStream = {} as MediaStream;
    state.realtimeTalkCameraDevices = [{ deviceId: "camera", label: "Camera" }];
    state.realtimeTalkVideoCapable = true;
    state.realtimeTalkVideoPending = true;
    state.realtimeTalkCameraError = true;

    disconnect(pane);

    expect(cancelCommit).toHaveBeenCalledOnce();
    expect(state.chatModelSwitchPromises).toEqual({});
    expect(retireModelOverride).toHaveBeenCalledWith("global");
    expect(state.guardianNotices).toEqual([]);
    expect(state.chatSending).toBe(false);
    expect(state.chatSendingScopeKey).toBeNull();
    expect(stop).toHaveBeenCalledOnce();
    expect(state.realtimeTalkActive).toBe(false);
    expect(state.realtimeTalkStatus).toBe("idle");
    expect(state.realtimeTalkDetail).toBeNull();
    expect(state.realtimeTalkInputLevel.value).toBe(0);
    expect(state.realtimeTalkConversationState.entries).toEqual([]);
    expect(state.realtimeTalkVideoStream).toBeNull();
    expect(state.realtimeTalkCameraDevices).toEqual([]);
    expect(state.realtimeTalkVideoCapable).toBe(false);
    expect(state.realtimeTalkVideoPending).toBe(false);
    expect(state.realtimeTalkCameraError).toBe(false);
  });

  it("preserves owner-qualified model and identity state when global selection changes", () => {
    const client = { request: vi.fn(async () => ({})) } as unknown as GatewayBrowserClient;
    const retireModelOverride = vi.fn();
    const sessions = { retireModelOverride } as unknown as SessionCapability;
    const { state } = createTestChatPane({ client, sessions });
    state.sessionKey = "agent:work:home";
    state.agentsList = { defaultId: "main", mainKey: "home", scope: "global", agents: [] };
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
  });

  it.each([
    { surface: "direct", remoteIngress: false },
    { surface: "ingress", remoteIngress: true },
  ])(
    "refreshes the transcript before secondary hydration after a $surface reconnect",
    async ({ remoteIngress }) => {
      if (remoteIngress) {
        document.documentElement.setAttribute("data-openclaw-remote-ingress", "true");
      }
      const transcript = createDeferred<{
        messages: [];
        sessionId: string;
        sessionInfo: { key: string; sessionId: string; kind: "direct"; updatedAt: number };
      }>();
      const request = createReconnectRequest(transcript.promise);
      const client = createTestGatewayClient(request);
      const { pane, state } = createTestChatPane({ client });
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      const deferHydration = vi.spyOn(pane, "deferSessionHydrationUntilTranscript");
      const branches = vi.spyOn(state.sessions, "listBranches");
      const commitEffects: AfterCommitEffect[] = [];
      state.renderLifecycle.afterCommit = (effect) => {
        commitEffects.push(effect);
        return () => undefined;
      };
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        callback(0);
        return 1;
      });
      const hello = sessionMutationGatewayHello(["operator.read", "operator.write"]);
      const snapshot = {
        ...pane.context.gateway.snapshot,
        client,
        hello: {
          ...hello,
          features: { methods: [...(hello.features?.methods ?? []), "question.list"] },
        },
      };
      const initialGeneration = pane.connectionGeneration;

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
      expect(state.connected).toBe(false);
      expect(pane.connectedClient).toBeNull();
      pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
      expect(pane.connectionGeneration).toBe(initialGeneration + 2);
      expect(state.connectionEpoch).toBe(initialGeneration + 2);
      state.chatLoading = true;
      pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
      expect(pane.connectionGeneration).toBe(initialGeneration + 2);
      expect(state.connectionEpoch).toBe(initialGeneration + 2);
      expect(state.chatLoading).toBe(true);

      await expect(chatHistoryRequests(state).subscriptionReady).resolves.toBe(true);
      expect(request.mock.calls.filter(([method]) => method === "chat.startup")).toHaveLength(1);
      expect(request.mock.calls.filter(([method]) => method === "question.list")).toHaveLength(
        remoteIngress ? 0 : 1,
      );
      expect(request).toHaveBeenCalledWith(
        "chat.startup",
        expect.objectContaining({ limit: 80, maxBytes: 256 * 1024, sessionKey: state.sessionKey }),
        { signal: expect.any(AbortSignal), timeoutMs: 30_000 },
      );
      expect(deferHydration).toHaveBeenCalledExactlyOnceWith(state.sessionKey, expect.any(Promise));
      expect(branches).not.toHaveBeenCalled();
      expect(commitEffects).toEqual([]);

      transcript.resolve({
        messages: [],
        sessionId: "reconnected-session",
        sessionInfo: {
          key: state.sessionKey,
          sessionId: "reconnected-session",
          kind: "direct",
          updatedAt: 1,
        },
      });
      await expect(deferHydration.mock.calls[0]![1]).resolves.toBe(true);
      expect(state.chatLoading).toBe(false);
      expect(branches).not.toHaveBeenCalled();
      expect(commitEffects.length).toBeGreaterThan(0);
      for (const effect of commitEffects) {
        effect(() => undefined);
      }
      expect(branches).toHaveBeenCalledOnce();
      await branches.mock.results[0]!.value;
      expect(request.mock.calls.filter(([method]) => method === "chat.startup")).toHaveLength(1);
      state.chatLoading = true;
      pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
      expect(pane.connectionGeneration).toBe(initialGeneration + 2);
      expect(state.connectionEpoch).toBe(initialGeneration + 2);
      expect(state.chatLoading).toBe(true);
    },
  );

  it.each([
    { mode: "online", outcome: "no-active-run", change: "default agent" },
    { mode: "queued", outcome: "failure", change: "main key" },
  ] as const)(
    "retires a $mode Stop's $outcome presentation after agents.list changes the $change",
    async ({ mode, outcome, change }) => {
      const response = createDeferred<unknown>();
      const request = vi.fn(() => response.promise);
      const client = createTestGatewayClient(request);
      const { state } = createTestChatPane({
        client,
        sessions: createSessionCapabilityFixture(),
      });
      const refreshCurrentChat = vi.fn(async () => {});
      state.refreshCurrentChat = refreshCurrentChat;
      state.sessionKey = "main";
      state.chatRunId = "original-run";
      state.assistantAgentId = "main";
      state.hello = {
        ...sessionMutationGatewayHello(),
        snapshot: {
          sessionDefaults: {
            defaultAgentId: "main",
            mainKey: "main",
            mainSessionKey: "agent:main:main",
          },
        },
      };
      let stopping: Promise<void | boolean> | undefined;
      try {
        if (mode === "queued") {
          state.connected = false;
          await handleAbortChat(state, { preserveDraft: true });
          expect(request).not.toHaveBeenCalled();
          expect(state.pendingAbort?.runId).toBe("original-run");
          state.connected = true;
        } else {
          stopping = handleAbortChat(state, { preserveDraft: true });
        }
        // The normal same-client producer publishes current roster defaults after Hello.
        applyChatAgentsList(
          state,
          {
            defaultId: change === "default agent" ? "work" : "main",
            mainKey: change === "main key" ? "home" : "main",
            scope: "per-sender",
            agents: [
              { id: "main", kind: "agent" },
              { id: "work", kind: "agent" },
            ],
          },
          client,
        );
        expect(state.sessionKey).toBe("main");
        expect(state.chatRunId).toBe("original-run");
        state.chatError = "Replacement scope warning";
        state.lastError = state.chatError;
        if (mode === "queued") {
          stopping = replayPendingChatAbort(state);
        }
        expect(request).toHaveBeenCalledExactlyOnceWith("chat.abort", {
          sessionKey: "main",
          runId: "original-run",
        });
        if (outcome === "failure") {
          response.reject(new Error("Previous Stop acknowledgement failed"));
        } else {
          response.resolve({ ok: true, aborted: false, runIds: [] });
        }
        await stopping;
        expect(refreshCurrentChat).not.toHaveBeenCalled();
        expect(state.chatError).toBe("Replacement scope warning");
        expect(state.lastError).toBe(state.chatError);
        expect(state.chatRunId).toBe("original-run");
        expect(request).toHaveBeenCalledOnce();
        if (mode === "queued") {
          expect(state.pendingAbort).toBeNull();
          await expect(replayPendingChatAbort(state)).resolves.toBe(false);
          expect(request).toHaveBeenCalledOnce();
        }
      } finally {
        response.resolve({ aborted: true });
        await stopping;
      }
    },
  );

  it("replays a pending exact-run stop when the gateway reconnects", async () => {
    const request = vi.fn((method: string) =>
      method === "chat.abort" ? Promise.resolve({ aborted: true }) : new Promise<never>(() => {}),
    );
    const client = createTestGatewayClient(request);
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
    state.sessionKey = sessionKey;
    state.chatRunId = "run-main";
    await handleAbortChat(state, { preserveDraft: true });

    pane.applyGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: {
        type: "hello-ok",
        protocol: 4,
        auth: {
          role: "operator",
          scopes: ["operator.write"],
          recoveryScope: "test-recovery-scope",
        },
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
