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

  it.each([false, true])(
    "reports a failed picker selection only in its original session (replaced: %s)",
    async (replaced) => {
      const selection = createDeferred();
      const h = createTuiCommandHandlersHarness({
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
    },
  );

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

  it.each(["observed", "consumed", "completed"] as const)(
    "does not restore optimistic state after a run was already %s before its ACK",
    async (phase) => {
      const consumeCompletedRunForPendingSend = vi.fn((id: string) => id === "accepted-run");
      const flushPendingHistoryRefreshIfIdle = vi.fn();
      const sendChat = vi.fn(async ({ runId }: { runId: string }) => {
        if (phase === "consumed") {
          h.state.pendingSubmit = null;
        }
        return { runId: phase === "consumed" ? runId : "accepted-run" };
      });
      const h = createTuiCommandHandlersHarness({
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
    },
  );

  it.each(["/status", "/context", "/usage cost"])(
    "keeps unsupported local %s out of model prompts",
    async (command) => {
      const h = createTuiCommandHandlersHarness({
        opts: { local: true },
        runUsageCostCommand: null,
      });
      await h.handleCommand(command);
      expect(h.sendChat).not.toHaveBeenCalled();
      expect(h.addPendingUser).not.toHaveBeenCalled();
      expect(h.patchSession).not.toHaveBeenCalled();
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
    const h = createTuiCommandHandlersHarness({
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
    expect(h.patchSession).not.toHaveBeenCalled();
    expect(h.runGoalCommand).not.toHaveBeenCalled();
    expect(h.runUsageCostCommand).not.toHaveBeenCalled();
    expect(h.addSystem).not.toHaveBeenCalled();
  });

  it.each(["/goal start ship", "/usage cost"])(
    "runs local %s for the selected global agent",
    async (command) => {
      const h = createTuiCommandHandlersHarness({
        opts: { local: true },
        currentSessionKey: "global",
        currentAgentId: "work",
        runGoalCommand: vi
          .fn()
          .mockResolvedValue({ text: "Goal started: ship", continuationPrompt: "ship" }),
      });
      await h.handleCommand(command);
      if (command === "/goal start ship") {
        expect(h.runGoalCommand).toHaveBeenCalledWith({
          sessionKey: "global",
          agentId: "work",
          command,
        });
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
        expect(h.sendChat).not.toHaveBeenCalled();
        expect(h.patchSession).not.toHaveBeenCalled();
        expect(h.addPendingUser).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    { command: "/goal start private objective", fails: false },
    { command: "/goal start private objective", fails: true },
    { command: "/usage cost", fails: false },
    { command: "/usage cost", fails: true },
  ])(
    "suppresses a replaced session's $command completion (failure: $fails)",
    async ({ command, fails }) => {
      const result = createDeferred<{ text: string; continuationPrompt?: string }>();
      const goal = command.startsWith("/goal");
      const h = createTuiCommandHandlersHarness({
        opts: { local: true },
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

  it.each([false, true])(
    "cleans a delayed send completion without changing the replacement viewport (rejected: %s)",
    async (rejected) => {
      const deferred = createDeferred<{ runId: string; status: string }>();
      const h = createTuiCommandHandlersHarness({
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
    },
  );

  it.each(["timeout", "ok"] as const)(
    "settles a terminal %s ACK and refreshes history",
    async (status) => {
      const sendChat = vi.fn(async ({ runId }: { runId: string }) => ({
        runId: status === "timeout" ? "accepted-failed-run" : runId,
        status,
      }));
      const loadHistory = vi.fn<() => Promise<void>>(async () => {
        h.addSystem.mockClear();
      });
      const h = createTuiCommandHandlersHarness({ sendChat, loadHistory });
      await h.handleCommand("hello");
      expect(h.state.pendingSubmit).toBeNull();
      expect(h.loadHistory).toHaveBeenCalledOnce();
      if (status === "timeout") {
        const sentRunId = (firstMockArg(sendChat, "sendChat") as { runId: string }).runId;
        expect(h.dropPendingUser).toHaveBeenCalledWith("accepted-failed-run");
        expect(h.rekeyPendingUser).toHaveBeenCalledWith(sentRunId, "accepted-failed-run");
        expect(h.state.sessionProjection?.entries).toEqual([]);
        expect(h.addSystem).toHaveBeenCalledWith(
          "send failed: Chat failed before the run started; try again.",
        );
        expect(h.setActivityStatus).toHaveBeenLastCalledWith("error");
      } else {
        expect(h.dropPendingUser).not.toHaveBeenCalled();
        expect(h.state.sessionProjection?.entries).toHaveLength(1);
        expect(h.setActivityStatus).toHaveBeenLastCalledWith("idle");
      }
    },
  );

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

  it.each(["error", "ok", "in_flight"] as const)(
    "settles a detached BTW %s ACK without hijacking the main run",
    async (status) => {
      const h = createTuiCommandHandlersHarness({
        sendChat: vi.fn().mockResolvedValue({ runId: "accepted-btw", status }),
        activeChatRunId: "run-main",
      });
      await h.handleCommand(
        status === "in_flight" ? "/btw continue detached" : "/side finish detached",
      );
      const sent = firstMockArg(h.sendChat, "sendChat") as { runId: string };
      expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
      expect(h.state.activeChatRunId).toBe("run-main");
      expect(h.state.pendingSubmit).toBeNull();
      if (status === "in_flight") {
        expect(h.noteLocalBtwRunId).toHaveBeenCalledWith(sent.runId);
        expect(h.noteLocalBtwRunId).toHaveBeenCalledWith("accepted-btw");
        expect(h.noteLocalRunId).not.toHaveBeenCalled();
        expect(h.addUser).not.toHaveBeenCalled();
        expect(h.state.sessionProjection).toBeUndefined();
        expect(h.setActivityStatus).not.toHaveBeenCalled();
      } else {
        expect(h.forgetLocalBtwRunId).toHaveBeenCalledWith("accepted-btw");
      }
      if (status === "error") {
        expect(h.addSystem).toHaveBeenCalledWith(
          "btw failed: Chat failed before the run started; try again.",
        );
      } else {
        expect(h.addSystem).not.toHaveBeenCalled();
      }
    },
  );

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

  it.each(["new", "reset"] as const)(
    "blocks /%s until the current run settles",
    async (command) => {
      const h = createTuiCommandHandlersHarness(
        command === "new"
          ? { activityStatus: "finishing context" }
          : {
              pendingSubmit: { phase: "sending", runId: "pending-run", draftText: "pending" },
              activityStatus: "sending",
            },
      );
      await h.handleCommand(`/${command}`);
      expect(h.createSession).not.toHaveBeenCalled();
      expect(h.resetSession).not.toHaveBeenCalled();
      expect(h.addSystem).toHaveBeenCalledWith(`abort the current run before /${command}`);
    },
  );

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

  it.each<{
    command: string;
    params?: NonNullable<Parameters<typeof createTuiCommandHandlersHarness>[0]>;
    patch: object;
    message?: string;
    result?: object;
  }>([
    {
      command: "/fast on",
      params: { currentSessionKey: "global", currentAgentId: "work" },
      patch: { key: "global", agentId: "work", fastMode: true },
      result: { fastMode: true },
    },
    { command: "/think default", patch: { key: "agent:main:main", thinkingLevel: null } },
    {
      command: "/fast default",
      params: { opts: { local: true } },
      patch: { key: "agent:main:main", fastMode: null },
    },
    {
      command: "/think high",
      params: {
        sessionInfo: {
          thinkingLevels: [
            { id: "low", label: "high" },
            { id: "high", label: "turbo" },
          ],
        },
      },
      patch: { key: "agent:main:main", thinkingLevel: "high" },
      message: "thinking set to high",
    },
    {
      command: "/think on",
      params: {
        sessionInfo: {
          modelProvider: "opencode-go",
          model: "minimax-m3",
          thinkingLevels: [],
        },
      },
      patch: { key: "agent:main:main", thinkingLevel: "high" },
    },
    {
      command: "/verbose off",
      patch: { key: "agent:main:main", verboseLevel: "off" },
      result: { entry: { verboseLevel: "off" } },
    },
    { command: "/trace on", patch: { key: "agent:main:main", traceLevel: "on" } },
    {
      command: "/activation always",
      patch: { key: "agent:main:main", groupActivation: "always" },
      result: { groupActivation: "always" },
      message: "activation set to always",
    },
    {
      command: "/fast auto",
      patch: { key: "agent:main:main", fastMode: "auto" },
      result: { fastMode: "auto" },
      message: "fast mode set to auto",
    },
    {
      command: "/model kimi",
      patch: { key: "agent:main:main", model: "kimi" },
      result: { entry: {}, resolved: { modelProvider: "nvidia", model: "moonshotai/kimi-k2.5" } },
      message: "model set to nvidia/moonshotai/kimi-k2.5",
    },
    {
      command: "/usage",
      params: { sessionInfo: { effectiveResponseUsage: "tokens" } },
      patch: { key: "agent:main:main", responseUsage: "full" },
      message: "usage footer: full",
    },
  ])(
    "applies $command through the session setting owner",
    async ({ command, params, patch, message, result }) => {
      const h = createTuiCommandHandlersHarness({
        ...params,
        patchSession: vi.fn().mockResolvedValue(result ?? {}),
      });
      await h.handleCommand(command);
      expect(h.patchSession).toHaveBeenCalledWith(patch);
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
    },
  );

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

  it.each([false, true])("ignores a stale reset completion (failure: %s)", async (fails) => {
    const reset = createDeferred<{ ok: true; key: string; entry: { sessionId: string } }>();
    const h = createTuiCommandHandlersHarness({
      currentSessionKey: fails ? "global" : "agent:main:main",
      currentAgentId: "main",
      currentSessionId: "first-session",
      sessionGeneration: 4,
      resetSession: vi.fn(() => reset.promise),
      applySessionMutationResult: vi.fn().mockReturnValue(true),
    });
    const pending = h.handleCommand("/reset");
    if (fails) {
      h.state.currentAgentId = "work";
      reset.reject(new Error("stale global reset"));
    } else {
      expect(h.resetSession).toHaveBeenCalledExactlyOnceWith("agent:main:main", "reset", undefined);
      h.state.sessionGeneration += 1;
      h.state.currentSessionId = "second-session";
      reset.resolve({ ok: true, key: "agent:main:main", entry: { sessionId: "stale-reset" } });
    }
    await pending;
    if (!fails) {
      expect(h.state.currentSessionId).toBe("second-session");
    }
    expect(h.applySessionMutationResult).not.toHaveBeenCalled();
    expect(h.refreshSessionInfo).not.toHaveBeenCalled();
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.addSystem).not.toHaveBeenCalled();
  });

  it.each([
    ["/verbose", "usage: /verbose <on|off|full>"],
    ["/reasoning", "usage: /reasoning <on|off|stream>"],
    ["/elevated invalid", "usage: /elevated <on|off|ask|full>"],
    ["/side", "Usage: /btw <side question>"],
  ])("reports usage for %s without applying a setting or sending", async (command, usage) => {
    const h = createTuiCommandHandlersHarness({ opts: { local: command === "/side" } });
    await h.handleCommand(command);
    expect(h.addSystem).toHaveBeenCalledWith(usage);
    expect(h.patchSession).not.toHaveBeenCalled();
    expect(h.sendChat).not.toHaveBeenCalled();
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

  it.each(["disconnected", "pending"] as const)(
    "rejects a %s send at admission",
    async (reason) => {
      const h = createTuiCommandHandlersHarness(
        reason === "disconnected"
          ? { isConnected: false }
          : {
              activeChatRunId: "run-active",
              pendingSubmit: { phase: "accepted", runId: "run-queued", draftText: "queued" },
              activityStatus: "waiting",
            },
      );
      await h.handleCommand("/context detail");
      expect(h.sendChat).not.toHaveBeenCalled();
      expect(h.addUser).not.toHaveBeenCalled();
      if (reason === "disconnected") {
        expect(h.addSystem).toHaveBeenCalledWith("not connected to gateway — message not sent");
        expect(h.setActivityStatus).toHaveBeenLastCalledWith("disconnected");
      } else {
        expect(h.addSystem).toHaveBeenCalledWith(
          "agent is busy — press Esc to abort before sending a new message",
          { coalesceConsecutive: true },
        );
      }
    },
  );

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

  it.each([0, 1])("refreshes the local auth flow and reports exit %s", async (exitCode) => {
    const h = createTuiCommandHandlersHarness({
      opts: { local: true },
      runAuthFlow: vi
        .fn()
        .mockResolvedValue({ exitCode, signal: null, commandArgv: '["codex","login"]' }),
    });
    await h.handleCommand("/auth openai");
    expect(h.runAuthFlow).toHaveBeenCalledWith({ provider: "openai" });
    expect(h.refreshSessionInfo).toHaveBeenCalledOnce();
    expect(h.addSystem).toHaveBeenCalledWith(
      "opening auth flow for openai; TUI will resume when it exits",
    );
    expect(h.addSystem).toHaveBeenCalledWith(
      exitCode === 0
        ? "auth flow finished for openai"
        : 'auth flow failed (exit 1) — command argv: ["codex","login"]; retry provider login in a regular terminal to see its output',
    );
    expect(h.setActivityStatus).toHaveBeenLastCalledWith(exitCode === 0 ? "idle" : "error");
  });

  it.each([false, true])("rejects auth when unavailable or busy (local: %s)", async (local) => {
    const h = createTuiCommandHandlersHarness({
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
    harness.client.onModelsChanged?.({ agentId: "main", sessionKey: "agent:main:main" });
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

  it("shows current-session usage-cost failures without invoking the model", async () => {
    const runUsageCostCommand = vi.fn().mockRejectedValue(new Error("session costs unavailable"));
    const harness = createTuiCommandHandlersHarness({ opts: { local: true }, runUsageCostCommand });

    await harness.handleCommand("/usage cost");

    expect(harness.addSystem).toHaveBeenCalledWith("usage cost failed: session costs unavailable");
    expect(harness.sendChat).not.toHaveBeenCalled();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
