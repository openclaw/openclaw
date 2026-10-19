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
  createTuiCommandHandlersHarness as createHarness,
  expectSendChatFields,
  firstMockArg,
  flushAsyncSelect,
} from "./tui-command-handlers-test-support.js";
import { expectUnused, expectCall, textMessage, clearMocks } from "./tui-handler-test-support.js";
import {
  TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
  TUI_SESSION_PICKER_LIMIT,
} from "./tui-session-list-policy.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import { getPendingSubmitAcceptedRunId, getPendingSubmitDraft } from "./tui-submit-state.js";

type Harness = ReturnType<typeof createHarness>;
type HarnessParams = NonNullable<Parameters<typeof createHarness>[0]>;

function localHarness(params: HarnessParams = {}) {
  return createHarness({ ...params, opts: { local: true } });
}

function expectNoSessionCompletion(h: Harness, ...mocks: ReturnType<typeof vi.fn>[]) {
  expectUnused(h.refreshSessionInfo, h.loadHistory, h.addSystem, ...mocks);
}

function selectorOf(harness: Harness): SelectableOverlay {
  return firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
}

function userMessage(id: string, seq: number, runId: string) {
  return {
    ...textMessage("hello", "user"),
    __openclaw: { id, seq, idempotencyKey: `${runId}:user` },
  };
}

type SettingOptions = HarnessParams & {
  message?: string;
  result?: object;
};

describe("tui command handlers", () => {
  it("reopens /question locally without sending a chat turn", async () => {
    const reopenQuestion = vi.fn();
    const h = localHarness({ reopenQuestion });
    await h.handleCommand("/question");
    expect(reopenQuestion).toHaveBeenCalledOnce();
    expectUnused(h.sendChat, h.addPendingUser);
  });

  it("does not open an agent picker from a cached roster after refresh failure", async () => {
    const h = createHarness({
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
    const h = createHarness({
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
    const h = createHarness({ listModels: vi.fn(() => models.promise) });
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
    const harness = createHarness({
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
    const h = createHarness({
      listModels: vi.fn().mockResolvedValue([{ provider: "openrouter", id: "openrouter/auto" }]),
      patchSession: vi.fn(() => pending.promise),
    });
    await h.handleCommand("/models");
    const selector = selectorOf(h);
    expect(selector.items?.[0]?.value).toBe("openrouter/auto");
    selector.onSelect?.({ value: "openrouter/auto" });
    expect(h.closeOverlay).toHaveBeenCalledExactlyOnceWith(h.overlayHandle);
    selector.onSelect?.({ value: "openrouter/auto" });
    expectCall(h.patchSession, [{ key: "agent:main:main", model: "openrouter/auto" }], "once");
    pending.resolve();
    await flushAsyncSelect();
    expect(h.closeOverlay).toHaveBeenCalledOnce();
  });

  it("retires an open session picker when its session incarnation is replaced", async () => {
    const h = createHarness({
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

  it.each([false, true])("picker failure (replaced=%s)", async (replaced) => {
    const selection = createDeferred();
    const h = createHarness({
      currentSessionId: "private-session",
      sessionGeneration: 2,
      listSessions: vi.fn().mockResolvedValue({ sessions: [{ key: "agent:main:other" }] }),
      agents: [{ id: "work" }],
      setSession: vi.fn(() => selection.promise) as SetSessionMock,
    });
    await h.handleCommand(replaced ? "/sessions" : "/agent");
    selectorOf(h).onSelect?.({ value: replaced ? "agent:main:other" : "work" });
    if (replaced) {
      h.state.currentSessionId = "replacement-session";
      h.state.sessionGeneration += 1;
    }
    selection.reject(new Error("gateway unavailable"));
    await flushAsyncSelect();
    expect(h.closeOverlay).toHaveBeenCalledExactlyOnceWith(h.overlayHandle);
    if (replaced) {
      expect(h.addSystem).not.toHaveBeenCalled();
    } else {
      expect(h.addSystem).toHaveBeenCalledWith(expect.stringContaining("gateway unavailable"));
    }
  });

  it("scopes an explicit timeout override to one message", async () => {
    const h = createHarness();
    await h.sendMessage("automatic hatch", 300_000);
    h.state.pendingSubmit = null;
    await h.handleCommand("do not do that");
    expect(h.sendChat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ message: "automatic hatch", timeoutMs: 300_000 }),
    );
    expect(h.sendChat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ message: "do not do that", timeoutMs: undefined }),
    );
  });

  it("projects a pending send, binds its session and re-keys its ACK in place", async () => {
    const deferred = createDeferred<{ runId: string }>();
    const h = createHarness({ sendChat: vi.fn(() => deferred.promise) });
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
          ...textMessage("hello", "user"),
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
    expect(h.state).toMatchObject({ currentSessionId: "session-created", activeChatRunId: null });
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
    const h = createHarness({ sendChat: vi.fn(() => deferred.promise) });
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

  it.each(["observed", "consumed", "completed"] as const)("ACK after %s run", async (phase) => {
    const consumeCompletedRunForPendingSend = vi.fn((id: string) => id === "accepted-run");
    const flushPendingHistoryRefreshIfIdle = vi.fn();
    const sendChat = vi.fn(async ({ runId }: { runId: string }) => {
      if (phase === "consumed") {
        h.state.pendingSubmit = null;
      }
      return { runId: phase === "consumed" ? runId : "accepted-run" };
    });
    const h = createHarness({
      sendChat,
      ...(phase === "observed" ? { isRunObserved: (id: string) => id === "accepted-run" } : {}),
      ...(phase === "completed"
        ? { consumeCompletedRunForPendingSend, flushPendingHistoryRefreshIfIdle }
        : {}),
    });
    await h.handleCommand("hello");
    if (phase === "observed") {
      expect(h.rekeyPendingUser).toHaveBeenCalledWith(expect.any(String), "accepted-run");
      expect(getPendingSubmitDraft(h.state)).toBeNull();
    } else {
      expect(h.state.pendingSubmit).toBeNull();
    }
    if (phase === "completed") {
      expect(consumeCompletedRunForPendingSend).toHaveBeenCalledWith("accepted-run");
      expect(h.forgetLocalRunId).toHaveBeenCalledWith(h.addPendingUser.mock.calls[0]?.[0]);
      expect(h.noteLocalRunId).not.toHaveBeenCalledWith("accepted-run");
      expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
      expect(flushPendingHistoryRefreshIfIdle).toHaveBeenCalledOnce();
      expect(h.addPendingUser).toHaveBeenCalledOnce();
      expect(h.dropPendingUser).not.toHaveBeenCalled();
    }
  });

  it.each(["/status", "/context", "/usage cost"])(
    "unsupported local command: %s",
    async (command) => {
      const h = localHarness({ runUsageCostCommand: null });
      await h.handleCommand(command);
      expectUnused(h.sendChat, h.addPendingUser, h.patchSession);
      expect(h.addSystem).toHaveBeenCalledWith(
        `${command} is not available in local embedded mode; message not sent`,
      );
    },
  );

  it.each([
    { command: "/side check this", local: true },
    { command: "/not-a-real-command", local: true },
    { command: "/goal status", local: false },
    { command: "/model default", local: true },
    { command: "/usage cost", local: false },
    { command: "/queue:followup", local: false },
  ])("forwards $command without applying a client-side setting", async ({ command, local }) => {
    const h = createHarness({
      opts: { local },
      ...(command === "/model default"
        ? { sendChat: vi.fn().mockResolvedValue({ status: "ok" }) }
        : {}),
      ...(command === "/queue:followup"
        ? { activeChatRunId: "run-active", activityStatus: "streaming" }
        : {}),
    });
    await h.handleCommand(command);
    expectSendChatFields(h.sendChat, { sessionKey: "agent:main:main", message: command });
    expect(h.sendChat).toHaveBeenCalledOnce();
    expectUnused(h.patchSession, h.runGoalCommand, h.addSystem);
    expect(h.runUsageCostCommand).not.toHaveBeenCalled();
  });

  it.each(["/goal start ship", "/usage cost"])(
    "local global-agent command: %s",
    async (command) => {
      const h = localHarness({
        currentSessionKey: "global",
        currentAgentId: "work",
        runGoalCommand: vi
          .fn()
          .mockResolvedValue({ text: "Goal started: ship", continuationPrompt: "ship" }),
      });
      await h.handleCommand(command);
      if (command === "/goal start ship") {
        expectCall(h.runGoalCommand, [{ sessionKey: "global", agentId: "work", command }]);
        expectSendChatFields(h.sendChat, {
          sessionKey: "global",
          agentId: "work",
          message: "ship",
        });
        expect(h.addPendingUser).toHaveBeenCalledWith(expect.any(String), "ship");
        expect(h.addSystem).toHaveBeenCalledWith("Goal started: ship");
        expect(h.refreshSessionInfo).toHaveBeenCalled();
      } else {
        expect(h.runUsageCostCommand).toHaveBeenCalledWith({
          sessionKey: "global",
          agentId: "work",
        });
        expect(h.addSystem).toHaveBeenCalledWith("💸 Usage cost");
        expectUnused(h.sendChat, h.patchSession, h.addPendingUser);
      }
    },
  );

  it.each([
    { command: "/goal start private objective", fails: false },
    { command: "/goal start private objective", fails: true },
    { command: "/usage cost", fails: false },
    { command: "/usage cost", fails: true },
  ])("stale $command result (fails=$fails)", async ({ command, fails }) => {
    const result = createDeferred<{ text: string; continuationPrompt?: string }>();
    const goal = command.startsWith("/goal");
    const h = localHarness({
      currentSessionId: "private-session",
      sessionGeneration: 4,
      ...(goal
        ? { runGoalCommand: vi.fn(() => result.promise) }
        : { runUsageCostCommand: vi.fn(() => result.promise) }),
    });
    const pending = h.handleCommand(command);
    if (goal) {
      h.state.sessionGeneration += 1;
    } else {
      h.state.currentSessionId = "replacement-session";
    }
    if (fails) {
      result.reject(new Error("private research failure"));
    } else {
      result.resolve({ text: "private status", continuationPrompt: "PRIVATE_OBJECTIVE" });
    }
    await pending;
    expectUnused(h.sendChat, h.addSystem, h.refreshSessionInfo);
  });

  it("does not send an old goal continuation after its session changes during refresh", async () => {
    const refresh = createDeferred();
    const harness = localHarness({
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

  it("sends the selected context mode through the gateway command path", async () => {
    const h = createHarness();
    await h.handleCommand("/context");
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(h.openOverlay).toHaveBeenCalledOnce();
    const selector = firstMockArg(h.openOverlay, "openOverlay") as SelectableOverlay;
    selector?.onSelect?.({ value: "detail", label: "detail" });
    await flushAsyncSelect();
    expectSendChatFields(h.sendChat, { sessionKey: "agent:main:main", message: "/context detail" });
    expect(h.closeOverlay).toHaveBeenCalledExactlyOnceWith(h.overlayHandle);
  });

  it("keeps gateway diagnostics on /gateway-status", async () => {
    const h = createHarness({
      getGatewayStatus: vi.fn().mockResolvedValue({
        runtimeVersion: "1.2.3",
        channelSummary: ["Telegram: not configured"],
        sessions: { count: 2, defaults: { model: "gpt-5.4", contextTokens: 200000 } },
      }),
    });
    await h.handleCommand("/gateway-status");
    expect(h.getGatewayStatus).toHaveBeenCalledTimes(1);
    expectUnused(h.addUser, h.sendChat);
    expect(h.addSystem).toHaveBeenCalledWith("Gateway status");
    expect(h.addSystem).toHaveBeenCalledWith("Version: 1.2.3");
    expect(h.addSystem).toHaveBeenCalledWith("  Telegram: not configured");
    expect(h.addSystem).toHaveBeenCalledWith("Stored sessions: 2");
    expect(h.addSystem).not.toHaveBeenCalledWith("Active sessions: 2");
  });

  it("returns to OpenClaw with an optional request", async () => {
    const h = createHarness();
    await h.handleCommand("/openclaw restart gateway");
    expect(h.sendChat).not.toHaveBeenCalled();
    expect(h.addSystem).toHaveBeenCalledWith("returning to OpenClaw with request: restart gateway");
    expect(h.requestExit).toHaveBeenCalledWith({
      exitReason: "return-to-system-agent",
      systemAgentMessage: "restart gateway",
    });
  });

  it.each([false, true])("stale send ACK (rejected=%s)", async (rejected) => {
    const deferred = createDeferred<{ runId: string; status: string }>();
    const h = createHarness({
      currentSessionId: rejected ? null : "old-session",
      sendChat: vi.fn(() => deferred.promise),
    });
    const sending = h.handleCommand("old prompt");
    const localRunId = h.addPendingUser.mock.calls[0]?.[0];
    if (!rejected) {
      expectSendChatFields(h.sendChat, { message: "old prompt", sessionId: "old-session" });
    }
    const nextProjection = rejected
      ? createSessionProjection({ sessionKey: "agent:work:second", agentId: "work" })
      : createSessionProjection(
          { sessionKey: "agent:main:main", agentId: "main", sessionId: "replacement-session" },
          [userMessage("new-user", 1, "new-run")],
        );
    if (rejected) {
      h.state.currentAgentId = "work";
      h.state.currentSessionKey = "agent:work:second";
    } else {
      h.state.currentSessionId = "replacement-session";
      h.state.activeChatRunId = "new-active";
      h.state.activityStatus = "streaming";
    }
    h.state.sessionProjection = nextProjection;
    const pendingSubmit = {
      phase: "accepted" as const,
      runId: "new-pending",
      draftText: rejected ? null : "new draft",
    };
    h.state.pendingSubmit = { ...pendingSubmit };
    if (rejected) {
      deferred.reject(new Error("old gateway failure"));
    } else {
      deferred.resolve({ runId: "old-accepted", status: "error" });
    }
    await sending;
    expect(h.state.sessionProjection).toBe(nextProjection);
    expect(h.state.pendingSubmit).toEqual(pendingSubmit);
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.forgetLocalRunId).toHaveBeenCalledWith(localRunId);
    if (rejected) {
      expect(h.dropPendingUser).not.toHaveBeenCalled();
    } else {
      expect(h.state.activeChatRunId).toBe("new-active");
      expect(h.loadHistory).not.toHaveBeenCalled();
      expect(h.setActivityStatus).toHaveBeenCalledExactlyOnceWith("sending");
      expect(h.forgetLocalRunId).toHaveBeenCalledWith("old-accepted");
    }
  });

  it.each(["timeout", "ok"] as const)("terminal ACK: %s", async (status) => {
    const sendChat = vi.fn(async ({ runId }: { runId: string }) => ({
      runId: status === "timeout" ? "accepted-failed-run" : runId,
      status,
    }));
    const loadHistory = vi.fn<() => Promise<void>>(async () => {
      h.addSystem.mockClear();
    });
    const h = createHarness({ sendChat, loadHistory });
    await h.handleCommand("hello");
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.loadHistory).toHaveBeenCalledOnce();
    if (status === "timeout") {
      const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
      expect(h.dropPendingUser).toHaveBeenCalledWith("accepted-failed-run");
      expect(h.rekeyPendingUser).toHaveBeenCalledWith(sentRunId, "accepted-failed-run");
      expect(h.state.sessionProjection?.entries).toEqual([]);
      expectCall(h.addSystem, ["send failed: Chat failed before the run started; try again."]);
      expect(h.setActivityStatus).toHaveBeenLastCalledWith("error");
    } else {
      expect(h.dropPendingUser).not.toHaveBeenCalled();
      expect(h.state.sessionProjection?.entries).toHaveLength(1);
      expect(h.setActivityStatus).toHaveBeenLastCalledWith("idle", "completed");
    }
  });

  it.each(["active", "pending"] as const)(
    "keeps %s work visible after another send completes with a terminal ACK",
    async (remaining) => {
      const loadHistory = vi.fn<() => Promise<void>>(async () => {
        h.state.activeChatRunId = remaining === "active" ? "other-run" : null;
        h.state.pendingSubmit =
          remaining === "pending"
            ? { phase: "accepted", runId: "other-run", draftText: null }
            : null;
        h.state.activityStatus = remaining === "active" ? "streaming" : "waiting";
        h.setActivityStatus.mockClear();
      });
      const h = createHarness({
        activeChatRunId: "other-run",
        sendChat: vi.fn(async ({ runId }: { runId: string }) => ({ runId, status: "ok" })),
        loadHistory,
      });
      await h.handleCommand("hello");
      expect(loadHistory).toHaveBeenCalledOnce();
      expect(h.setActivityStatus).not.toHaveBeenCalled();
      expect(h.state.activityStatus).toBe(remaining === "active" ? "streaming" : "waiting");
    },
  );

  it("ignores a terminal ACK after its history reload switches sessions", async () => {
    const history = createDeferred();
    const entered = createDeferred();
    const h = createHarness({
      sendChat: vi.fn(async ({ runId }: { runId: string }) => ({ runId, status: "error" })),
      loadHistory: vi.fn(() => {
        entered.resolve();
        return history.promise;
      }) as LoadHistoryMock,
    });
    const pending = h.handleCommand("private provider request");
    await entered.promise;
    clearMocks(h.addSystem, h.setActivityStatus);
    h.state.currentAgentId = "ops";
    h.state.currentSessionKey = "agent:ops:public";
    h.state.activeChatRunId = "public-run";
    h.state.pendingSubmit = { phase: "accepted", runId: "public-run", draftText: null };
    history.resolve();
    await pending;
    expectUnused(h.addSystem, h.setActivityStatus);
    expect(h.state.activeChatRunId).toBe("public-run");
    expect(h.state.pendingSubmit?.runId).toBe("public-run");
  });

  it.each(["error", "ok", "in_flight"] as const)("detached BTW ACK: %s", async (status) => {
    const h = createHarness({
      sendChat: vi.fn().mockResolvedValue({ runId: "accepted-btw", status }),
      activeChatRunId: "run-main",
    });
    await h.handleCommand(
      status === "in_flight" ? "/btw continue detached" : "/side finish detached",
    );
    const sent = firstMockArg(h.sendChat, "sendChat") as { runId: string };
    expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
    expect(h.state).toMatchObject({ activeChatRunId: "run-main", pendingSubmit: null });
    if (status === "in_flight") {
      expect(h.noteLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
      expect(h.noteLocalBtwRunId).toHaveBeenCalledWith("accepted-btw");
      expectUnused(h.noteLocalRunId, h.addUser);
      expect(h.state.sessionProjection).toBeUndefined();
      expect(h.setActivityStatus).not.toHaveBeenCalled();
    } else {
      expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith("accepted-btw");
    }
    if (status === "error") {
      expectCall(h.addSystem, ["btw failed: Chat failed before the run started; try again."]);
    } else {
      expect(h.addSystem).not.toHaveBeenCalled();
    }
  });

  it.each(["persisted peer", "completed run", "secret-bearing cause"] as const)(
    "send failure: %s",
    async (scenario) => {
      const peer = userMessage("peer-user", 4, "peer-run");
      const send = createDeferred<never>();
      const secret = "sk-abcdefghijklmnopqrstuv";
      const h = createHarness({
        sendChat: vi.fn(() => send.promise),
        activeChatRunId: "run-active",
        activityStatus: "streaming",
        sessionProjection: createSessionProjection(
          { sessionKey: "agent:main:main", agentId: "main" },
          [peer],
        ),
      });
      const pending = h.handleCommand(
        scenario === "secret-bearing cause" ? "/context detail" : "hello",
      );
      await Promise.resolve();
      if (scenario === "completed run") {
        h.state.activeChatRunId = null;
      }
      send.reject(
        scenario === "secret-bearing cause"
          ? new Error("gateway down", {
              cause: new Error(`\u001b[31mAuthorization: Bearer ${secret}\u001b[0m`),
            })
          : new Error("local send failed"),
      );
      await pending;
      expect(h.state).toMatchObject({
        activeChatRunId: scenario === "completed run" ? null : "run-active",
        pendingSubmit: null,
      });
      expect(h.dropPendingUser).toHaveBeenCalledWith(h.addPendingUser.mock.calls[0]?.[0]);
      expect(h.state.sessionProjection?.messages).toEqual([peer]);
      expect(h.state.sessionProjection?.entries[0]).toMatchObject({
        pending: false,
        pendingRunId: null,
      });
      if (scenario === "secret-bearing cause") {
        const message = h.addSystem.mock.calls.at(-1)?.[0];
        expect(message).toContain("send failed: gateway down");
        expect(message).toContain("Authorization: Bearer");
        expect(message).not.toContain(secret);
        expect(message).not.toContain("\u001b");
        expect(h.setActivityStatus).toHaveBeenLastCalledWith("error");
      }
    },
  );

  it.each([true, false])("scopes an adopted /new completion (failure: %s)", async (fails) => {
    const adoption = createDeferred();
    const entered = createDeferred();
    const createdKey = "agent:main:private-child";
    const h = createHarness({
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
      expectCall(h.addSystem, ["new session failed: replacement history unavailable"]);
    } else {
      expect(h.addSystem).not.toHaveBeenCalled();
    }
  });

  it.each(["new", "reset"] as const)("busy session blocks /%s", async (command) => {
    const h = createHarness(
      command === "new"
        ? { activityStatus: "finishing context" }
        : {
            pendingSubmit: { phase: "sending", runId: "pending-run", draftText: "pending" },
            activityStatus: "sending",
          },
    );
    await h.handleCommand(`/${command}`);
    expectUnused(h.createSession, h.resetSession);
    expect(h.addSystem).toHaveBeenCalledWith(`abort the current run before /${command}`);
  });

  it.each(["new", "reset"] as const)("/%s serializes admission", async (command) => {
    const transition = createDeferred<{ ok: true; key: string; entry: { sessionId: string } }>();
    const result = {
      ok: true as const,
      key: command === "new" ? "agent:work:tui-created" : "agent:main:replacement",
      entry: { sessionId: "replacement-session" },
    };
    const h = createHarness({
      ...(command === "new"
        ? {
            currentSessionKey: "global",
            currentAgentId: "work",
            currentSessionId: "parent-session",
          }
        : {}),
      ...(command === "new"
        ? { createSession: vi.fn(() => transition.promise) }
        : { resetSession: vi.fn(() => transition.promise) }),
      applySessionMutationResult: vi.fn((value: typeof result) => {
        h.state.currentSessionKey = value.key;
        h.state.currentSessionId = value.entry.sessionId;
        return true;
      }),
    });
    const pending = h.handleCommand(`/${command}`);
    expect(h.resolveMessageAdmission("must not reach resetting session")).toEqual({
      status: "blocked",
      reason: "session-transition",
      command,
    });
    await h.sendMessage("must not reach resetting session");
    await h.handleCommand(`/${command}`);
    expect(h.sendChat).not.toHaveBeenCalled();
    expectCall(h.addSystem, [`session change in progress; wait for /${command} to finish`]);
    if (command === "new") {
      expect(h.createSession).toHaveBeenCalledExactlyOnceWith({
        key: expect.stringMatching(/^tui-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
        agentId: "work",
        parentSessionKey: "global",
        succeedsParent: true,
      });
    } else {
      expectCall(h.resetSession, ["agent:main:main", "reset", undefined], "once");
    }
    transition.resolve(result);
    await pending;
    if (command === "new") {
      expect(h.setSession).toHaveBeenCalledExactlyOnceWith(result.key);
      expect(h.addSystem).toHaveBeenCalledWith(`new session: ${result.key}`);
      return;
    }
    expect(h.applySessionMutationResult).toHaveBeenCalledExactlyOnceWith(result, {
      sessionKey: "agent:main:main",
      agentId: "main",
    });
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.state).toMatchObject({
      currentSessionKey: result.key,
      currentSessionId: result.entry.sessionId,
    });
    expect(h.addSystem).toHaveBeenCalledWith("session agent:main:replacement reset");
  });

  it("reloads a global session after /reset returns no session entry", async () => {
    const h = createHarness({
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
      ...textMessage("preserve failed reset", "user"),
      __openclaw: { id: "before-failed-reset", seq: 1 },
    };
    const sessionProjection = createSessionProjection(
      { sessionKey: "agent:main:main", agentId: "main" },
      [message],
    );
    const harness = createHarness({
      resetSession: vi.fn().mockRejectedValue(new Error("\u001b[31mreset unavailable\u001b[0m")),
      sessionProjection,
    });
    await harness.handleCommand("/reset");
    expect(harness.state.sessionProjection?.messages).toEqual([message]);
    expect(harness.applySessionMutationResult).not.toHaveBeenCalled();
    expect(harness.addSystem).toHaveBeenCalledWith("reset failed: reset unavailable");
  });

  it.each<[string, object, SettingOptions?]>([
    [
      "/fast on",
      { key: "global", agentId: "work", fastMode: true },
      {
        currentSessionKey: "global",
        currentAgentId: "work",
        result: { fastMode: true },
      },
    ],
    ["/think default", { thinkingLevel: null }],
    ["/fast default", { fastMode: null }, { opts: { local: true } }],
    [
      "/think high",
      { thinkingLevel: "high" },
      {
        sessionInfo: {
          thinkingLevels: [
            { id: "low", label: "high" },
            { id: "high", label: "turbo" },
          ],
        },
        message: "thinking set to high",
      },
    ],
    [
      "/think on",
      { thinkingLevel: "high" },
      {
        sessionInfo: { modelProvider: "opencode-go", model: "minimax-m3", thinkingLevels: [] },
      },
    ],
    ["/verbose off", { verboseLevel: "off" }, { result: { entry: { verboseLevel: "off" } } }],
    ["/trace on", { traceLevel: "on" }],
    [
      "/activation always",
      { groupActivation: "always" },
      { result: { groupActivation: "always" }, message: "activation set to always" },
    ],
    [
      "/fast auto",
      { fastMode: "auto" },
      { result: { fastMode: "auto" }, message: "fast mode set to auto" },
    ],
    [
      "/model kimi",
      { model: "kimi" },
      {
        result: { entry: {}, resolved: { modelProvider: "nvidia", model: "moonshotai/kimi-k2.5" } },
        message: "model set to nvidia/moonshotai/kimi-k2.5",
      },
    ],
    [
      "/usage",
      { responseUsage: "full" },
      {
        sessionInfo: { effectiveResponseUsage: "tokens" },
        message: "usage footer: full",
      },
    ],
  ])("session setting: %s", async (command, patch, options: SettingOptions = {}) => {
    const { message, result, ...params } = options;
    const h = createHarness({ ...params, patchSession: vi.fn().mockResolvedValue(result ?? {}) });
    await h.handleCommand(command);
    expect(h.patchSession).toHaveBeenCalledWith({ key: "agent:main:main", ...patch });
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.loadHistory).not.toHaveBeenCalled();
    if (message) {
      expect(h.addSystem).toHaveBeenCalledWith(message);
    }
    if (result) {
      expect(h.applySessionInfoFromPatch).toHaveBeenCalledWith(result);
    }
    if (command === "/verbose off") {
      expect(h.clearTools).toHaveBeenCalledOnce();
    }
    if (command === "/fast auto") {
      h.state.sessionInfo.fastMode = "auto";
      await h.handleCommand("/fast status");
      expect(h.addSystem).toHaveBeenCalledWith("fast mode: auto");
    }
  });

  it.each(["/reasoning on", "/usage full", "/elevated ask"])("stale patch: %s", async (command) => {
    const patch = createDeferred<{ entry: { model: string } }>();
    const h = createHarness({
      currentSessionKey: "global",
      currentAgentId: "main",
      sessionInfo: { responseUsage: "tokens", effectiveResponseUsage: "tokens" },
      patchSession: vi.fn(() => patch.promise),
    });
    const pending = h.handleCommand(command);
    expectCall(h.patchSession, [expect.objectContaining({ key: "global", agentId: "main" })]);
    h.state.currentAgentId = "work";
    patch.resolve({ entry: { model: "stale-model" } });
    await pending;
    expect(h.state.sessionInfo).toEqual({
      responseUsage: "tokens",
      effectiveResponseUsage: "tokens",
    });
    expectNoSessionCompletion(h, h.applySessionInfoFromPatch, h.clearTools);
  });

  it("clears inherited usage before a nested patch handoff changes agents", async () => {
    const appliedAgents: string[] = [];
    const displayedAgents: string[] = [];
    const h = createHarness({
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
    const h = createHarness({
      loadHistory: vi.fn(() => {
        entered.resolve();
        return followup.promise;
      }) as LoadHistoryMock,
    });
    const pending = h.handleCommand("/verbose full");
    await entered.promise;
    expect(h.loadHistory).toHaveBeenCalledOnce();
    expectUnused(h.refreshSessionInfo, h.clearTools);
    h.addSystem.mockClear();
    h.state.currentAgentId = "ops";
    h.state.currentSessionKey = "agent:ops:public";
    followup.reject(new Error("private provider account rejected research tenant"));
    await pending;
    expect(h.addSystem).not.toHaveBeenCalled();
    expect(h.state.currentAgentId).toBe("ops");
  });

  it.each([
    { command: "new", fails: false },
    { command: "new", fails: true },
    { command: "reset", fails: false },
    { command: "reset", fails: true },
  ] as const)("stale /$command (fails=$fails)", async ({ command, fails }) => {
    const transition = createDeferred<{ ok: true; key: string; entry: { sessionId: string } }>();
    const sessionInfo = { inputTokens: 11, outputTokens: 22, totalTokens: 33 };
    const h = createHarness({
      currentSessionKey: command === "reset" && fails ? "global" : "agent:main:main",
      currentAgentId: "main",
      currentSessionId: "first-session",
      sessionGeneration: 4,
      sessionInfo: { ...sessionInfo },
      ...(command === "new"
        ? { createSession: vi.fn(() => transition.promise) }
        : { resetSession: vi.fn(() => transition.promise) }),
      applySessionMutationResult: vi.fn().mockReturnValue(true),
    });
    const pending = h.handleCommand(`/${command}`);
    if (command === "new") {
      h.state.currentSessionId = "replacement-session";
    } else if (fails) {
      h.state.currentAgentId = "work";
    } else {
      expectCall(h.resetSession, ["agent:main:main", "reset", undefined], "once");
      h.state.sessionGeneration += 1;
      h.state.currentSessionId = "second-session";
    }
    if (fails) {
      transition.reject(new Error("stale session transition"));
    } else {
      transition.resolve({
        ok: true,
        key: "agent:main:private-child",
        entry: { sessionId: "stale-reset" },
      });
    }
    await pending;
    expect(h.state.currentSessionId).toBe(
      command === "new" ? "replacement-session" : fails ? "first-session" : "second-session",
    );
    expect(h.state.sessionInfo).toEqual(sessionInfo);
    expectNoSessionCompletion(h, h.setSession, h.applySessionMutationResult);
  });

  it.each([
    ["/verbose", "usage: /verbose <on|off|full>"],
    ["/reasoning", "usage: /reasoning <on|off|stream>"],
    ["/elevated invalid", "usage: /elevated <on|off|ask|full>"],
    ["/side", "Usage: /btw <side question>"],
  ])("reports usage for %s without applying a setting or sending", async (command, usage) => {
    const h = createHarness({ opts: { local: command === "/side" } });
    await h.handleCommand(command);
    expect(h.addSystem).toHaveBeenCalledWith(usage);
    expectUnused(h.patchSession, h.sendChat);
  });

  it("uses the active session's supported thinking levels in help and command usage", async () => {
    const h = createHarness({
      sessionInfo: {
        modelProvider: "minimax",
        model: "MiniMax-M3",
        thinkingLevels: [
          { id: "off", label: "off" },
          { id: "max", label: "max" },
        ],
      },
    });
    await h.handleCommand("/help");
    await h.handleCommand("/think");
    expect(h.addSystem).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("/think <off|max|default>"),
    );
    expect(h.addSystem).toHaveBeenNthCalledWith(2, "usage: /think <off|max|default>");
  });

  it.each(["disconnected", "pending"] as const)("admission rejects %s", async (reason) => {
    const h = createHarness(
      reason === "disconnected"
        ? { isConnected: false }
        : {
            activeChatRunId: "run-active",
            pendingSubmit: { phase: "accepted", runId: "run-queued", draftText: "queued" },
            activityStatus: "waiting",
          },
    );
    await h.handleCommand("/context detail");
    expectUnused(h.sendChat, h.addUser);
    if (reason === "disconnected") {
      expect(h.addSystem).toHaveBeenCalledWith("not connected to gateway — message not sent");
      expect(h.setActivityStatus).toHaveBeenLastCalledWith("disconnected");
    } else {
      expect(h.addSystem).toHaveBeenCalledWith(
        "agent is busy — press Esc to abort before sending a new message",
        { coalesceConsecutive: true },
      );
    }
  });

  it("reserves the active assistant row before queueing a local prompt", async () => {
    const h = localHarness({ activeChatRunId: "run-active", activityStatus: "streaming" });
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
    const h = createHarness({ abortActive });
    await h.handleCommand("/stop");
    expect(abortActive).toHaveBeenCalledWith({ preferActive: true });
    expectUnused(h.sendChat, h.addPendingUser);
  });

  it.each([0, 1])("refreshes the local auth flow and reports exit %s", async (exitCode) => {
    const h = localHarness({
      runAuthFlow: vi
        .fn()
        .mockResolvedValue({ exitCode, signal: null, commandArgv: '["codex","login"]' }),
    });
    await h.handleCommand("/auth openai");
    expect(h.runAuthFlow).toHaveBeenCalledWith({ provider: "openai" });
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expectCall(h.addSystem, ["opening auth flow for openai; TUI will resume when it exits"]);
    expect(h.addSystem).toHaveBeenCalledWith(
      exitCode === 0
        ? "auth flow finished for openai"
        : 'auth flow failed (exit 1) — command argv: ["codex","login"]; retry provider login in a regular terminal to see its output',
    );
    expect(h.setActivityStatus).toHaveBeenLastCalledWith(exitCode === 0 ? "idle" : "error");
  });

  it.each([false, true])("rejects auth when unavailable or busy (local: %s)", async (local) => {
    const h = createHarness({
      opts: { local },
      ...(local
        ? {
            pendingSubmit: {
              phase: "sending" as const,
              runId: "run-pending",
              draftText: "pending",
            },
          }
        : {}),
    });
    await h.handleCommand(local ? "/auth openai" : "/auth");
    if (local) {
      expect(h.runAuthFlow).not.toHaveBeenCalled();
    }
    expect(h.addSystem).toHaveBeenCalledWith(
      local
        ? "abort the current run before /auth"
        : "auth login is only available in local embedded mode",
    );
  });

  it.each([
    ["cooldown", "Wait and retry, or choose another model."],
    [undefined, "Run openclaw models auth login or choose another model."],
  ])("keeps unavailable models visible without applying them: %s", async (reason, guidance) => {
    const h = createHarness({
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
    expectCall(h.addSystem, [`model unavailable: ${reason ?? "unavailable"}. ${guidance}`]);
  });

  it("keeps known choices interactive and updates an open picker without losing its search or selection", async () => {
    const held = createDeferred<Array<{ provider: string; id: string; name: string }>>();
    let known = [
      { provider: "fixture", id: "known-a", name: "Known A" },
      { provider: "fixture", id: "known-b", name: "Known B" },
      { provider: "fixture", id: "unrelated", name: "Other choice" },
    ];
    const harness = createHarness({
      getKnownModels: () => known,
      listModels: vi.fn(() => held.promise),
    });
    await harness.handleCommand("/models");
    const selector = firstMockArg(harness.openOverlay, "openOverlay") as SelectableOverlay;
    selector.handleInput("known");
    selector.handleInput("\u001b[B");
    expect(selector.render(100).join("\n")).toContain("fixture/known-b");
    known = [{ provider: "signed-in", id: "known-new", name: "New provider" }, ...known];
    harness.client.onModelsChanged?.({ agentId: "main", sessionKey: "agent:main:main" });
    expect(selector.render(100).join("\n")).toContain("signed-in/known-new");
    expect(selector.render(100).join("\n")).not.toContain("fixture/unrelated");
    selector.handleInput("\r");
    await flushAsyncSelect();
    expectCall(harness.patchSession, [{ key: "agent:main:main", model: "fixture/known-b" }]);
    held.resolve(known);
  });

  it.each(["models", "sessions"] as const)("stale %s picker after reset", async (picker) => {
    const deferred = createDeferred<unknown>();
    const harness = createHarness({
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
  });

  it("shows current-session usage-cost failures without invoking the model", async () => {
    const runUsageCostCommand = vi.fn().mockRejectedValue(new Error("session costs unavailable"));
    const harness = localHarness({ runUsageCostCommand });
    await harness.handleCommand("/usage cost");
    expect(harness.addSystem).toHaveBeenCalledWith("usage cost failed: session costs unavailable");
    expect(harness.sendChat).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
