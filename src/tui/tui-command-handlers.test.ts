// Covers TUI slash command handlers and backend call wiring.

import { expectDefined } from "@openclaw/normalization-core";
import type { Result } from "@openclaw/normalization-core/result";
import { describe, expect, it, vi } from "vitest";
import { createSessionProjection } from "../../packages/gateway-client/src/session-projection.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type {
  LoadHistoryMock,
  SelectableOverlay,
  SetSessionMock,
  RefreshAgentsMock,
} from "./tui-command-handlers-test-support.js";
import {
  createTuiCommandHandlersHarness,
  expectSendChatFields,
  firstMockArg,
  flushAsyncSelect,
} from "./tui-command-handlers-test-support.js";
import {
  TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
  TUI_SESSION_PICKER_LIMIT,
} from "./tui-session-list-policy.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import { getPendingSubmitAcceptedRunId, getPendingSubmitDraft } from "./tui-submit-state.js";

type Harness = ReturnType<typeof createTuiCommandHandlersHarness>;

function selectorOf(harness: Harness): SelectableOverlay {
  return firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
}

function userMessage(id: string, seq: number, runId: string) {
  return {
    role: "user",
    content: [{ type: "text", text: "hello" }],
    __openclaw: { id, seq, idempotencyKey: `${runId}:user` },
  };
}

describe("tui command handlers", () => {
  it("reopens /question locally without sending a chat turn", async () => {
    const reopenQuestion = vi.fn();
    const { handleCommand, sendChat, addPendingUser } = createTuiCommandHandlersHarness({
      opts: { local: true },
      reopenQuestion,
    });
    await handleCommand("/question");
    expect(reopenQuestion).toHaveBeenCalledOnce();
    expect(sendChat).not.toHaveBeenCalled();
    expect(addPendingUser).not.toHaveBeenCalled();
  });

  it("does not open an agent picker from a cached roster after refresh failure", async () => {
    const h = createTuiCommandHandlersHarness({
      refreshAgents: vi
        .fn()
        .mockResolvedValue({ ok: false, error: "gateway unavailable" }) as RefreshAgentsMock,
      agents: [{ id: "cached", name: "Cached Agent" }],
    });
    await h.handleCommand("/agents");
    expect(h.refreshAgents).toHaveBeenCalledOnce();
    expect(h.openOverlay).not.toHaveBeenCalled();
    expect(h.requestRender).toHaveBeenCalled();
  });

  it("filters the refreshed agent roster and switches through the session owner", async () => {
    let previousAgent: string | undefined;
    const setSession = vi.fn(async () => {
      previousAgent = h.state.currentAgentId;
      h.state.currentAgentId = "team-lead";
    }) as SetSessionMock;
    const h = createTuiCommandHandlersHarness({
      currentAgentId: "research",
      currentSessionKey: "global",
      agentDefaultId: "team-lead",
      setSession,
      agents: [
        { id: "team-lead", name: "Lead Agent" },
        { id: "system-agent", kind: "system", name: "System Agent" },
      ],
    });
    await h.handleCommand("/agents");
    expect(h.refreshAgents).toHaveBeenCalledOnce();
    expect(selectorOf(h).items).toEqual([
      { value: "team-lead", label: "team-lead (Lead Agent)", description: "default" },
    ]);
    selectorOf(h).onSelect?.({ value: "team-lead" });
    await flushAsyncSelect();
    expect(previousAgent).toBe("research");
    expect(h.setSession).toHaveBeenCalledExactlyOnceWith("", "team-lead");
    expect(h.closeOverlay).toHaveBeenCalledExactlyOnceWith(h.overlayHandle);
  });

  it("lets a newer settings picker retire a pending model request", async () => {
    const models = createDeferred<Array<{ provider: string; id: string }>>();
    const h = createTuiCommandHandlersHarness({ listModels: vi.fn(() => models.promise) });
    await h.handleCommand("/models");
    const olderSelector = selectorOf(h);
    await h.handleCommand("/settings");
    expect(h.closeOverlay).toHaveBeenCalledExactlyOnceWith(h.overlayHandle);
    models.resolve([{ provider: "fixture", id: "obsolete" }]);
    await flushAsyncSelect();
    expect(h.openOverlay).toHaveBeenCalledTimes(2);
    expect(olderSelector.items).toEqual([]);
  });

  it("retires an unfinished agent refresh before opening a newer session picker", async () => {
    const pendingRefresh = createDeferred<Result<void, string>>();
    const refreshAgents = vi.fn(() => pendingRefresh.promise) as RefreshAgentsMock;
    const harness = createTuiCommandHandlersHarness({
      refreshAgents,
      listSessions: vi
        .fn()
        .mockResolvedValue({ sessions: [{ key: "agent:main:current", updatedAt: 1 }] }),
      agents: [{ id: "main", name: "Main Agent" }],
    });

    const olderPicker = harness.handleCommand("/agents");
    const [ownsRefresh] = refreshAgents.mock.calls[0] as [(() => boolean) | undefined];
    await harness.handleCommand("/sessions");
    expect(ownsRefresh?.()).toBe(false);

    pendingRefresh.resolve({ ok: true, value: undefined });
    await olderPicker;

    expect(harness.openOverlay).toHaveBeenCalledOnce();
  });

  it("consumes a model selection before its patch finishes", async () => {
    const pending = createDeferred();
    const h = createTuiCommandHandlersHarness({
      listModels: vi.fn().mockResolvedValue([{ provider: "openrouter", id: "openrouter/auto" }]),
      patchSession: vi.fn(() => pending.promise),
    });
    await h.handleCommand("/models");
    const selector = selectorOf(h);
    expect(selector.items?.[0]?.value).toBe("openrouter/auto");
    selector.onSelect?.({ value: "openrouter/auto" });
    expect(h.closeOverlay).toHaveBeenCalledExactlyOnceWith(h.overlayHandle);
    selector.onSelect?.({ value: "openrouter/auto" });
    expect(h.patchSession).toHaveBeenCalledExactlyOnceWith({
      key: "agent:main:main",
      model: "openrouter/auto",
    });
    pending.resolve();
    await flushAsyncSelect();
    expect(h.closeOverlay).toHaveBeenCalledOnce();
  });

  it("retires an open session picker when its session incarnation is replaced", async () => {
    const h = createTuiCommandHandlersHarness({
      currentSessionId: "private-session",
      sessionGeneration: 3,
      listSessions: vi.fn().mockResolvedValue({
        sessions: [{ key: "agent:main:main", displayName: "main", updatedAt: 1 }],
      }),
    });
    await h.handleCommand("/sessions");
    expect(h.listSessions).toHaveBeenCalledWith({
      limit: TUI_SESSION_PICKER_LIMIT,
      activeMinutes: TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
      includeGlobal: false,
      includeUnknown: false,
      includeDerivedTitles: true,
      includeLastMessage: true,
      agentId: "main",
    });
    h.state.currentSessionId = "replacement-session";
    h.state.sessionGeneration += 1;
    selectorOf(h).onSelect?.({ value: "agent:main:main" });
    await flushAsyncSelect();
    expect(h.setSession).not.toHaveBeenCalled();
    expect(h.closeOverlay).toHaveBeenCalledExactlyOnceWith(h.overlayHandle);
  });

  it("does not reveal a previous session's delayed picker failure in its replacement", async () => {
    const selection = createDeferred();
    const harness = createTuiCommandHandlersHarness({
      currentSessionId: "private-session",
      sessionGeneration: 2,
      listSessions: vi.fn().mockResolvedValue({ sessions: [{ key: "agent:main:other" }] }),
      setSession: vi.fn(() => selection.promise) as SetSessionMock,
    });

    await harness.handleCommand("/sessions");
    const selector = firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
    selector.onSelect?.({ value: "agent:main:other" });
    harness.state.currentSessionId = "replacement-session";
    harness.state.sessionGeneration += 1;
    selection.reject(new Error("private previous-session details"));
    await flushAsyncSelect();

    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(harness.closeOverlay).toHaveBeenCalledExactlyOnceWith(harness.overlayHandle);
  });

  it("scopes an explicit timeout override to one message", async () => {
    const { handleCommand, sendMessage, sendChat, state } = createTuiCommandHandlersHarness();

    await sendMessage("automatic hatch", 300_000);
    state.pendingSubmit = null;
    await handleCommand("do not do that");

    expect(sendChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "automatic hatch", timeoutMs: 300_000 }),
    );
    expect(sendChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "do not do that", timeoutMs: undefined }),
    );
  });

  it("projects a pending send, binds its session and re-keys its ACK in place", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const h = createTuiCommandHandlersHarness({ sendChat: vi.fn(() => deferred.promise) });
    const sending = h.handleCommand("hello");
    const localRunId = h.addPendingUser.mock.calls[0]?.[0];
    expect(localRunId).toEqual(expect.any(String));
    expect(localRunId).not.toBe("accepted-run");
    expect(h.noteLocalRunId).toHaveBeenCalledWith(localRunId);
    expect(h.state.sessionProjection?.scope).toEqual({
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(h.state.sessionProjection?.entries).toEqual([
      expect.objectContaining({
        pending: true,
        pendingRunId: localRunId,
        message: {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          __openclaw: { idempotencyKey: `${localRunId}:user` },
        },
      }),
    ]);
    expect(h.setActivityStatus).toHaveBeenCalledWith("sending");
    const sendingOrder = h.setActivityStatus.mock.invocationCallOrder[0] ?? 0;
    expect(h.requestRender.mock.invocationCallOrder.some((order) => order > sendingOrder)).toBe(
      true,
    );
    h.state.currentSessionId = "session-created";
    deferred.resolve({ runId: "accepted-run" });
    await sending;
    expect(h.state.currentSessionId).toBe("session-created");
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.rekeyPendingUser).toHaveBeenCalledWith(localRunId, "accepted-run");
    expect(h.addPendingUser).toHaveBeenCalledOnce();
    expect(h.dropPendingUser).not.toHaveBeenCalled();
    expect(h.forgetLocalRunId).toHaveBeenCalledWith(localRunId);
    expect(h.noteLocalRunId).toHaveBeenCalledWith("accepted-run");
    expect(h.state.sessionProjection?.entries).toEqual([
      expect.objectContaining({
        pending: true,
        pendingRunId: "accepted-run",
        message: expect.objectContaining({ __openclaw: { idempotencyKey: `${localRunId}:user` } }),
      }),
    ]);
    expect(getPendingSubmitDraft(h.state)).toEqual({ runId: "accepted-run", text: "hello" });
    expect(getPendingSubmitAcceptedRunId(h.state)).toBe("accepted-run");
    expect(h.setActivityStatus).toHaveBeenLastCalledWith("waiting");
  });

  it("retires only the provisional row when a persisted turn beats its ACK", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const h = createTuiCommandHandlersHarness({ sendChat: vi.fn(() => deferred.promise) });
    const sending = h.handleCommand("hello");
    const localRunId = h.addPendingUser.mock.calls[0]?.[0];
    const accepted = userMessage("accepted-user", 1, "accepted-run");
    const peer = userMessage("peer-user", 2, "peer-run");
    for (const message of [accepted, peer]) {
      reduceTuiSessionProjection(h.state as never, {
        type: "messagePersisted",
        message,
        scope: readTuiSessionProjectionScope(h.state),
      });
    }
    deferred.resolve({ runId: "accepted-run" });
    await sending;
    expect(h.state.sessionProjection?.messages).toEqual([accepted, peer]);
    expect(h.state.sessionProjection?.entries.every((entry) => !entry.pending)).toBe(true);
    expect(h.dropPendingUser).toHaveBeenCalledExactlyOnceWith(localRunId);
    expect(h.rekeyPendingUser).not.toHaveBeenCalled();
    expect(h.noteLocalRunId).toHaveBeenCalledWith("accepted-run");
    expect(getPendingSubmitAcceptedRunId(h.state)).toBe("accepted-run");
  });

  it("does not re-arm the submit draft when the accepted run already emitted events", async () => {
    const sendChat = vi.fn().mockResolvedValue({ runId: "r-accepted" });
    const isRunObserved = vi.fn((runId: string) => runId === "r-accepted");
    const harness = createTuiCommandHandlersHarness({ sendChat, isRunObserved });

    await harness.handleCommand("hello");

    // The accepted run already registered, so the draft must not be re-armed —
    // otherwise a later abort would drop a row whose reply already rendered.
    expect(harness.rekeyPendingUser).toHaveBeenCalledWith(expect.any(String), "r-accepted");
    expect(getPendingSubmitDraft(harness.state)).toBeNull();
  });

  it.each(["/status", "/context"])(
    "keeps unsupported shared command %s out of local model prompts",
    async (command) => {
      const { handleCommand, sendChat, addPendingUser, addSystem } =
        createTuiCommandHandlersHarness({
          opts: { local: true },
        });

      await handleCommand(command);

      expect(sendChat).not.toHaveBeenCalled();
      expect(addPendingUser).not.toHaveBeenCalled();
      expect(addSystem).toHaveBeenCalledWith(
        expect.stringMatching(/not available in local embedded mode; message not sent$/),
      );
    },
  );

  it("preserves local side prompts and unknown slash text", async () => {
    const emptySide = createTuiCommandHandlersHarness({ opts: { local: true } });
    await emptySide.handleCommand("/side");
    expect(emptySide.sendChat).not.toHaveBeenCalled();
    expect(emptySide.addSystem).toHaveBeenCalledWith("Usage: /btw <side question>");

    const side = createTuiCommandHandlersHarness({ opts: { local: true } });
    await side.handleCommand("/side check this");
    expectSendChatFields(side.sendChat, {
      sessionKey: "agent:main:main",
      message: "/side check this",
    });

    const unknown = createTuiCommandHandlersHarness({ opts: { local: true } });
    await unknown.handleCommand("/not-a-real-command");
    expectSendChatFields(unknown.sendChat, {
      sessionKey: "agent:main:main",
      message: "/not-a-real-command",
    });
  });

  it("starts local goals and sends the objective to the model", async () => {
    const runGoalCommand = vi
      .fn()
      .mockResolvedValue({ text: "Goal started: ship", continuationPrompt: "ship" });
    const { handleCommand, sendChat, addSystem, refreshSessionInfo, addPendingUser } =
      createTuiCommandHandlersHarness({
        opts: { local: true },
        currentSessionKey: "global",
        currentAgentId: "work",
        runGoalCommand,
      });

    await handleCommand("/goal start ship");

    expect(runGoalCommand).toHaveBeenCalledWith({
      sessionKey: "global",
      agentId: "work",
      command: "/goal start ship",
    });
    expectSendChatFields(sendChat, {
      sessionKey: "global",
      agentId: "work",
      message: "ship",
    });
    expect(addPendingUser).toHaveBeenCalledWith(expect.any(String), "ship");
    expect(addSystem).toHaveBeenCalledWith("Goal started: ship");
    expect(refreshSessionInfo).toHaveBeenCalled();
  });

  it.each([false, true])(
    "suppresses a replaced session's delayed goal (failure: %s)",
    async (fails) => {
      const goal = createDeferred<{ text: string; continuationPrompt?: string }>();
      const h = createTuiCommandHandlersHarness({
        opts: { local: true },
        currentSessionId: "private-session",
        sessionGeneration: 4,
        runGoalCommand: vi.fn(() => goal.promise),
      });
      const pending = h.handleCommand("/goal start private objective");
      h.state.sessionGeneration += 1;
      if (fails) {
        goal.reject(new Error("private research failure"));
      } else {
        goal.resolve({ text: "private goal status", continuationPrompt: "PRIVATE_OBJECTIVE" });
      }
      await pending;
      expect(h.sendChat).not.toHaveBeenCalled();
      expect(h.addSystem).not.toHaveBeenCalled();
      expect(h.refreshSessionInfo).not.toHaveBeenCalled();
    },
  );

  it("does not send an old goal continuation after its session changes during refresh", async () => {
    const refresh = createDeferred();
    const harness = createTuiCommandHandlersHarness({
      opts: { local: true },
      currentAgentId: "research",
      currentSessionKey: "agent:research:private",
      currentSessionId: "research-session",
      runGoalCommand: vi.fn().mockResolvedValue({
        text: "private research goal status",
        continuationPrompt: "PRIVATE_RESEARCH_OBJECTIVE",
      }),
      refreshSessionInfo: vi.fn(() => refresh.promise),
    });

    const pending = harness.handleCommand("/goal start private objective");
    await vi.waitFor(() => expect(harness.refreshSessionInfo).toHaveBeenCalledOnce());
    harness.state.currentAgentId = "ops";
    harness.state.currentSessionKey = "agent:ops:public";
    harness.state.currentSessionId = "ops-session";
    refresh.resolve();
    await pending;

    expect(harness.sendChat).not.toHaveBeenCalled();
  });

  it("forwards goal commands to the gateway outside local mode", async () => {
    const { handleCommand, sendChat, runGoalCommand } = createTuiCommandHandlersHarness();

    await handleCommand("/goal status");

    expect(runGoalCommand).not.toHaveBeenCalled();
    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/goal status",
    });
  });

  it("sends the selected context mode through the gateway command path", async () => {
    const { handleCommand, sendChat, openOverlay, closeOverlay, overlayHandle } =
      createTuiCommandHandlersHarness();

    await handleCommand("/context");
    expect(sendChat).not.toHaveBeenCalled();
    expect(openOverlay).toHaveBeenCalledOnce();
    const selector = firstMockArg(openOverlay, "openOverlay") as SelectableOverlay;
    selector?.onSelect?.({ value: "detail", label: "detail" });
    await flushAsyncSelect();

    expectSendChatFields(sendChat, {
      sessionKey: "agent:main:main",
      message: "/context detail",
    });
    expect(closeOverlay).toHaveBeenCalledTimes(1);
    expect(closeOverlay).toHaveBeenCalledWith(overlayHandle);
  });

  it("closes the picker and reports a rejected selection", async () => {
    const h = createTuiCommandHandlersHarness({
      setSession: vi.fn().mockRejectedValue(new Error("gateway unavailable")) as SetSessionMock,
      agents: [{ id: "work" }],
    });
    await h.handleCommand("/agent");
    selectorOf(h).onSelect?.({ value: "work" });
    await flushAsyncSelect();
    expect(h.closeOverlay).toHaveBeenCalledWith(h.overlayHandle);
    expect(h.addSystem).toHaveBeenCalledWith(expect.stringContaining("gateway unavailable"));
  });

  it.each(["/gateway-status"])("keeps gateway diagnostics on %s", async (command) => {
    const { handleCommand, getGatewayStatus, addSystem, addUser, sendChat } =
      createTuiCommandHandlersHarness({
        getGatewayStatus: vi.fn().mockResolvedValue({
          runtimeVersion: "1.2.3",
          channelSummary: ["Telegram: not configured"],
          sessions: { count: 2, defaults: { model: "gpt-5.4", contextTokens: 200000 } },
        }),
      });

    await handleCommand(command);

    expect(getGatewayStatus).toHaveBeenCalledTimes(1);
    expect(addUser).not.toHaveBeenCalled();
    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("Gateway status");
    expect(addSystem).toHaveBeenCalledWith("Version: 1.2.3");
    expect(addSystem).toHaveBeenCalledWith("  Telegram: not configured");
    expect(addSystem).toHaveBeenCalledWith("Stored sessions: 2");
    expect(addSystem).not.toHaveBeenCalledWith("Active sessions: 2");
  });

  it("returns to OpenClaw with an optional request", async () => {
    const { handleCommand, addSystem, requestExit, sendChat } = createTuiCommandHandlersHarness();

    await handleCommand("/openclaw restart gateway");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("returning to OpenClaw with request: restart gateway");
    expect(requestExit).toHaveBeenCalledWith({
      exitReason: "return-to-system-agent",
      systemAgentMessage: "restart gateway",
    });
  });

  it("does not reintroduce the pending runId when an early event already consumed it", async () => {
    const sendChat = vi.fn();
    const { handleCommand, state } = createTuiCommandHandlersHarness({ sendChat });
    sendChat.mockImplementation(async (opts: { runId: string }) => {
      state.pendingSubmit = null;
      return { runId: opts.runId };
    });

    await handleCommand("hello");

    expect(state.pendingSubmit).toBeNull();
  });

  it("cleans a delayed ACK without mutating the replacement viewport", async () => {
    const deferred = createDeferred<{ runId: string; status: string }>();
    const h = createTuiCommandHandlersHarness({
      currentSessionId: "old-session",
      sendChat: vi.fn(() => deferred.promise),
    });
    const sending = h.handleCommand("old prompt");
    const localRunId = h.addPendingUser.mock.calls[0]?.[0];
    expectSendChatFields(h.sendChat, { message: "old prompt", sessionId: "old-session" });
    const nextProjection = createSessionProjection(
      { sessionKey: "agent:main:main", agentId: "main", sessionId: "replacement-session" },
      [userMessage("new-user", 1, "new-run")],
    );
    h.state.currentSessionId = "replacement-session";
    h.state.sessionProjection = nextProjection;
    h.state.activeChatRunId = "new-active";
    h.state.pendingSubmit = { phase: "accepted", runId: "new-pending", draftText: "new draft" };
    h.state.activityStatus = "streaming";
    deferred.resolve({ runId: "old-accepted", status: "error" });
    await sending;
    expect(h.state.sessionProjection).toBe(nextProjection);
    expect(h.state.activeChatRunId).toBe("new-active");
    expect(h.state.pendingSubmit).toEqual({
      phase: "accepted",
      runId: "new-pending",
      draftText: "new draft",
    });
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.setActivityStatus).toHaveBeenCalledExactlyOnceWith("sending");
    expect(h.forgetLocalRunId).toHaveBeenCalledWith(localRunId);
    expect(h.forgetLocalRunId).toHaveBeenCalledWith("old-accepted");
  });

  it("cleans a delayed send rejection without reporting it in a new session", async () => {
    const deferred = createDeferred<never>();
    const harness = createTuiCommandHandlersHarness({ sendChat: vi.fn(() => deferred.promise) });
    const sending = harness.handleCommand("old session prompt");
    const provisionalRunId = (firstMockArg(harness.sendChat, "sendChat") as { runId: string })
      .runId;
    const nextProjection = createSessionProjection({
      sessionKey: "agent:work:second",
      agentId: "work",
    });
    harness.state.currentAgentId = "work";
    harness.state.currentSessionKey = "agent:work:second";
    harness.state.sessionProjection = nextProjection;
    harness.state.pendingSubmit = {
      phase: "accepted",
      runId: "new-pending",
      draftText: null,
    };

    deferred.reject(new Error("old gateway failure"));
    await sending;

    expect(harness.state.sessionProjection).toBe(nextProjection);
    expect(harness.state.pendingSubmit?.runId).toBe("new-pending");
    expect(harness.addSystem).not.toHaveBeenCalled();
    expect(harness.dropPendingUser).not.toHaveBeenCalled();
    expect(harness.forgetLocalRunId).toHaveBeenCalledWith(provisionalRunId);
  });

  it("clears optimistic state when chat send returns a terminal timeout ack", async () => {
    const sendChat = vi.fn().mockImplementation(async () => ({
      runId: "accepted-failed-run",
      status: "timeout",
    }));
    const historyReload = { clearSystemMessages: undefined as (() => void) | undefined };
    const loadHistory = vi.fn().mockImplementation(async () => {
      historyReload.clearSystemMessages?.();
    }) as LoadHistoryMock;
    const {
      handleCommand,
      state,
      dropPendingUser,
      rekeyPendingUser,
      addSystem,
      setActivityStatus,
    } = createTuiCommandHandlersHarness({
      sendChat,
      loadHistory,
    });
    historyReload.clearSystemMessages = () => addSystem.mockClear();

    await handleCommand("hello");

    const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
    expect(dropPendingUser).toHaveBeenCalledWith("accepted-failed-run");
    expect(rekeyPendingUser).toHaveBeenCalledWith(sentRunId, "accepted-failed-run");
    expect(state.pendingSubmit).toBeNull();
    expect(state.sessionProjection?.entries).toEqual([]);
    expect(addSystem).toHaveBeenCalledWith(
      "send failed: Chat failed before the run started; try again.",
    );
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("ignores a terminal ACK after its history reload switches sessions", async () => {
    const history = createDeferred();
    const entered = createDeferred();
    const h = createTuiCommandHandlersHarness({
      sendChat: vi.fn(async ({ runId }: { runId: string }) => ({ runId, status: "error" })),
      loadHistory: vi.fn(() => {
        entered.resolve();
        return history.promise;
      }) as LoadHistoryMock,
    });
    const pending = h.handleCommand("private provider request");
    await entered.promise;
    h.addSystem.mockClear();
    h.setActivityStatus.mockClear();
    h.state.currentAgentId = "ops";
    h.state.currentSessionKey = "agent:ops:public";
    h.state.activeChatRunId = "public-run";
    h.state.pendingSubmit = { phase: "accepted", runId: "public-run", draftText: null };
    history.resolve();
    await pending;
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.setActivityStatus).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("public-run");
    expect(h.state.pendingSubmit?.runId).toBe("public-run");
  });

  it("refreshes history without waiting on a terminal OK ACK", async () => {
    const h = createTuiCommandHandlersHarness({
      sendChat: vi.fn(async ({ runId }: { runId: string }) => ({ runId, status: "ok" })),
    });
    await h.handleCommand("hello");
    expect(h.dropPendingUser).not.toHaveBeenCalled();
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.state.sessionProjection?.entries).toHaveLength(1);
    expect(h.setActivityStatus).toHaveBeenLastCalledWith("idle");
    expect(h.loadHistory).toHaveBeenCalledOnce();
  });

  it("cleans both BTW run IDs after a re-keyed terminal failure", async () => {
    const h = createTuiCommandHandlersHarness({
      sendChat: vi.fn().mockResolvedValue({ runId: "accepted-side", status: "error" }),
      activeChatRunId: "run-main",
    });
    await h.handleCommand("/side check terminal ack");
    const sent = firstMockArg(h.sendChat, "sendChat") as { runId: string };
    expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
    expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith("accepted-side");
    expect(h.addSystem).toHaveBeenCalledWith(
      "btw failed: Chat failed before the run started; try again.",
    );
    expect(h.state.activeChatRunId).toBe("run-main");
    expect(h.state.pendingSubmit).toBeNull();
  });

  it("clears local BTW tracking on a terminal OK without hijacking the main run", async () => {
    const h = createTuiCommandHandlersHarness({
      sendChat: vi.fn().mockResolvedValue({ runId: "accepted-btw", status: "ok" }),
      activeChatRunId: "run-main",
    });
    await h.handleCommand("/side finish detached");
    const sent = firstMockArg(h.sendChat, "sendChat") as { runId: string };
    expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
    expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith("accepted-btw");
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("run-main");
    expect(h.state.pendingSubmit).toBeNull();
  });

  it("tracks a re-keyed nonterminal BTW ACK without hijacking the main run", async () => {
    const h = createTuiCommandHandlersHarness({
      sendChat: vi.fn().mockResolvedValue({ runId: "accepted-btw", status: "in_flight" }),
      activeChatRunId: "run-main",
    });
    await h.handleCommand("/btw continue detached");
    const sent = firstMockArg(h.sendChat, "sendChat") as { runId: string };
    expect(h.noteLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
    expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
    expect(h.noteLocalBtwRunId).toHaveBeenCalledWith("accepted-btw");
    expect(h.noteLocalRunId).not.toHaveBeenCalled();
    expect(h.addUser).not.toHaveBeenCalled();
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.state.sessionProjection).toBeUndefined();
    expect(h.setActivityStatus).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("run-main");
    expect(h.state.pendingSubmit).toBeNull();
  });

  it("does not reintroduce an accepted run after an early terminal event", async () => {
    const consumeCompletedRunForPendingSend = vi.fn((id: string) => id === "accepted-run");
    const flushPendingHistoryRefreshIfIdle = vi.fn();
    const h = createTuiCommandHandlersHarness({
      sendChat: vi.fn().mockResolvedValue({ runId: "accepted-run" }),
      consumeCompletedRunForPendingSend,
      flushPendingHistoryRefreshIfIdle,
    });
    await h.handleCommand("hello");
    expect(consumeCompletedRunForPendingSend).toHaveBeenCalledWith("accepted-run");
    expect(h.forgetLocalRunId).toHaveBeenCalledWith(h.addPendingUser.mock.calls[0]?.[0]);
    expect(h.noteLocalRunId).not.toHaveBeenCalledWith("accepted-run");
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    expect(flushPendingHistoryRefreshIfIdle).toHaveBeenCalledOnce();
    expect(h.addPendingUser).toHaveBeenCalledOnce();
    expect(h.dropPendingUser).not.toHaveBeenCalled();
  });

  it("keeps the active run and same-text persisted peer when a queued send fails", async () => {
    const peer = userMessage("peer-user", 4, "peer-run");
    const h = createTuiCommandHandlersHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("local send failed")),
      activeChatRunId: "run-active",
      sessionProjection: createSessionProjection(
        { sessionKey: "agent:main:main", agentId: "main" },
        [peer],
      ),
    });
    await h.handleCommand("hello");
    expect(h.state.activeChatRunId).toBe("run-active");
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.dropPendingUser).toHaveBeenCalledWith(h.addPendingUser.mock.calls[0]?.[0]);
    expect(h.state.sessionProjection?.messages).toEqual([peer]);
    expect(h.state.sessionProjection?.entries[0]).toMatchObject({
      pending: false,
      pendingRunId: null,
    });
  });

  it.each([false, true])(
    "prevents a delayed /new from hijacking a replacement (failure: %s)",
    async (fails) => {
      const creation = createDeferred<{ ok: true; key: string }>();
      const sessionInfo = { inputTokens: 11, outputTokens: 22, totalTokens: 33 };
      const h = createTuiCommandHandlersHarness({
        currentSessionId: "private-session",
        sessionInfo: { ...sessionInfo },
        createSession: vi.fn(() => creation.promise),
      });
      const pending = h.handleCommand("/new");
      h.state.currentSessionId = "replacement-session";
      if (fails) {
        creation.reject(new Error("private creation failure"));
      } else {
        creation.resolve({ ok: true, key: "agent:main:private-child" });
      }
      await pending;
      expect(h.setSession).not.toHaveBeenCalled();
      expect(h.addSystem).not.toHaveBeenCalled();
      expect(h.state.sessionInfo).toEqual(sessionInfo);
    },
  );

  it.each([true, false])("scopes an adopted /new completion (failure: %s)", async (fails) => {
    const adoption = createDeferred();
    const entered = createDeferred();
    const createdKey = "agent:main:private-child";
    const h = createTuiCommandHandlersHarness({
      createSession: vi.fn().mockResolvedValue({ ok: true, key: createdKey }),
      setSession: vi.fn((key: string) => {
        h.state.currentSessionKey = key;
        h.state.currentSessionId = null;
        entered.resolve();
        return adoption.promise;
      }) as SetSessionMock,
    });
    const pending = h.handleCommand("/new");
    await entered.promise;
    if (fails) {
      adoption.reject(new Error("replacement history unavailable"));
    } else {
      h.state.currentSessionKey = "agent:ops:public";
      adoption.resolve();
    }
    await pending;
    if (fails) {
      expect(h.addSystem).toHaveBeenCalledWith(
        "new session failed: replacement history unavailable",
      );
    } else {
      expect(h.addSystem).not.toHaveBeenCalled();
    }
  });

  it("blocks /new while the current session is finishing", async () => {
    const h = createTuiCommandHandlersHarness({ activityStatus: "finishing context" });
    await h.handleCommand("/new");
    expect(h.createSession).not.toHaveBeenCalled();
    expect(h.addSystem).toHaveBeenCalledWith("abort the current run before /new");
  });

  it("blocks /reset while a submit is unfinished", async () => {
    const h = createTuiCommandHandlersHarness({
      pendingSubmit: { phase: "sending", runId: "pending-run", draftText: "pending" },
      activityStatus: "sending",
    });
    await h.handleCommand("/reset");
    expect(h.resetSession).not.toHaveBeenCalled();
    expect(h.addSystem).toHaveBeenCalledWith("abort the current run before /reset");
  });

  it("serializes input until /new adopts a unique successor session", async () => {
    const creation = createDeferred<{ ok: true; key: string }>();
    const h = createTuiCommandHandlersHarness({
      currentSessionKey: "global",
      currentAgentId: "work",
      currentSessionId: "parent-session",
      createSession: vi.fn(() => creation.promise),
    });
    const creating = h.handleCommand("/new");
    expect(h.resolveMessageAdmission("must not reach parent")).toEqual({
      status: "blocked",
      reason: "session-transition",
      command: "new",
    });
    await h.sendMessage("must not reach parent");
    await h.handleCommand("/new");
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(h.createSession).toHaveBeenCalledExactlyOnceWith({
      key: expect.stringMatching(/^tui-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
      agentId: "work",
      parentSessionKey: "global",
      succeedsParent: true,
    });
    expect(h.addSystem).toHaveBeenCalledWith("session change in progress; wait for /new to finish");
    creation.resolve({ ok: true, key: "agent:work:tui-created" });
    await creating;
    expect(h.setSession).toHaveBeenCalledExactlyOnceWith("agent:work:tui-created");
    expect(h.addSystem).toHaveBeenCalledWith("new session: agent:work:tui-created");
  });

  it("serializes input until /reset adopts the backend replacement", async () => {
    const reset = createDeferred<{ ok: true; key: string; entry: { sessionId: string } }>();
    const result = {
      ok: true as const,
      key: "agent:main:replacement",
      entry: { sessionId: "replacement-session" },
    };
    const h = createTuiCommandHandlersHarness({
      resetSession: vi.fn(() => reset.promise),
      applySessionMutationResult: vi.fn((value: typeof result) => {
        h.state.currentSessionKey = value.key;
        h.state.currentSessionId = value.entry.sessionId;
        return true;
      }),
    });
    const resetting = h.handleCommand("/reset");
    expect(h.resolveMessageAdmission("must not reach resetting session")).toEqual({
      status: "blocked",
      reason: "session-transition",
      command: "reset",
    });
    await h.sendMessage("must not reach resetting session");
    await h.handleCommand("/reset");
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(h.resetSession).toHaveBeenCalledExactlyOnceWith("agent:main:main", "reset", undefined);
    expect(h.addSystem).toHaveBeenCalledWith(
      "session change in progress; wait for /reset to finish",
    );
    reset.resolve(result);
    await resetting;
    expect(h.applySessionMutationResult).toHaveBeenCalledExactlyOnceWith(result, {
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.state.currentSessionKey).toBe(result.key);
    expect(h.state.currentSessionId).toBe(result.entry.sessionId);
    expect(h.addSystem).toHaveBeenCalledWith("session agent:main:replacement reset");
  });

  it("reloads a global session after /reset returns no session entry", async () => {
    const h = createTuiCommandHandlersHarness({
      currentSessionKey: "global",
      currentAgentId: "work",
      applySessionMutationResult: vi.fn().mockReturnValue(false),
    });
    await h.handleCommand("/reset");
    expect(h.resetSession).toHaveBeenCalledExactlyOnceWith("global", "reset", { agentId: "work" });
    expect(h.applySessionMutationResult).toHaveBeenCalledWith(
      { ok: true },
      { sessionKey: "global", agentId: "work" },
    );
    expect(h.loadHistory).toHaveBeenCalledOnce();
  });

  it("preserves the canonical transcript when the selected session reset fails", async () => {
    const message = {
      role: "user",
      content: [{ type: "text", text: "preserve failed reset" }],
      __openclaw: { id: "before-failed-reset", seq: 1 },
    };
    const sessionProjection = createSessionProjection(
      { sessionKey: "agent:main:main", agentId: "main" },
      [message],
    );
    const harness = createTuiCommandHandlersHarness({
      resetSession: vi.fn().mockRejectedValue(new Error("\u001b[31mreset unavailable\u001b[0m")),
      sessionProjection,
    });

    await harness.handleCommand("/reset");

    expect(harness.state.sessionProjection?.messages).toEqual([message]);
    expect(harness.applySessionMutationResult).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith("reset failed: reset unavailable");
  });

  it("scopes selected global session patches to the selected agent", async () => {
    const patchSession = vi.fn().mockResolvedValue({ fastMode: true });
    const { handleCommand } = createTuiCommandHandlersHarness({
      currentSessionKey: "global",
      currentAgentId: "work",
      patchSession,
    });

    await handleCommand("/fast on");

    expect(patchSession).toHaveBeenCalledWith({
      key: "global",
      agentId: "work",
      fastMode: true,
    });
  });

  it.each(["/reasoning on", "/usage full", "/elevated ask"])(
    "ignores a stale %s patch after switching sessions",
    async (command) => {
      const patch = createDeferred<{ entry: { model: string } }>();
      const h = createTuiCommandHandlersHarness({
        currentSessionKey: "global",
        currentAgentId: "main",
        sessionInfo: { responseUsage: "tokens", effectiveResponseUsage: "tokens" },
        patchSession: vi.fn(() => patch.promise),
      });
      const pending = h.handleCommand(command);
      expect(h.patchSession).toHaveBeenCalledWith(
        expect.objectContaining({ key: "global", agentId: "main" }),
      );
      h.state.currentAgentId = "work";
      patch.resolve({ entry: { model: "stale-model" } });
      await pending;
      expect(h.state.sessionInfo).toEqual({
        responseUsage: "tokens",
        effectiveResponseUsage: "tokens",
      });
      expect(h.applySessionInfoFromPatch).not.toHaveBeenCalled();
      expect(h.refreshSessionInfo).not.toHaveBeenCalled();
      expect(h.loadHistory).not.toHaveBeenCalled();
      expect(h.clearTools).not.toHaveBeenCalled();
      expect(h.addSystem).not.toHaveBeenCalled();
    },
  );

  it("clears inherited usage before a nested patch handoff changes agents", async () => {
    const appliedAgents: string[] = [];
    const displayedAgents: string[] = [];
    const h = createTuiCommandHandlersHarness({
      currentAgentId: "research",
      currentSessionKey: "agent:research:private",
      sessionInfo: { responseUsage: "tokens", effectiveResponseUsage: "tokens" },
      patchSession: vi.fn(() => {
        queueMicrotask(() =>
          queueMicrotask(() => {
            h.state.currentAgentId = "ops";
            h.state.currentSessionKey = "agent:ops:public";
            h.state.sessionInfo = { responseUsage: "tokens", effectiveResponseUsage: "tokens" };
          }),
        );
        return Promise.resolve({ entry: {} });
      }),
      applySessionInfoFromPatch: vi.fn(() => appliedAgents.push(h.state.currentAgentId)),
      refreshSessionInfo: vi.fn(async () => {
        expect(h.state.sessionInfo.responseUsage).toBeUndefined();
        expect(h.state.sessionInfo.effectiveResponseUsage).toBeUndefined();
      }),
    });
    h.addSystem.mockImplementation(() => displayedAgents.push(h.state.currentAgentId));
    await h.handleCommand("/usage reset");
    expect(h.patchSession).toHaveBeenCalledWith(expect.objectContaining({ responseUsage: null }));
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.state.currentAgentId).toBe("ops");
    expect(h.state.sessionInfo.responseUsage).toBe("tokens");
    expect(appliedAgents).toEqual(["research"]);
    expect(displayedAgents).toEqual(["research"]);
  });

  it("hides a stale verbose failure after its history reload rejects", async () => {
    const followup = createDeferred();
    const entered = createDeferred();
    const h = createTuiCommandHandlersHarness({
      loadHistory: vi.fn(() => {
        entered.resolve();
        return followup.promise;
      }) as LoadHistoryMock,
    });
    const pending = h.handleCommand("/verbose full");
    await entered.promise;
    expect(h.loadHistory).toHaveBeenCalledOnce();
    expect(h.refreshSessionInfo).not.toHaveBeenCalled();
    expect(h.clearTools).not.toHaveBeenCalled();
    h.addSystem.mockClear();
    h.state.currentAgentId = "ops";
    h.state.currentSessionKey = "agent:ops:public";
    followup.reject(new Error("private provider account rejected research tenant"));
    await pending;
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.state.currentAgentId).toBe("ops");
  });

  it("ignores a stale reset after the same session incarnation is replaced", async () => {
    const reset = createDeferred<{ ok: true; key: string; entry: { sessionId: string } }>();
    const h = createTuiCommandHandlersHarness({
      currentSessionId: "first-session",
      sessionGeneration: 4,
      resetSession: vi.fn(() => reset.promise),
      applySessionMutationResult: vi.fn().mockReturnValue(true),
    });
    const pending = h.handleCommand("/reset");
    expect(h.resetSession).toHaveBeenCalledExactlyOnceWith("agent:main:main", "reset", undefined);
    h.state.sessionGeneration += 1;
    h.state.currentSessionId = "second-session";
    reset.resolve({ ok: true, key: "agent:main:main", entry: { sessionId: "stale-reset" } });
    await pending;
    expect(h.state.currentSessionId).toBe("second-session");
    expect(h.applySessionMutationResult).not.toHaveBeenCalled();
    expect(h.refreshSessionInfo).not.toHaveBeenCalled();
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.addSystem).not.toHaveBeenCalled();
  });

  it("ignores a rejected global reset after switching agents", async () => {
    const deferred = createDeferred<never>();
    const harness = createTuiCommandHandlersHarness({
      currentSessionKey: "global",
      currentAgentId: "main",
      resetSession: vi.fn(() => deferred.promise),
    });

    const pending = harness.handleCommand("/reset");
    harness.state.currentAgentId = "work";
    deferred.reject(new Error("stale global reset"));
    await pending;

    expect(harness.applySessionMutationResult).not.toHaveBeenCalled();
    expect(harness.refreshSessionInfo).not.toHaveBeenCalled();
    expect(harness.loadHistory).not.toHaveBeenCalled();
    expect(harness.addSystem).not.toHaveBeenCalled();
  });

  it.each([
    ["thinkingLevel", "/think default", "gateway", false],
    ["fastMode", "/fast default", "embedded", true],
  ])("clears the %s session override for %s in %s mode", async (field, command, _mode, local) => {
    const { handleCommand, patchSession, refreshSessionInfo } = createTuiCommandHandlersHarness({
      opts: { local },
    });

    await handleCommand(command);

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      [field]: null,
    });
    expect(refreshSessionInfo).toHaveBeenCalledOnce();
  });

  it("rejects unsupported elevated mode without patching", async () => {
    const { handleCommand, patchSession, addSystem } = createTuiCommandHandlersHarness();

    await handleCommand("/elevated invalid");

    expect(patchSession).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("usage: /elevated <on|off|ask|full>");
  });

  it("uses the active session's supported thinking levels in help and command usage", async () => {
    const { handleCommand, addSystem } = createTuiCommandHandlersHarness({
      sessionInfo: {
        modelProvider: "minimax",
        model: "MiniMax-M3",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "max", label: "max" },
        ],
      },
    });

    await handleCommand("/help");
    await handleCommand("/think");

    expect(addSystem).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/think <off|max|default>"),
    );
    expect(addSystem).toHaveBeenNthCalledWith(2, "usage: /think <off|max|default>");
  });

  it("prefers a canonical thinking ID over another option's label", async () => {
    const h = createTuiCommandHandlersHarness({
      sessionInfo: {
        thinkingLevels: [
          { id: "low", label: "high" },
          { id: "high", label: "turbo" },
        ],
      },
    });
    await h.handleCommand("/think high");
    expect(h.patchSession).toHaveBeenCalledWith({ key: "agent:main:main", thinkingLevel: "high" });
    expect(h.addSystem).toHaveBeenCalledWith("thinking set to high");
  });

  it("resolves thinking labels from the provider policy when session levels are empty", async () => {
    const { handleCommand, patchSession } = createTuiCommandHandlersHarness({
      sessionInfo: {
        modelProvider: "opencode-go",
        model: "minimax-m3",
        thinkingLevels: [],
      },
    });

    await handleCommand("/think on");

    expect(patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      thinkingLevel: "high",
    });
  });

  it.each([
    { command: "verbose", usage: "usage: /verbose <on|off|full>" },
    { command: "reasoning", usage: "usage: /reasoning <on|off|stream>" },
  ])("shows the complete canonical no-argument /$command usage", async ({ command, usage }) => {
    const { handleCommand, addSystem, patchSession } = createTuiCommandHandlersHarness();

    await handleCommand(`/${command}`);

    expect(addSystem).toHaveBeenCalledWith(usage);
    expect(patchSession).not.toHaveBeenCalled();
  });

  it("hides tools locally for /verbose off without reloading history", async () => {
    const result = { entry: { verboseLevel: "off" } };
    const h = createTuiCommandHandlersHarness({ patchSession: vi.fn().mockResolvedValue(result) });
    await h.handleCommand("/verbose off");
    expect(h.patchSession).toHaveBeenCalledWith({ key: "agent:main:main", verboseLevel: "off" });
    expect(h.applySessionInfoFromPatch).toHaveBeenCalledWith(result);
    expect(h.clearTools).toHaveBeenCalledOnce();
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.loadHistory).not.toHaveBeenCalled();
  });

  it("refreshes session info for /trace without reloading history", async () => {
    const loadHistory = vi.fn().mockResolvedValue(undefined);
    const refreshSessionInfo = vi.fn().mockResolvedValue(undefined);
    const { handleCommand } = createTuiCommandHandlersHarness({
      loadHistory,
      refreshSessionInfo,
    });

    await handleCommand("/trace on");

    expect(refreshSessionInfo).toHaveBeenCalledTimes(1);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("redacts secrets and preserves nested causes in displayed send failures", async () => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const cause = new Error(`\u001b[31mAuthorization: Bearer ${secret}\u001b[0m`);
    const { handleCommand, addSystem, state, setActivityStatus } = createTuiCommandHandlersHarness({
      sendChat: vi.fn().mockRejectedValue(new Error("gateway down", { cause })),
    });

    await handleCommand("/context detail");

    const message = addSystem.mock.calls.at(-1)?.[0];
    expect(message).toContain("send failed: gateway down");
    expect(message).toContain("Authorization: Bearer");
    expect(message).not.toContain(secret);
    expect(message).not.toContain("\u001b");
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
    expect(state.pendingSubmit).toBeNull();
  });

  it("reports disconnected status and skips gateway send when offline", async () => {
    const { handleCommand, sendChat, addUser, addSystem, setActivityStatus } =
      createTuiCommandHandlersHarness({
        isConnected: false,
      });

    await handleCommand("/context detail");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith("not connected to gateway — message not sent");
    expect(setActivityStatus).toHaveBeenLastCalledWith("disconnected");
  });

  it("reserves the active assistant row before queueing a local prompt", async () => {
    const h = createTuiCommandHandlersHarness({
      opts: { local: true },
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });
    await h.handleCommand("continue here");
    expect(h.sendChat).toHaveBeenCalledOnce();
    expectSendChatFields(h.sendChat, { message: "continue here", sessionKey: "agent:main:main" });
    expect(h.reserveAssistantSlot).toHaveBeenCalledWith("run-active");
    expect(h.reserveAssistantSlot.mock.invocationCallOrder[0]).toBeLessThan(
      expectDefined(h.addPendingUser.mock.invocationCallOrder[0], "pending user call"),
    );
    expect(h.addPendingUser).toHaveBeenCalledWith(expect.any(String), "continue here");
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.requestRender).toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("run-active");
    expect(getPendingSubmitAcceptedRunId(h.state)).toEqual(expect.any(String));
  });

  it("routes slash stop to session abort when there is no tracked run", async () => {
    const abortActive = vi.fn().mockResolvedValue(undefined);
    const { handleCommand, sendChat, addPendingUser } = createTuiCommandHandlersHarness({
      abortActive,
    });

    await handleCommand("/stop");

    expect(abortActive).toHaveBeenCalledWith({ preferActive: true });
    expect(sendChat).not.toHaveBeenCalled();
    expect(addPendingUser).not.toHaveBeenCalled();
  });

  it("rejects normal sends while a queued submit is pending registration", async () => {
    const { handleCommand, sendChat, addUser, addSystem } = createTuiCommandHandlersHarness({
      activeChatRunId: "run-active",
      pendingSubmit: {
        phase: "accepted",
        runId: "run-queued",
        draftText: "queued",
      },
      activityStatus: "waiting",
    });

    await handleCommand("/context detail");

    expect(sendChat).not.toHaveBeenCalled();
    expect(addUser).not.toHaveBeenCalled();
    expect(addSystem).toHaveBeenCalledWith(
      "agent is busy — press Esc to abort before sending a new message",
      { coalesceConsecutive: true },
    );
  });

  it("does not restore a queued run that completes before the followup send fails", async () => {
    const send = createDeferred<never>();
    const sendChat = vi.fn(() => send.promise);
    const { handleCommand, state } = createTuiCommandHandlersHarness({
      sendChat,
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    const pendingSend = handleCommand("queued followup");
    await Promise.resolve();
    state.activeChatRunId = null;
    send.reject(new Error("network error"));
    await pendingSend;

    expect(state.activeChatRunId).toBeNull();
  });

  it("runs /auth through the local flow and refreshes session info", async () => {
    const h = createTuiCommandHandlersHarness({ opts: { local: true } });
    await h.handleCommand("/auth openai");
    expect(h.runAuthFlow).toHaveBeenCalledWith({ provider: "openai" });
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.addSystem).toHaveBeenCalledWith(
      "opening auth flow for openai; TUI will resume when it exits",
    );
    expect(h.addSystem).toHaveBeenCalledWith("auth flow finished for openai");
    expect(h.setActivityStatus).toHaveBeenLastCalledWith("idle");
  });

  it("shows the failed auth command and a safe terminal retry", async () => {
    const runAuthFlow = vi.fn().mockResolvedValue({
      exitCode: 1,
      signal: null,
      commandArgv: '["codex","login"]',
    });
    const { handleCommand, addSystem, setActivityStatus } = createTuiCommandHandlersHarness({
      opts: { local: true },
      runAuthFlow,
    });

    await handleCommand("/auth openai");

    expect(addSystem).toHaveBeenCalledWith(
      'auth flow failed (exit 1) — command argv: ["codex","login"]; retry provider login in a regular terminal to see its output',
    );
    expect(setActivityStatus).toHaveBeenLastCalledWith("error");
  });

  it("rejects /auth in non-local mode", async () => {
    const { handleCommand, addSystem } = createTuiCommandHandlersHarness();

    await handleCommand("/auth");

    expect(addSystem).toHaveBeenCalledWith("auth login is only available in local embedded mode");
  });

  it("blocks /auth while an optimistic run is still pending", async () => {
    const h = createTuiCommandHandlersHarness({
      opts: { local: true },
      pendingSubmit: { phase: "sending", runId: "run-pending", draftText: "pending" },
    });
    await h.handleCommand("/auth openai");
    expect(h.runAuthFlow).not.toHaveBeenCalled();
    expect(h.addSystem).toHaveBeenCalledWith("abort the current run before /auth");
  });

  it("patches the session for valid /activation values", async () => {
    const result = { groupActivation: "always" };
    const h = createTuiCommandHandlersHarness({ patchSession: vi.fn().mockResolvedValue(result) });
    await h.handleCommand("/activation always");
    expect(h.patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      groupActivation: "always",
    });
    expect(h.addSystem).toHaveBeenCalledWith("activation set to always");
    expect(h.applySessionInfoFromPatch).toHaveBeenCalledWith(result);
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
  });

  it("patches and reports auto fast mode", async () => {
    const result = { fastMode: "auto" };
    const h = createTuiCommandHandlersHarness({ patchSession: vi.fn().mockResolvedValue(result) });
    await h.handleCommand("/fast auto");
    expect(h.patchSession).toHaveBeenCalledWith({ key: "agent:main:main", fastMode: "auto" });
    expect(h.addSystem).toHaveBeenCalledWith("fast mode set to auto");
    expect(h.applySessionInfoFromPatch).toHaveBeenCalledWith(result);
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    h.state.sessionInfo.fastMode = "auto";
    await h.handleCommand("/fast status");
    expect(h.addSystem).toHaveBeenCalledWith("fast mode: auto");
  });

  it.each([
    ["cooldown", "Wait and retry, or choose another model."],
    [undefined, "Run openclaw models auth login or choose another model."],
  ])("keeps unavailable models visible without applying them: %s", async (reason, guidance) => {
    const h = createTuiCommandHandlersHarness({
      listModels: vi.fn().mockResolvedValue([
        {
          provider: "fixture",
          id: "waiting",
          name: "Waiting model",
          available: false,
          unavailableReason: reason,
        },
        { provider: "fixture", id: "ready", name: "Ready model", available: true },
      ]),
    });
    await h.handleCommand("/model");
    const selector = selectorOf(h);
    const unavailable = expectDefined(
      selector.items?.find((item) => item.value === "fixture/waiting"),
      "unavailable model",
    );
    selector.onSelect?.(unavailable);
    await flushAsyncSelect();
    expect(h.patchSession).not.toHaveBeenCalled();
    expect(unavailable.description).toContain(reason ?? "unavailable");
    expect(h.addSystem).toHaveBeenCalledWith(
      `model unavailable: ${reason ?? "unavailable"}. ${guidance}`,
    );
  });

  it.each([["/model default", true]])(
    "forwards %s through the server directive path (local: %s)",
    async (command, local) => {
      const sendChat = vi.fn().mockResolvedValue({ status: "ok" });
      const patchSession = vi.fn();
      const { handleCommand } = createTuiCommandHandlersHarness({
        sendChat,
        patchSession,
        opts: { local },
      });

      await handleCommand(command);

      expectSendChatFields(sendChat, {
        message: command,
        sessionKey: "agent:main:main",
      });
      expect(patchSession).not.toHaveBeenCalled();
    },
  );

  it("shows the resolved model reference including a nested provider prefix", async () => {
    const h = createTuiCommandHandlersHarness({
      patchSession: vi.fn().mockResolvedValue({
        entry: {},
        resolved: { modelProvider: "nvidia", model: "moonshotai/kimi-k2.5" },
      }),
    });
    await h.handleCommand("/model kimi");
    expect(h.patchSession).toHaveBeenCalledWith(expect.objectContaining({ model: "kimi" }));
    expect(h.addSystem).toHaveBeenCalledWith("model set to nvidia/moonshotai/kimi-k2.5");
  });

  it("keeps known choices interactive and updates an open picker without losing its search or selection", async () => {
    const held = createDeferred<Array<{ provider: string; id: string; name: string }>>();
    let known = [
      { provider: "fixture", id: "known-a", name: "Known A" },
      { provider: "fixture", id: "known-b", name: "Known B" },
      { provider: "fixture", id: "unrelated", name: "Other choice" },
    ];
    const harness = createTuiCommandHandlersHarness({
      getKnownModels: () => known,
      listModels: vi.fn(() => held.promise),
    });
    await harness.handleCommand("/models");
    const selector = firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
    selector.handleInput("known");
    selector.handleInput("\u001b[B");
    expect(selector.render(100).join("\n")).toContain("fixture/known-b");
    known = [{ provider: "signed-in", id: "known-new", name: "New provider" }, ...known];
    harness.client.onModelsChanged?.("main");
    expect(selector.render(100).join("\n")).toContain("signed-in/known-new");
    expect(selector.render(100).join("\n")).not.toContain("fixture/unrelated");
    selector.handleInput("\r");
    await flushAsyncSelect();
    expect(harness.patchSession).toHaveBeenCalledWith({
      key: "agent:main:main",
      model: "fixture/known-b",
    });
    held.resolve(known);
  });

  it.each(["models", "sessions"] as const)(
    "does not publish stale %s choices after the same session key is reset",
    async (picker) => {
      const deferred = createDeferred<unknown>();
      const harness = createTuiCommandHandlersHarness({
        currentSessionKey: "agent:main:main",
        currentSessionId: "private-session",
        sessionGeneration: 2,
        ...(picker === "models"
          ? { listModels: vi.fn(() => deferred.promise) }
          : { listSessions: vi.fn(() => deferred.promise) }),
      });

      const pending = harness.handleCommand(`/${picker}`);
      harness.state.currentSessionId = "replacement-session";
      harness.state.sessionGeneration += 1;
      deferred.resolve(
        picker === "models"
          ? [{ provider: "openai", id: "gpt-5.6-luna" }]
          : { sessions: [{ key: "agent:main:main", updatedAt: 1 }] },
      );
      await pending;

      if (picker === "models") {
        const selector = firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
        expect(selector.items).toEqual([]);
      } else {
        expect(harness.openOverlay).not.toHaveBeenCalled();
      }
      expect(harness.addSystem).not.toHaveBeenCalled();
    },
  );

  it("forwards /usage cost to the Gateway without patching the usage footer", async () => {
    const { handleCommand, sendChat, patchSession, addSystem, runUsageCostCommand } =
      createTuiCommandHandlersHarness();

    await handleCommand("/usage cost");

    expect({
      systemMessages: addSystem.mock.calls.map(([message]) => message),
      sessionPatches: patchSession.mock.calls.length,
      gatewaySends: sendChat.mock.calls.length,
    }).toEqual({ systemMessages: [], sessionPatches: 0, gatewaySends: 1 });
    expectSendChatFields(sendChat, { message: "/usage cost" });
    expect(runUsageCostCommand).not.toHaveBeenCalled();
  });

  it("runs global /usage cost for the selected agent without submitting a model turn", async () => {
    const h = createTuiCommandHandlersHarness({
      opts: { local: true },
      currentSessionKey: "global",
      currentAgentId: "work",
    });
    await h.handleCommand("/usage cost");
    expect(h.runUsageCostCommand).toHaveBeenCalledWith({ sessionKey: "global", agentId: "work" });
    expect(h.addSystem).toHaveBeenCalledWith("💸 Usage cost");
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(h.patchSession).not.toHaveBeenCalled();
    expect(h.addPendingUser).not.toHaveBeenCalled();
  });

  it("keeps an unavailable local usage-cost operation out of model prompts", async () => {
    const harness = createTuiCommandHandlersHarness({
      opts: { local: true },
      runUsageCostCommand: null,
    });

    await harness.handleCommand("/usage cost");

    expect(harness.addSystem).toHaveBeenCalledWith(
      "/usage cost is not available in local embedded mode; message not sent",
    );
    expect(harness.sendChat).not.toHaveBeenCalled();
    expect(harness.patchSession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "suppresses a stale usage-cost completion (failure: %s)",
    async (fails) => {
      const cost = createDeferred<{ text: string }>();
      const h = createTuiCommandHandlersHarness({
        opts: { local: true },
        currentSessionId: "original-session",
        runUsageCostCommand: vi.fn(() => cost.promise),
      });
      const pending = h.handleCommand("/usage cost");
      h.state.currentSessionId = "replacement-session";
      if (fails) {
        cost.reject(new Error("stale cost failure"));
      } else {
        cost.resolve({ text: "stale usage cost" });
      }
      await pending;
      expect(h.addSystem).not.toHaveBeenCalled();
      expect(h.sendChat).not.toHaveBeenCalled();
    },
  );

  it("shows current-session usage-cost failures without invoking the model", async () => {
    const runUsageCostCommand = vi.fn().mockRejectedValue(new Error("session costs unavailable"));
    const harness = createTuiCommandHandlersHarness({ opts: { local: true }, runUsageCostCommand });

    await harness.handleCommand("/usage cost");

    expect(harness.addSystem).toHaveBeenCalledWith("usage cost failed: session costs unavailable");
    expect(harness.sendChat).not.toHaveBeenCalled();
  });

  it("/usage cycles from the inherited effective mode when its override is unset", async () => {
    const h = createTuiCommandHandlersHarness({
      sessionInfo: { effectiveResponseUsage: "tokens" },
    });
    await h.handleCommand("/usage");
    expect(h.patchSession).toHaveBeenCalledWith(expect.objectContaining({ responseUsage: "full" }));
    expect(h.addSystem).toHaveBeenCalledWith("usage footer: full");
  });

  it("allows colon-form /queue directives during an active run", async () => {
    const { handleCommand, sendChat } = createTuiCommandHandlersHarness({
      activeChatRunId: "run-active",
      activityStatus: "streaming",
    });

    await handleCommand("/queue:followup");

    expectSendChatFields(sendChat, { message: "/queue:followup" });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
