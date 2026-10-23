import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SessionSuggestionsListResult } from "../../../../packages/gateway-protocol/src/schema/sessions-suggestions.js";
/* @vitest-environment jsdom */
/* @vitest-environment-options {"url":"http://chat-pane-connection-lifecycle.test/"} */
import { GATEWAY_OWNER_PROFILE_ID } from "../../../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import * as draftStore from "../../lib/chat/composer-draft-store.runtime.ts";
import type { SessionCapability } from "../../lib/sessions/index.ts";
import { sessionsResult } from "../../lib/sessions/session-capability.test-support.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import type { ChatHistoryResult } from "./chat-history-snapshot.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { applyChatAgentsList, loadChatHistory } from "./chat-history.ts";
import { makeRequestMock, requestCalls } from "./chat-host.test-support.ts";
import {
  createSessionCapabilityFixture,
  createTestChatPane,
  connectPaneTestView,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { applySelectedChatAgent } from "./chat-state-refresh.ts";
import { createMessageGroupHarness } from "./components/chat-message-native.test-support.tsx";
import { createMessageGroup } from "./components/chat-message.test-support.ts";
import * as chatThread from "./components/chat-thread-interactions.ts";
import {
  getChatSessionProjection,
  reduceChatSessionProjection,
  setChatRunOwner,
  getChatRunOwner,
} from "./history-merge.ts";
import type { AfterCommitEffect } from "./render-lifecycle.ts";
import { handleAbortChat, replayPendingChatAbort } from "./run-lifecycle.ts";
import { scheduleChatScroll } from "./scroll.ts";
import { cacheChatSessionSnapshot, readChatMessagesFromCache } from "./session-message-cache.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  chatThread.resetThreadPresentation();
  window.localStorage.removeItem("openclaw:skip-rewind-confirm");
  document.documentElement.removeAttribute("data-openclaw-remote-ingress");
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

function reconnectPane(startup: ChatHistoryResult | Promise<ChatHistoryResult>) {
  const request = createReconnectRequest(startup);
  const client = createTestGatewayClient(request);
  return { request, client, ...createTestChatPane({ client }) };
}

function presentationPane() {
  const fixture = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });
  fixture.pane.render = () => ({
    layout: null,
    capabilityDialogs: undefined,
    providerReviewSource: undefined,
  });
  return fixture;
}

function trackVisibility(initial: DocumentVisibilityState) {
  let current = initial;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => current);
  return (next: DocumentVisibilityState) => {
    current = next;
    document.dispatchEvent(new Event("visibilitychange"));
  };
}

function disconnect(pane: TestChatPane) {
  pane.applyGatewaySnapshot({
    ...pane.context.gateway.snapshot,
    phase: "reconnecting",
    hello: null,
  });
}

describe("chat pane connection lifecycle", () => {
  it("adopts a persisted draft when recovery becomes ready without a transcript event", async () => {
    const text = "Saved draft from the previous tab";
    const request = createReconnectRequest({ messages: [], sessionId: "empty-session" });
    const client = createTestGatewayClient(request);
    let recoveryReady = false;
    Object.defineProperty(client, "recoveryScopeReady", { get: () => recoveryReady });
    const { pane, state } = createTestChatPane({ client });
    const scope = {
      gatewayOwner: state.settings.gatewayUrl,
      recoveryScope: "test-recovery-scope",
      scopeKey: `chat:v3:${state.sessionKey}\u0000agent:main`,
    };
    vi.spyOn(draftStore, "prepareDurableComposerRecovery").mockResolvedValue({
      status: "ready",
      entries: [],
    });
    const read = vi
      .spyOn(draftStore, "readDurableComposerDraft")
      .mockImplementation(async (target) =>
        target.gatewayOwner === scope.gatewayOwner &&
        target.recoveryScope === scope.recoveryScope &&
        target.scopeKey === scope.scopeKey
          ? { status: "found", draft: { text, revision: 7, writeId: "saved", attachments: [] } }
          : { status: "not-found", revision: 0 },
      );
    vi.spyOn(draftStore, "writeDurableComposerDraft").mockResolvedValue({ status: "persisted" });
    const published: string[] = [];
    const stop = pane.chatState.composerDraft.subscribe(() => {
      published.push(pane.chatState.composerDraft.read().draft);
    });
    onTestFinished(stop);
    pane.chatState.composerPersistence.start();
    pane.connectedClient = null;
    const startup = vi.spyOn(pane, "deferSessionHydrationUntilTranscript");
    const snapshot = pane.context.gateway.snapshot;

    try {
      pane.applyGatewaySnapshot(snapshot);
      await startup.mock.calls[0]![1];
      expect(state).toMatchObject({ chatMessages: [], chatMessage: "" });
      expect(read).not.toHaveBeenCalled();

      recoveryReady = true;
      pane.applyGatewaySnapshot(snapshot);

      await waitForSolid(() => {
        expect(state.chatMessage).toBe(text);
        expect(published).toContain(text);
      });
      expect(state.chatMessages).toEqual([]);
    } finally {
      pane.chatState.composerPersistence.stop();
    }
  });

  it.each(["main", "research"])(
    "loads %s suggestions once when startup and session projection share a target",
    async (agentId) => {
      const listed = createDeferred<SessionSuggestionsListResult>();
      const fallback = createReconnectRequest({ messages: [], sessionId: "suggestion-session" });
      const row = {
        key: `agent:${agentId}:current`,
        kind: "direct" as const,
        sessionId: "suggestion-session",
        updatedAt: 1,
      };
      const request = vi.fn((...args: Parameters<GatewayBrowserClient["request"]>) => {
        if (args[0] === "session.suggestions.list") {
          return listed.promise;
        }
        if (args[0] === "sessions.list") {
          return Promise.resolve(sessionsResult([row], 1));
        }
        if (args[0] === "sessions.describe") {
          return Promise.resolve({ session: row });
        }
        return fallback(...args);
      });
      const { pane, state, sessions } = createTestChatPane({
        client: createTestGatewayClient(request),
      });
      await sessions.refresh({ agentId: "main" });
      state.sessionKey = row.key;
      pane.sessionKey = row.key;
      state.sessionsResult = sessions.state.result;
      state.sessionsResultAgentId = "main";
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      pane.connectedClient = null;
      const snapshot = pane.context.gateway.snapshot;
      const connected = {
        ...snapshot,
        hello: {
          ...snapshot.hello!,
          snapshot: {
            presence: [
              { ts: 0, user: { id: "owner" } },
              { ts: 0, user: { id: "alice" } },
            ],
          },
        },
      };

      pane.applyGatewaySnapshot(connected);
      pane.applySessionsState(sessions.state);
      listed.resolve({ suggestions: [], role: "owner" });
      await pane.sessionSuggestionsRefreshPromise;
      expect(requestCalls(request, "session.suggestions.list")).toHaveLength(1);
      await pane.refreshSessionSuggestions();
      expect(requestCalls(request, "session.suggestions.list")).toHaveLength(2);

      pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting", hello: null });
      pane.applyGatewaySnapshot(connected);
      pane.applySessionsState(sessions.state);
      await pane.sessionSuggestionsRefreshPromise;
      expect(requestCalls(request, "session.suggestions.list")).toHaveLength(3);
    },
  );

  it.each(["reconnect", "auth change", "authenticated owner", "pane disposal"])(
    "retires pairing QR credentials on %s without losing canonical history",
    async (transition) => {
      const text = { type: "text", text: "Scan this QR code with the OpenClaw iOS app:" };
      const canonical = {
        role: "assistant",
        content: [text],
        __openclaw: { id: "pairing-reply", seq: 1, runId: "pairing-run" },
      };
      const live = {
        ...canonical,
        content: [
          text,
          {
            type: "openclaw_pairing_qr",
            image_url: "data:image/png;base64,cGFpcmluZy1maXh0dXJl",
            expiresAtMs: Date.now() + 60_000,
            sensitive: true,
          },
        ],
      };
      const { client, pane, state } = reconnectPane({
        messages: [canonical],
        sessionId: "pairing-session",
      });
      state.loadAssistantIdentity = vi.fn(async () => undefined);
      const hello = sessionMutationGatewayHello();
      pane.context.gateway.snapshot.selfUser = { id: "fixture-user-before" };
      const connected = {
        ...pane.context.gateway.snapshot,
        client,
        phase: "connected" as const,
        hello: { ...hello, auth: { ...hello.auth, deviceToken: "fixture-token-before" } },
      };
      pane.applyGatewaySnapshot(connected);
      state.currentSessionId = "pairing-session";
      reduceChatSessionProjection(state, { type: "messagePersisted", message: live });
      reduceChatSessionProjection(state, {
        type: "runTerminal",
        runId: "pairing-run",
        status: "completed",
        message: live,
      });
      setChatRunOwner(state, "pairing-run");
      const runBefore = getChatSessionProjection(state).runs["pairing-run"];
      const view = document.createElement("div");
      const messageView = createMessageGroupHarness(view);
      onTestFinished(() => messageView.unmount());
      const renderReply = () => {
        messageView.render(
          createMessageGroup(state.chatMessages[0], "assistant", { key: "pairing-reply" }),
          {
            showReasoning: false,
            showToolCalls: false,
            assistantName: "OpenClaw",
            assistantAvatar: null,
          },
        );
      };
      renderReply();
      await vi.dynamicImportSettled();
      await waitForSolid(() =>
        expect(view.querySelector(".chat-message-image")?.getAttribute("src")).toBe(
          "data:image/png;base64,cGFpcmluZy1maXh0dXJl",
        ),
      );
      const cached = {
        messages: [live],
        sessionId: "pairing-session",
        pagination: { hasMore: false as const },
      };
      const target = { sessionKey: state.sessionKey };
      const otherTarget = { sessionKey: "agent:main:other" };
      cacheChatSessionSnapshot(state.chatMessagesBySession, state, target, cached);
      cacheChatSessionSnapshot(state.chatMessagesBySession, state, otherTarget, {
        ...cached,
        messages: [canonical],
      });

      if (transition === "reconnect") {
        pane.applyGatewaySnapshot({ ...connected, phase: "reconnecting", hello: null });
      } else if (transition === "pane disposal") {
        pane.disconnectedCallback();
      } else if (transition === "authenticated owner") {
        pane.context.gateway.snapshot.selfUser = { id: "fixture-user-after" };
        pane.applyGatewaySnapshot({
          ...connected,
          selfUser: pane.context.gateway.snapshot.selfUser,
        });
      } else {
        pane.applyGatewaySnapshot({
          ...connected,
          hello: { ...hello, auth: { ...hello.auth, deviceToken: "fixture-token-after" } },
        });
      }

      expect(state.chatMessages).toEqual([canonical]);
      renderReply();
      expect(view.querySelector(".chat-message-image")).toBeNull();
      expect(view.textContent).toContain(text.text);
      expect(getChatSessionProjection(state).runs["pairing-run"]).toEqual({
        ...runBefore,
        message: canonical,
      });
      expect(getChatRunOwner(state)).toBe("pairing-run");
      expect(readChatMessagesFromCache(state.chatMessagesBySession, state, target)).toEqual([]);
      expect(readChatMessagesFromCache(state.chatMessagesBySession, state, otherTarget)).toEqual([
        canonical,
      ]);
      if (transition === "reconnect") {
        pane.applyGatewaySnapshot(connected);
      }
      if (transition !== "pane disposal") {
        await loadChatHistory(state, { startup: true });
        expect(state.chatMessages).toEqual([canonical]);
        renderReply();
        expect(view.querySelector(".chat-message-image")).toBeNull();
      }
    },
  );

  it("keeps the initial transcript pending while the first client connects", async () => {
    const { client, pane, state } = reconnectPane({ messages: [] });
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
    const { pane } = presentationPane();
    const lifecycle = pane as TestChatPane & { readonly conversationPresented: boolean };
    const shell = document.createElement("openclaw-app-shell");
    const presentations: Array<{ paneCount: number; conversationPresented: boolean }> = [];
    shell.addEventListener("openclaw-chat-pane-lifecycle-changed", () => {
      presentations.push({
        paneCount: shell.querySelectorAll("openclaw-chat-runtime-test").length,
        conversationPresented: lifecycle.conversationPresented,
      });
    });
    shell.append(pane.element);
    connectPaneTestView(pane);
    await pane.updateComplete;
    pane.remove();
    pane.disconnectedCallback();

    expect(presentations).toEqual([
      { paneCount: 1, conversationPresented: false },
      { paneCount: 1, conversationPresented: true },
      { paneCount: 0, conversationPresented: false },
    ]);
  });

  it("renders once while initially hidden, then presents current owner state on reveal", async () => {
    const visibility = trackVisibility("hidden");
    const { pane, state } = presentationPane();
    const lifecycle = pane;
    const renderedNames: string[] = [];
    lifecycle.render = () => {
      renderedNames.push(state.assistantName);
      return { layout: null, capabilityDialogs: undefined, providerReviewSource: undefined };
    };
    connectPaneTestView(lifecycle);
    await lifecycle.updateComplete;
    const performUpdate = vi.spyOn(lifecycle, "render");
    const cancelAnimationFrame = vi.spyOn(globalThis, "cancelAnimationFrame");

    state.chatStreamRenderFrame = 7;
    visibility("hidden");
    expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
    expect(state.chatStreamRenderFrame).toBeNull();
    state.assistantName = "First hidden update";
    state.assistantName = "Current hidden update";
    await Promise.resolve();
    expect(performUpdate).not.toHaveBeenCalled();

    visibility("visible");
    await lifecycle.updateComplete;
    expect(performUpdate).toHaveBeenCalledOnce();
    expect(renderedNames.at(-1)).toBe("Current hidden update");

    const addVisibilityListener = vi.spyOn(document, "addEventListener");
    const removeVisibilityListener = vi.spyOn(document, "removeEventListener");
    visibility("hidden");
    state.assistantName = "Disconnected hidden update";
    await Promise.resolve();
    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
    lifecycle.disconnectedCallback();
    expect(removeVisibilityListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
      undefined,
    );

    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: true });
    connectPaneTestView(lifecycle);
    await lifecycle.updateComplete;
    // A disposed Solid root remounts once while hidden; measure the reveal independently.
    flush();
    const remountedReads = performUpdate.mock.calls.length;
    state.assistantName = "Latest remounted hidden update";
    flush();
    expect(performUpdate).toHaveBeenCalledTimes(remountedReads);
    visibility("visible");
    await lifecycle.updateComplete;
    expect(performUpdate).toHaveBeenCalledTimes(remountedReads + 1);
    expect(renderedNames.at(-1)).toBe("Latest remounted hidden update");

    Object.defineProperty(lifecycle, "isConnected", { configurable: true, value: false });
    lifecycle.disconnectedCallback();
    addVisibilityListener.mockClear();
    state.assistantName = "Detached update";
    await lifecycle.updateComplete;
    expect(addVisibilityListener).not.toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
      undefined,
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
      expect(state.realtimeTalk.snapshot.realtimeTalkSession).toBeNull();
    });
    state.realtimeTalk.update({
      realtimeTalkSession: {
        stop,
      } as unknown as ChatPageHost["realtimeTalk"]["snapshot"]["realtimeTalkSession"],
      realtimeTalkActive: true,
      realtimeTalkStatus: "listening",
      realtimeTalkDetail: "live",
      realtimeTalkVideoStream: {} as MediaStream,
      realtimeTalkCameraDevices: [{ deviceId: "camera", label: "Camera" }],
      realtimeTalkVideoCapable: true,
      realtimeTalkVideoPending: true,
      realtimeTalkCameraError: true,
    });
    state.realtimeTalk.snapshot.realtimeTalkInputLevel.set(0.7);
    state.realtimeTalk.snapshot.realtimeTalkConversationState.entries = [
      { id: "utterance", role: "user", text: "stale", isStreaming: true },
    ];

    disconnect(pane);

    expect(cancelCommit).toHaveBeenCalledOnce();
    expect(retireModelOverride).toHaveBeenCalledWith("global");
    expect(state).toMatchObject({
      guardianNotices: [],
      chatSending: false,
      chatSendingScopeKey: null,
    });
    expect(state.chatModelSwitchPromises).toEqual({});
    expect(stop).toHaveBeenCalledOnce();
    expect(state.realtimeTalk.snapshot).toMatchObject({
      realtimeTalkActive: false,
      realtimeTalkStatus: "idle",
      realtimeTalkDetail: null,
      realtimeTalkInputLevel: { value: 0 },
      realtimeTalkConversationState: { entries: [] },
      realtimeTalkVideoStream: null,
      realtimeTalkCameraDevices: [],
      realtimeTalkVideoCapable: false,
      realtimeTalkVideoPending: false,
      realtimeTalkCameraError: false,
    });
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
    state.chatModelSwitchPromises = { global: new Promise<boolean>(() => {}) };
    const pending = state.chatModelSwitchPromises;
    applySelectedChatAgent(state, "main");
    expect(state.chatModelSwitchPromises).toBe(pending);
    expect(state.assistantAgentId).toBe("work");
    expect(retireModelOverride).not.toHaveBeenCalled();
    expect(state.loadAssistantIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["direct", false, undefined, false, 1],
    ["unresolved ingress", true, undefined, false, 0],
    ["owner ingress", true, GATEWAY_OWNER_PROFILE_ID, false, 0],
    ["full owner ingress", true, GATEWAY_OWNER_PROFILE_ID, true, 1],
    ["person ingress", true, "verified-person", false, 1],
  ] as const)(
    "refreshes the transcript before secondary hydration after a %s reconnect",
    async (_surface, remoteIngress, profileId, full, questions) => {
      if (remoteIngress) {
        document.documentElement.setAttribute("data-openclaw-remote-ingress", "true");
      }
      const transcript = createDeferred<ChatHistoryResult>();
      const { request, client, pane, state } = reconnectPane(transcript.promise);
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
      const hello = sessionMutationGatewayHello(
        full ? ["operator.admin"] : ["operator.read", "operator.write"],
      );
      const snapshot = {
        ...pane.context.gateway.snapshot,
        client,
        selfUser: profileId
          ? { id: profileId, identity: { type: "profile" as const, id: profileId } }
          : undefined,
        hello: {
          ...hello,
          features: { methods: [...(hello.features?.methods ?? []), "question.list"] },
        },
      };
      const initialGeneration = pane.connectionGeneration;
      const applyPhase = (
        phase: "reconnecting" | "connected",
        generation: number,
        loading: boolean,
      ) => {
        state.chatLoading = true;
        pane.applyGatewaySnapshot({
          ...snapshot,
          phase,
          hello: phase === "reconnecting" ? null : snapshot.hello,
        });
        expect(pane.connectionGeneration).toBe(initialGeneration + generation);
        expect(state).toMatchObject({
          connectionEpoch: initialGeneration + generation,
          chatLoading: loading,
        });
      };
      applyPhase("reconnecting", 1, false);
      applyPhase("reconnecting", 1, true);
      expect(state.connected).toBe(false);
      expect(pane.connectedClient).toBeNull();
      pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
      expect(pane.connectionGeneration).toBe(initialGeneration + 2);
      expect(state.connectionEpoch).toBe(initialGeneration + 2);
      applyPhase("connected", 2, true);

      await expect(chatHistoryRequests(state).subscriptionReady).resolves.toBe(true);
      expect(requestCalls(request, "chat.startup")).toHaveLength(1);
      expect(requestCalls(request, "question.list")).toHaveLength(questions);
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
      expect(requestCalls(request, "chat.startup")).toHaveLength(1);
      applyPhase("connected", 2, true);
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
        expect(state).toMatchObject({ sessionKey: "main", chatRunId: "original-run" });
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
        expect(state).toMatchObject({
          chatError: "Replacement scope warning",
          lastError: "Replacement scope warning",
          chatRunId: "original-run",
        });
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
    state.loadAssistantIdentity = vi.fn(async () => {});
    const snapshot = {
      ...pane.context.gateway.snapshot,
      client,
      assistantAgentId: "main",
    };

    pane.applyGatewaySnapshot({ ...snapshot, phase: "reconnecting", hello: null });
    state.sessionKey = sessionKey;
    state.chatRunId = "run-main";
    await handleAbortChat(state, { preserveDraft: true });

    const hello = sessionMutationGatewayHello(["operator.write"]);
    pane.applyGatewaySnapshot({
      ...snapshot,
      phase: "connected",
      hello: {
        ...hello,
        auth: { ...hello.auth, recoveryScope: "test-recovery-scope" },
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
