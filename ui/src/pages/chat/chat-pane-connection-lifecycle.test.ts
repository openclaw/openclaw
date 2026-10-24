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
  getPaneTestRuntime,
  type TestChatPane,
} from "./chat-pane.test-support.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { retainSessionWorkspaceArtifacts } from "./components/chat-session-workspace-state.ts";
import * as chatThread from "./components/chat-thread-interactions.ts";
import {
  getChatSessionProjection,
  reduceChatSessionProjection,
  setChatRunOwner,
  getChatRunOwner,
} from "./history-merge.ts";
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

function createReconnectRequest(
  startup: ChatHistoryResult | Promise<ChatHistoryResult>,
  handlers: Parameters<typeof makeRequestMock>[0] = {},
) {
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
    ...handlers,
  });
}

function reconnectPane(
  startup: ChatHistoryResult | Promise<ChatHistoryResult>,
  handlers?: Parameters<typeof makeRequestMock>[0],
) {
  const request = createReconnectRequest(startup, handlers);
  const client = createTestGatewayClient(request);
  return { request, client, ...createTestChatPane({ client }) };
}

function presentationPane() {
  const fixture = createTestChatPane({
    client: { request: vi.fn() } as unknown as GatewayBrowserClient,
    sessions: {} as SessionCapability,
  });
  fixture.pane.render = emptyPresentation;
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

const outputsDemand = (pane: TestChatPane) =>
  pane.render().layout?.header?.header.header.detailsControl?.chat?.retainOutputs;
const emptyPresentation = () => ({
  layout: null,
  capabilityDialogs: undefined,
  providerReviewSource: undefined,
});
const setConnected = (pane: TestChatPane, value: boolean) =>
  Object.defineProperty(pane, "isConnected", { configurable: true, value });

describe("chat pane connection lifecycle", () => {
  it("keeps explicit mobile Outputs available during pending history only while presented", async () => {
    const { pane, state, request } = reconnectPane(new Promise<ChatHistoryResult>(() => {}));
    getPaneTestRuntime(pane).mergedChrome = true;
    pane.connectedClient = null;
    pane.presented = false;
    pane.applyGatewaySnapshot(pane.context.gateway.snapshot);
    await waitForSolid(() => expect(requestCalls(request, "chat.startup")).toHaveLength(1));
    expect(chatHistoryRequests(state).historyLoad.phase).toBe("in-flight");
    expect(outputsDemand(pane)).toBeUndefined();
    expect(requestCalls(request, "artifacts.list")).toHaveLength(0);

    pane.presented = true;
    const retain = outputsDemand(pane);
    expect(retain).toBeTypeOf("function");
    const release = retain!();
    onTestFinished(() => release?.());
    expect(requestCalls(request, "artifacts.list")).toHaveLength(1);
    expect(chatHistoryRequests(state).historyLoad.phase).toBe("in-flight");
    pane.presented = false;
    expect(outputsDemand(pane)).toBeUndefined();
    expect(retain!()).toBeUndefined();
    expect(requestCalls(request, "artifacts.list")).toHaveLength(1);
  });

  it("retires only Details Outputs demand before replacing connected clients", async () => {
    const { pane, state, request } = reconnectPane({
      messages: [],
      sessionId: "outputs-session",
    });
    await loadChatHistory(state, { startup: true });
    const retain = outputsDemand(pane);
    expect(retain).toBeTypeOf("function");
    const releaseDetails = retain!();
    const releaseFiles = retainSessionWorkspaceArtifacts(state);
    onTestFinished(() => {
      releaseDetails?.();
      releaseFiles();
    });
    expect(requestCalls(request, "artifacts.list")).toHaveLength(2);

    for (let replacement = 0; replacement < 2; replacement += 1) {
      const nextRequest = createReconnectRequest(new Promise<ChatHistoryResult>(() => {}));
      pane.applyGatewaySnapshot({
        ...pane.context.gateway.snapshot,
        client: createTestGatewayClient(nextRequest),
      });
      await waitForSolid(() => expect(requestCalls(nextRequest, "chat.startup")).toHaveLength(1));
      const artifactReads = requestCalls(nextRequest, "artifacts.list");
      expect(artifactReads).toHaveLength(1);
      expect(artifactReads[0]![1]).not.toHaveProperty("messageRole");
      // A retired UI cleanup must not release the still-visible Files consumer.
      releaseDetails?.();
      releaseDetails?.();
    }
  });

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
    onTestFinished(() => pane.chatState.composerPersistence.stop());
    pane.connectedClient = null;
    const startup = vi.spyOn(pane, "deferSessionHydrationUntilTranscript");
    const snapshot = pane.context.gateway.snapshot;

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
  });

  it.each(["main", "research"])(
    "loads %s suggestions once when startup and session projection share a target",
    async (agentId) => {
      const listed = createDeferred<SessionSuggestionsListResult>();
      const row = {
        key: `agent:${agentId}:current`,
        kind: "direct" as const,
        sessionId: "suggestion-session",
        updatedAt: 1,
      };
      const { pane, state, sessions, request } = reconnectPane(
        { messages: [], sessionId: row.sessionId },
        {
          "session.suggestions.list": listed.promise,
          "sessions.list": sessionsResult([row], 1),
          "sessions.describe": { session: row },
        },
      );
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
      expect(state.chatMessages).toEqual([live]);
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
      expect(getChatSessionProjection(state).runs["pairing-run"]?.message).toEqual(canonical);
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
      }
    },
  );

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
      return emptyPresentation();
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

    setConnected(lifecycle, false);
    lifecycle.disconnectedCallback();

    setConnected(lifecycle, true);
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

    setConnected(lifecycle, false);
    lifecycle.disconnectedCallback();
    state.assistantName = "Detached update";
    await lifecycle.updateComplete;
    expect(renderedNames.at(-1)).toBe("Latest remounted hidden update");
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
    });

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
    });
  });

  it.each([
    ["direct", false, undefined, false, 1],
    ["unresolved ingress", true, undefined, false, 0],
    ["owner ingress", true, GATEWAY_OWNER_PROFILE_ID, false, 0],
    ["full owner ingress", true, GATEWAY_OWNER_PROFILE_ID, true, 1],
    ["person ingress", true, "verified-person", false, 1],
  ] as const)(
    "gates pending questions after a %s reconnect",
    async (_surface, remoteIngress, profileId, full, questions) => {
      if (remoteIngress) {
        document.documentElement.setAttribute("data-openclaw-remote-ingress", "true");
      }
      const { request, client, pane, state } = reconnectPane({ messages: [] });
      state.loadAssistantIdentity = vi.fn(async () => undefined);
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
      disconnect(pane);
      pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });

      await expect(chatHistoryRequests(state).subscriptionReady).resolves.toBe(true);
      expect(requestCalls(request, "chat.startup")).toHaveLength(1);
      expect(requestCalls(request, "question.list")).toHaveLength(questions);
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
        expect(request).toHaveBeenCalledOnce();
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
        if (mode === "queued") {
          expect(state.pendingAbort).toBeNull();
          await expect(replayPendingChatAbort(state)).resolves.toBe(false);
        }
      } finally {
        response.resolve({ aborted: true });
        await stopping;
      }
    },
  );

  it("automatically replays the pending exact-run Stop on reconnect", async () => {
    const { pane, state, request } = reconnectPane(new Promise<ChatHistoryResult>(() => {}), {
      "chat.abort": { aborted: true },
    });
    state.loadAssistantIdentity = vi.fn(async () => {});
    const snapshot = pane.context.gateway.snapshot;
    disconnect(pane);
    state.sessionKey = "agent:main";
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
        sessionKey: "agent:main",
        runId: "run-main",
      }),
    );
    expect(state.pendingAbort).toBeNull();
    pane.applyGatewaySnapshot({ ...snapshot, phase: "connected" });
    expect(requestCalls(request, "chat.abort")).toHaveLength(1);
  });
});
