import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as failoverClassifier from "../agents/failover/classify-core.js";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  createMockBtwPresenter,
  createMockChatLog,
  makeTuiState,
} from "./tui-event-test-support.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import { getPendingSubmitAcceptedRunId, type TuiPendingSubmit } from "./tui-submit-state.js";
import type {
  AgentEvent,
  BtwEvent,
  ChatEvent,
  SessionChangedEvent,
  SessionMessageEvent,
  TuiHistoryLoadResult,
  TuiStateAccess,
} from "./tui-types.js";

type MockFn = ReturnType<typeof vi.fn>;
function sendingSubmit(runId: string, draftText = "pending"): TuiPendingSubmit {
  return { phase: "sending", runId, draftText };
}

function acceptedSubmit(runId: string, draftText: string | null = "pending"): TuiPendingSubmit {
  return { phase: "accepted", runId, draftText };
}

const settleHistory = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

type ChatEventOverrides = Partial<ChatEvent> & { stopReason?: unknown };

function makeChatEvent(state: TuiStateAccess, overrides: ChatEventOverrides = {}): ChatEvent {
  return {
    runId: "run-1",
    sessionKey: state.currentSessionKey,
    state: "delta",
    ...overrides,
  };
}

function textEvent(
  runId: string,
  text: string,
  state: ChatEvent["state"] = "delta",
): ChatEventOverrides {
  return { runId, state, message: { content: [{ type: "text", text }] } };
}

function contentEvent(
  runId: string,
  content: string,
  state: ChatEvent["state"] = "delta",
): ChatEventOverrides {
  return { runId, state, message: { content } };
}

function makeAgentEvent(overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    runId: "run-1",
    stream: "lifecycle",
    data: { phase: "start" },
    ...overrides,
  };
}

describe("tui-event-handlers: handleAgentEvent", () => {
  const createHandlersHarness = (
    params?: Partial<TuiStateAccess> & {
      localMode?: boolean;
      refreshSessionInfo?: () => Promise<void>;
    },
  ) => {
    const { localMode, refreshSessionInfo, ...overrides } = params ?? {};
    const state = makeTuiState({ activeChatRunId: "run-1", ...overrides });
    const localRunIds = new Set<string>();
    const localBtwRunIds = new Set<string>();
    const context = {
      state,
      chatLog: createMockChatLog(),
      btw: createMockBtwPresenter(),
      tui: { requestRender: vi.fn() },
      setActivityStatus: vi.fn(),
      updateFooter: vi.fn(),
      loadHistory: vi.fn<() => Promise<TuiHistoryLoadResult>>(async () => ({
        loaded: true,
        runOutcome: { state: "completed" },
      })),
      noteLocalRunId: (runId: string) => {
        localRunIds.add(runId);
      },
      noteLocalBtwRunId: (runId: string) => {
        localBtwRunIds.add(runId);
      },
      forgetLocalRunId: localRunIds.delete.bind(localRunIds),
      isLocalRunId: localRunIds.has.bind(localRunIds),
      clearLocalRunIds: localRunIds.clear.bind(localRunIds),
      forgetLocalBtwRunId: localBtwRunIds.delete.bind(localBtwRunIds),
      isLocalBtwRunId: localBtwRunIds.has.bind(localBtwRunIds),
      clearLocalBtwRunIds: localBtwRunIds.clear.bind(localBtwRunIds),
    };
    const rawHandlers = createEventHandlers({
      ...context,
      localMode,
      refreshSessionInfo,
    });
    const handlers = {
      ...rawHandlers,
      handleChatEvent: (event: ChatEventOverrides) =>
        rawHandlers.handleChatEvent(makeChatEvent(state, event)),
      handleAgentEvent: (event: Partial<AgentEvent>) =>
        rawHandlers.handleAgentEvent(makeAgentEvent(event)),
      handleSessionsChangedEvent: (event: Partial<SessionChangedEvent> = {}) =>
        rawHandlers.handleSessionsChangedEvent({ sessionKey: state.currentSessionKey, ...event }),
      handleSessionMessageEvent: (event: Partial<SessionMessageEvent> = {}) =>
        rawHandlers.handleSessionMessageEvent({ sessionKey: state.currentSessionKey, ...event }),
    };
    return {
      ...context,
      ...handlers,
    };
  };

  it("retires a gap-recovery run only after authoritative history reports completion", async () => {
    const { state, loadHistory, reconcileHistoryAfterGap, setActivityStatus, dispose } =
      createHandlersHarness({ activeChatRunId: "run-gap" });
    loadHistory.mockResolvedValueOnce({
      loaded: true,
      runOutcome: { state: "active", runId: "run-gap" },
    });
    reconcileHistoryAfterGap();
    expect(state.sessionProjection?.hasTransportGap).toBe(true);
    await settleHistory();
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(state.activeChatRunId).toBe("run-gap");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    reconcileHistoryAfterGap();
    await settleHistory();
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    dispose();
    reconcileHistoryAfterGap();
    await settleHistory();
    expect(loadHistory).toHaveBeenCalledTimes(3);
    expect(state.activeChatRunId).toBeNull();
  });

  it.each(["interrupted", "failed", "completed"] as const)(
    "reconciles a %s reconnect",
    (outcome) => {
      const { state, reconnectStreamingWatchdog, handleChatEvent, chatLog, setActivityStatus } =
        createHandlersHarness({ activeChatRunId: "run-current", activityStatus: "streaming" });
      if (outcome === "completed") {
        handleChatEvent(contentEvent("run-current", "partial"));
        chatLog.addSystem.mockClear();
        setActivityStatus.mockClear();
      }
      reconnectStreamingWatchdog(
        outcome === "failed"
          ? { state: outcome, errorMessage: "provider failed" }
          : { state: outcome },
      );
      if (outcome === "interrupted") {
        reconnectStreamingWatchdog({ state: outcome });
        handleChatEvent({
          runId: "run-current",
          message: { role: "assistant", content: "late stale output" },
        });
        expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
        expect(chatLog.updateAssistant).not.toHaveBeenCalled();
      } else if (outcome === "failed") {
        expect(chatLog.addSystem).toHaveBeenCalledWith("run error: provider failed");
      } else {
        expect(chatLog.addSystem).not.toHaveBeenCalledWith("run aborted");
      }
      expect(state.activeChatRunId).toBeNull();
      expect(setActivityStatus).toHaveBeenLastCalledWith(outcome === "failed" ? "error" : "idle");
    },
  );

  it("honors the authoritative stop reason over the nested message stop reason", () => {
    const { state, chatLog, setActivityStatus, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-provider-error",
    });
    handleChatEvent({
      runId: "run-provider-error",
      state: "final",
      stopReason: "error",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Provider response." }],
        stopReason: "stop",
      },
    });
    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Provider response.",
      "run-provider-error",
      [],
    );
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("error");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it.each(["buffered", "literal", "thinking-only"] as const)(
    "preserves %s content when a local run aborts",
    (content) => {
      const {
        state,
        chatLog,
        loadHistory,
        noteLocalRunId,
        isLocalRunId,
        setActivityStatus,
        handleChatEvent,
      } = createHandlersHarness({ activeChatRunId: "run-aborted-partial" });
      noteLocalRunId("run-aborted-partial");
      if (content !== "thinking-only") {
        handleChatEvent({
          runId: "run-aborted-partial",
          ...(content === "buffered" ? { seq: 1 } : {}),
          message: {
            role: "assistant",
            content: [{ type: "text", text: content === "buffered" ? "(no " : "(no output)" }],
          },
        });
      }
      handleChatEvent({
        runId: "run-aborted-partial",
        ...(content === "buffered" ? { seq: 2 } : {}),
        state: "aborted",
        message:
          content === "literal"
            ? undefined
            : {
                role: "assistant",
                content:
                  content === "buffered"
                    ? [{ type: "text", text: "(no output)" }]
                    : [{ type: "thinking", thinking: "hidden reasoning" }],
              },
      });
      if (content === "buffered") {
        expect(chatLog.updateAssistant).toHaveBeenCalledWith("(no", "run-aborted-partial");
      }
      if (content === "thinking-only") {
        expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
      } else {
        expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
          "(no output)",
          "run-aborted-partial",
        );
      }
      expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
      expect(chatLog.dropAssistant).not.toHaveBeenCalled();
      expect(loadHistory).not.toHaveBeenCalled();
      expect(isLocalRunId("run-aborted-partial")).toBe(false);
      expect(state.activeChatRunId).toBeNull();
      expect(setActivityStatus).toHaveBeenLastCalledWith("aborted");
    },
  );

  it("sanitizes and truncates abort diagnostics on a UTF-16 boundary", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({ activeChatRunId: "run-hostile" });
    const prefix = `${"word ".repeat(31)}abc`;
    handleChatEvent({
      runId: "run-hostile",
      state: "aborted",
      errorMessage: `\u001b[31m\n${prefix}🚀tail`,
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith(`run aborted: ${prefix}…`);
  });

  it.each([false, true])("settles a terminal lifecycle error with retry=%s", (retry) => {
    vi.useFakeTimers();
    const {
      state,
      chatLog,
      tui,
      setActivityStatus,
      loadHistory,
      handleAgentEvent,
      handleChatEvent,
    } = createHandlersHarness({ activeChatRunId: "run-error" });
    handleAgentEvent({
      runId: "run-error",
      data: {
        phase: "error",
        ...(retry ? {} : { endedAt: Date.now() }),
        error: "provider exploded",
      },
    });
    expect(chatLog.addSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-error");
    expect(setActivityStatus).toHaveBeenCalledWith("error");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    if (retry) {
      handleAgentEvent({
        runId: "run-error",
        data: { phase: "error", endedAt: Date.now(), error: "provider exploded" },
      });
      handleAgentEvent({ runId: "run-error", data: { phase: "start", startedAt: Date.now() } });
    }
    vi.advanceTimersByTime(15_000);
    if (retry) {
      expect(chatLog.addSystem).not.toHaveBeenCalledWith("run error: provider exploded");
      expect(state.activeChatRunId).toBe("run-error");
      expect(setActivityStatus).toHaveBeenCalledWith("running");
    } else {
      handleChatEvent({ runId: "run-error", state: "error", errorMessage: "provider exploded" });
      expect(chatLog.addSystem).toHaveBeenCalledTimes(1);
      expect(chatLog.addSystem).toHaveBeenCalledWith("run error: provider exploded");
      expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-error");
      expect(loadHistory).not.toHaveBeenCalled();
      expect(state.activeChatRunId).toBeNull();
      expect(tui.requestRender).toHaveBeenCalledTimes(2);
    }
    vi.useRealTimers();
  });

  it.each([null, 1, "provider/"].map((destination) => ({ destination })))(
    "preserves model state for an invalid reported destination %#",
    ({ destination }) => {
      const { state, handleAgentEvent, dispose } = createHandlersHarness({
        activeChatRunId: "run-invalid-destination",
        sessionInfo: { modelProvider: "openai", model: "gpt-4o" },
      });
      try {
        handleAgentEvent({
          runId: "run-invalid-destination",
          data: {
            phase: "fallback_step",
            fallbackStepToModel: destination,
          },
        });
        expect(state.sessionInfo.modelProvider).toBe("openai");
        expect(state.sessionInfo.model).toBe("gpt-4o");
        expect(state.activeChatRunId).toBe("run-invalid-destination");
      } finally {
        dispose();
      }
    },
  );

  it.each(["active", "pending", "tracked"])(
    "refreshes the fallback model for a %s run",
    (ownership) => {
      const { state, tui, updateFooter, handleAgentEvent } = createHandlersHarness({
        activeChatRunId:
          ownership === "pending"
            ? null
            : ownership === "active"
              ? "run-pending"
              : "other-active-run",
        pendingSubmit: ownership === "pending" ? acceptedSubmit("run-pending") : null,
        sessionInfo: {
          verboseLevel: "on",
          modelProvider: "llamaforge",
          model: "qwen/qwen3.5-9b",
        },
      });
      if (ownership === "tracked") {
        handleAgentEvent({
          runId: "run-pending",
          sessionKey: state.currentSessionKey,
          data: { phase: "start" },
        });
        expect(state.activeChatRunId).toBe("other-active-run");
      }
      handleAgentEvent({
        runId: "run-pending",
        data: {
          phase: "fallback_step",
          fallbackStepFinalOutcome: "succeeded",
          fallbackStepFromModel: "openrouter/meta-llama/llama-3.1-70b",
          fallbackStepToModel: "nvidia/deepseek-ai/deepseek-v3.2",
        },
      });
      expect(state.sessionInfo.modelProvider).toBe("nvidia");
      expect(state.sessionInfo.model).toBe("deepseek-ai/deepseek-v3.2");
      expect(updateFooter).toHaveBeenCalledExactlyOnceWith();
      expect(updateFooter.mock.invocationCallOrder[0]).toBeLessThan(
        tui.requestRender.mock.invocationCallOrder.at(-1)!,
      );
      expect(tui.requestRender).toHaveBeenCalled();
    },
  );

  it("preserves a pending local run when the session key catches up before the first event", () => {
    const { state, chatLog, loadHistory, noteLocalRunId, handleChatEvent, isLocalRunId } =
      createHandlersHarness({
        currentSessionKey: "agent:main:initial",
        activeChatRunId: null,
        pendingSubmit: acceptedSubmit("run-pending"),
      });
    noteLocalRunId("run-pending");
    state.currentSessionKey = "agent:main:restored";
    handleChatEvent({
      ...textEvent("run-pending", "done", "final"),
      sessionKey: "agent:main:restored",
    });

    expect(state.pendingSubmit).toBeNull();
    expect(isLocalRunId("run-pending")).toBe(false);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending", []);
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps local finishing ownership with final pending=%s", (pending) => {
    const { tui, setActivityStatus, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      localMode: true,
      activeChatRunId: null,
      pendingSubmit: pending ? acceptedSubmit("run-final") : null,
    });
    if (!pending) {
      handleChatEvent(textEvent("run-final", "done", "final"));
    }
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();
    handleAgentEvent({ runId: "run-final", data: { phase: "finishing" } });

    expect(setActivityStatus).toHaveBeenCalledWith("finishing context");
    expect(tui.requestRender).toHaveBeenCalled();
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();
    handleAgentEvent({ runId: "run-final", data: { phase: "end" } });
    expect(tui.requestRender).toHaveBeenCalledWith(true);
    if (pending) {
      expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
      handleChatEvent(textEvent("run-final", "done", "final"));
    }
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("does not let delayed finalized-run lifecycle clobber a newer active run", () => {
    const { state, tui, setActivityStatus, handleChatEvent, handleAgentEvent } =
      createHandlersHarness({ activeChatRunId: null });
    handleChatEvent(textEvent("run-old", "old done", "final"));
    handleChatEvent(contentEvent("run-new", "new running"));
    setActivityStatus.mockClear();
    tui.requestRender.mockClear();
    handleAgentEvent({ runId: "run-old", data: { phase: "finishing" } });
    handleAgentEvent({ runId: "run-old", data: { phase: "end" } });

    expect(state.activeChatRunId).toBe("run-new");
    expect(setActivityStatus).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("promotes the confirmed concurrent run instead of a newer orphan delta", () => {
    const {
      state,
      chatLog,
      loadHistory,
      setActivityStatus,
      handleAgentEvent,
      handleChatEvent,
      handleSessionMessageEvent,
      handleSessionsChangedEvent,
    } = createHandlersHarness({ activeChatRunId: null });
    handleChatEvent(textEvent("run-first", "first live response"));
    handleAgentEvent({ runId: "run-second", sessionKey: state.currentSessionKey });
    handleChatEvent(textEvent("run-second", "second live response"));
    for (let index = 0; index < 500; index += 1) {
      handleChatEvent({
        runId: `run-orphan-${index}`,
        message: { content: [{ type: "text", text: `orphan ${index}` }] },
      });
    }
    handleSessionMessageEvent({ updatedAt: 200 });
    expect(loadHistory).not.toHaveBeenCalled();
    handleChatEvent({
      runId: "run-first",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(state.activeChatRunId).toBe("run-second");
    handleChatEvent({
      runId: "run-second",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("first live response", "run-first", []);
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "second live response",
      "run-second",
      [],
    );
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    for (const runId of ["run-first", "run-second"]) {
      handleSessionsChangedEvent({ runId, phase: "end" });
    }
    expect(loadHistory).toHaveBeenCalledTimes(1);
    const displayedDeltaCount = chatLog.updateAssistant.mock.calls.length;
    handleChatEvent(textEvent("run-orphan-499", "late orphan"));
    expect(state.activeChatRunId).toBeNull();
    expect(chatLog.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);
    handleChatEvent(textEvent("run-never-seen-orphan", "untracked late orphan"));
    expect(state.activeChatRunId).toBeNull();
    expect(chatLog.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);
  });

  it("preserves a sequenced lifecycle-less peer behind a confirmed run handoff", () => {
    const { state, chatLog, setActivityStatus, handleAgentEvent, handleChatEvent } =
      createHandlersHarness({ activeChatRunId: null });
    handleChatEvent(textEvent("run-first", "first live response"));
    handleAgentEvent({ runId: "run-confirmed", sessionKey: state.currentSessionKey });
    handleChatEvent(textEvent("run-confirmed", "confirmed response"));
    handleChatEvent({
      runId: "run-without-lifecycle",
      seq: 1,
      message: { content: [{ type: "text", text: "older peer response" }] },
    });
    handleChatEvent(textEvent("run-orphan", "unconfirmed orphan"));
    handleChatEvent({
      runId: "run-first",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(["run-confirmed", "run-without-lifecycle"]).toContain(state.activeChatRunId);
    for (const runId of ["run-confirmed", "run-without-lifecycle"]) {
      handleChatEvent({
        runId,
        ...(runId === "run-without-lifecycle" ? { seq: 2 } : {}),
        state: "final",
        message: { role: "assistant", content: [] },
      });
    }
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "older peer response",
      "run-without-lifecycle",
      [],
    );
    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it.each([
    {
      provider: "Matrix",
      selectedSessionKey: "agent:main:matrix:channel:!MixedRoom:example.org",
      otherSessionKey: "agent:main:matrix:channel:!mixedroom:example.org",
    },
  ])(
    "isolates case-distinct $provider session events across every TUI event surface",
    ({ selectedSessionKey, otherSessionKey }) => {
      const {
        state,
        chatLog,
        btw,
        loadHistory,
        handleChatEvent,
        handleAgentEvent,
        handleBtwEvent,
        handleSessionsChangedEvent,
        handleSessionMessageEvent,
      } = createHandlersHarness({
        activeChatRunId: null,
        currentSessionKey: selectedSessionKey,
        currentSessionId: "selected-session",
        sessionInfo: { verboseLevel: "on", updatedAt: 100 },
      });
      handleChatEvent({
        runId: "run-other-session",
        sessionKey: otherSessionKey,
        message: { content: "message from another conversation" },
      });
      handleAgentEvent({ runId: "run-other-lifecycle", sessionKey: otherSessionKey });
      handleBtwEvent({
        kind: "btw",
        runId: "run-other-btw",
        sessionKey: otherSessionKey,
        question: "other conversation?",
        text: "private answer",
      } satisfies BtwEvent);
      handleSessionsChangedEvent({
        sessionKey: otherSessionKey,
        reason: "reset",
        sessionId: "other-session",
        updatedAt: 200,
      });
      handleSessionMessageEvent({
        sessionKey: otherSessionKey,
        agentId: "main",
        sessionId: "other-session",
        updatedAt: 200,
      });

      expect(chatLog.updateAssistant).not.toHaveBeenCalled();
      expect(btw.showResult).not.toHaveBeenCalled();
      expect(loadHistory).not.toHaveBeenCalled();
      expect(state.activeChatRunId).toBeNull();
      expect(state.currentSessionKey).toBe(selectedSessionKey);
      expect(state.currentSessionId).toBe("selected-session");
      expect(state.sessionInfo.updatedAt).toBe(100);
    },
  );

  it("discards a delayed local BTW result from the previous same-key session incarnation", () => {
    const { state, btw, noteLocalBtwRunId, handleBtwEvent, handleSessionsChangedEvent } =
      createHandlersHarness({
        localMode: true,
        activeChatRunId: null,
        currentSessionId: "private-session",
      });
    noteLocalBtwRunId("private-btw-run");
    handleSessionsChangedEvent({
      sessionKey: state.currentSessionKey,
      reason: "reset",
      sessionId: "replacement-session",
      updatedAt: Date.now(),
    });
    handleBtwEvent({
      kind: "btw",
      runId: "private-btw-run",
      sessionKey: state.currentSessionKey,
      question: "what was discussed?",
      text: "answer from the previous session",
    });

    expect(state.currentSessionId).toBe("replacement-session");
    expect(btw.showResult).not.toHaveBeenCalled();
    noteLocalBtwRunId("replacement-btw-run");
    handleBtwEvent({
      kind: "btw",
      runId: "replacement-btw-run",
      sessionKey: state.currentSessionKey,
      question: "what changed?",
      text: "answer for the replacement session",
    });
    expect(btw.showResult).toHaveBeenCalledExactlyOnceWith({
      question: "what changed?",
      text: "answer for the replacement session",
      isError: undefined,
    });
  });

  it("clears stale streaming for a local BTW empty final without hiding the result", () => {
    const {
      state,
      btw,
      loadHistory,
      setActivityStatus,
      noteLocalBtwRunId,
      handleBtwEvent,
      handleChatEvent,
    } = createHandlersHarness({ activeChatRunId: null, activityStatus: "streaming" });
    noteLocalBtwRunId("run-btw");
    handleBtwEvent({
      kind: "btw",
      runId: "run-btw",
      sessionKey: state.currentSessionKey,
      question: "what changed?",
      text: "nothing important",
    } satisfies BtwEvent);
    setActivityStatus.mockClear();
    handleChatEvent({ runId: "run-btw", state: "final" });

    expect(state.activeChatRunId).toBeNull();
    expect(state.activityStatus).toBe("idle");
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(btw.showResult).toHaveBeenCalledWith({
      question: "what changed?",
      text: "nothing important",
      isError: undefined,
    });
  });

  it("clears run mapping when the session changes", () => {
    const { state, chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
      activeChatRunId: null,
    });
    handleChatEvent(contentEvent("run-old", "hello"));
    state.currentSessionKey = "agent:main:other";
    state.activeChatRunId = null;
    tui.requestRender.mockClear();
    handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc2", name: "exec" },
    });

    expect(chatLog.startTool).not.toHaveBeenCalled();
    expect(tui.requestRender).not.toHaveBeenCalled();
  });

  it("reloads the current session and clears stale run state after sessions.changed reset", () => {
    const refreshSessionInfo = vi.fn<() => Promise<void>>(async () => undefined);
    const {
      state,
      chatLog,
      btw,
      tui,
      loadHistory,
      setActivityStatus,
      noteLocalRunId,
      isLocalRunId,
      handleChatEvent,
      handleAgentEvent,
      handleSessionsChangedEvent,
    } = createHandlersHarness({
      activeChatRunId: null,
      currentAgentId: "work",
      currentSessionKey: "agent:work:support",
      currentSessionId: "session-before",
      sessionInfo: { verboseLevel: "on", updatedAt: 100 },
      refreshSessionInfo,
    });
    handleChatEvent(textEvent("run-old", "done", "final"));
    noteLocalRunId("run-local");
    state.activeChatRunId = "run-stale";
    state.pendingSubmit = acceptedSubmit("run-pending");
    state.activityStatus = "streaming";
    loadHistory.mockClear();
    refreshSessionInfo.mockClear();
    chatLog.startTool.mockClear();
    btw.clear.mockClear();
    tui.requestRender.mockClear();
    setActivityStatus.mockClear();
    handleSessionsChangedEvent({
      sessionKey: "support",
      agentId: "work",
      reason: "reset",
      sessionId: "session-after",
      updatedAt: 200,
    });

    expect(state.activeChatRunId).toBeNull();
    expect(state.pendingSubmit).toBeNull();
    expect(state.activityStatus).toBe("idle");
    expect(state.currentSessionId).toBe("session-after");
    expect(state.sessionProjection?.scope.sessionId).toBe("session-after");
    expect(state.sessionProjection?.runs).toEqual({});
    expect(state.sessionInfo.updatedAt).toBe(200);
    expect(isLocalRunId("run-local")).toBe(false);
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(btw.clear).toHaveBeenCalledTimes(1);
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(refreshSessionInfo).not.toHaveBeenCalled();
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-old", name: "exec" },
    });
    expect(chatLog.startTool).not.toHaveBeenCalled();
  });

  it("reports only the latest reset after all queued history reloads settle", async () => {
    const first = createDeferred<TuiHistoryLoadResult>();
    const second = createDeferred<TuiHistoryLoadResult>();
    const { state, chatLog, loadHistory, handleSessionsChangedEvent, dispose } =
      createHandlersHarness({ activeChatRunId: null });
    loadHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    try {
      handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1", updatedAt: 20 });
      handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1", updatedAt: 30 });
      expect(loadHistory).toHaveBeenCalledTimes(1);
      first.resolve({ loaded: true, runOutcome: { state: "completed" } });
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2));
      expect(chatLog.addSystem).not.toHaveBeenCalled();
      state.activeChatRunId = "newly-adopted-run";
      second.resolve({ loaded: true, runOutcome: { state: "active", runId: "newly-adopted-run" } });
      await vi.waitFor(() =>
        expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("session agent:main:main reset"),
      );
      expect(state.activeChatRunId).toBe("newly-adopted-run");
    } finally {
      dispose();
    }
  });

  it.each(["session", "global agent", "new lifecycle"])(
    "discards a reset receipt retired by %s while history loads",
    async (retirement) => {
      const history = createDeferred<TuiHistoryLoadResult>();
      const { state, chatLog, loadHistory, handleSessionsChangedEvent, dispose } =
        createHandlersHarness({
          currentSessionKey: retirement === "global agent" ? "global" : "agent:main:main",
          activeChatRunId: null,
        });
      loadHistory.mockReturnValueOnce(history.promise);
      handleSessionsChangedEvent({ reason: "reset", agentId: "main", sessionId: "session-1" });
      if (retirement === "session") {
        state.currentSessionKey = "agent:main:other";
      } else if (retirement === "global agent") {
        state.currentAgentId = "work";
      } else if (retirement === "new lifecycle") {
        handleSessionsChangedEvent({ reason: "new", sessionId: "replacement" });
      } else {
        dispose();
      }
      history.resolve({ loaded: true, runOutcome: { state: "completed" } });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(chatLog.addSystem).not.toHaveBeenCalled();
      dispose();
    },
  );

  it("reports an observed reset even when its history reload fails", async () => {
    const { chatLog, loadHistory, handleSessionsChangedEvent, dispose } = createHandlersHarness({
      activeChatRunId: null,
    });
    loadHistory.mockRejectedValueOnce(new Error("history unavailable"));
    try {
      handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1" });
      await vi.waitFor(() =>
        expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("session agent:main:main reset"),
      );
    } finally {
      dispose();
    }
  });

  it.each([
    { name: "legacy batch", identity: {}, foreign: false, reloads: 1 },
    { name: "foreign incarnation", identity: {}, foreign: true, reloads: 0 },
    {
      name: "persisted message identity",
      identity: { messageId: "message-1" },
      foreign: false,
      reloads: 0,
    },
    { name: "persisted message sequence", identity: { messageSeq: 7 }, foreign: false, reloads: 0 },
    {
      name: "concrete message",
      identity: { message: { role: "user", content: "hello" } },
      foreign: false,
      reloads: 0,
    },
    { name: "run identity", identity: { runId: "run-message" }, foreign: false, reloads: 0 },
    {
      name: "client run identity",
      identity: { clientRunId: "run-message" },
      foreign: false,
      reloads: 0,
    },
  ])(
    "preserves active response ownership for a $name message-phase event",
    ({ identity, foreign, reloads }) => {
      const pendingSubmit = acceptedSubmit("run-pending");
      const { state, chatLog, btw, loadHistory, setActivityStatus, handleSessionsChangedEvent } =
        createHandlersHarness({
          activeChatRunId: "run-active",
          activityStatus: "streaming",
          currentSessionId: "session-1",
          pendingSubmit,
        });
      handleSessionsChangedEvent({
        agentId: state.currentAgentId,
        sessionId: foreign ? "session-other" : "session-1",
        phase: "message",
        ...(foreign ? { activeRunIds: [] } : {}),
        ...identity,
      });
      expect(loadHistory).toHaveBeenCalledTimes(reloads);
      expect(state.currentSessionId).toBe("session-1");
      expect(state.activeChatRunId).toBe("run-active");
      expect(state.activityStatus).toBe("streaming");
      expect(state.pendingSubmit).toBe(pendingSubmit);
      expect(setActivityStatus).not.toHaveBeenCalled();
      expect(chatLog.dropAssistant).not.toHaveBeenCalled();
      expect(btw.clear).not.toHaveBeenCalled();
    },
  );

  it.each(["finalized", "off", "on"] as const)(
    "routes tool events with %s visibility",
    (visibility) => {
      const { chatLog, tui, handleChatEvent, handleAgentEvent } = createHandlersHarness({
        activeChatRunId: visibility === "finalized" ? null : "run-final",
        sessionInfo: { verboseLevel: visibility === "off" ? "off" : "on" },
      });
      if (visibility === "finalized") {
        handleChatEvent(textEvent("run-final", "done", "final"));
      }
      if (visibility !== "on") {
        handleAgentEvent({
          runId: "run-final",
          stream: "tool",
          data: { phase: "start", toolCallId: "tc-final", name: "session_status" },
        });
      }
      if (visibility === "finalized") {
        expect(chatLog.startTool).toHaveBeenCalledWith(
          "tc-final",
          "session_status",
          undefined,
          "run-final",
        );
        expect(tui.requestRender).toHaveBeenCalled();
      } else if (visibility === "off") {
        expect(chatLog.startTool).not.toHaveBeenCalled();
        expect(tui.requestRender).not.toHaveBeenCalled();
      } else {
        for (const phase of ["update", "result"] as const) {
          handleAgentEvent({
            runId: "run-final",
            stream: "tool",
            data: {
              phase,
              toolCallId: "tc-on",
              name: "session_status",
              partialResult: { content: [{ type: "text", text: "secret" }] },
              result: { content: [{ type: "text", text: "secret" }] },
              isError: false,
            },
          });
        }

        expect(chatLog.updateToolResult).toHaveBeenCalledTimes(1);
        expect(chatLog.updateToolResult).toHaveBeenCalledWith(
          "tc-on",
          { content: [] },
          { isError: false },
        );
      }
    },
  );

  it("finalizes an attachment-only assistant reply instead of dropping it", () => {
    const { chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      activeChatRunId: null,
    });
    handleChatEvent({
      runId: "run-external-image",
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "image",
            data: "secret-image",
            url: "file:///Users/operator/private/image.png",
          },
        ],
      },
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("Attached image", "run-external-image", [
      { source: "file:///Users/operator/private/image.png" },
    ]);
    expect(chatLog.dropAssistant).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
  });

  it("preserves the assembled delta-only final across an older history snapshot", () => {
    const { state, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-streamed-final",
    });
    const sessionKey = state.currentSessionKey;
    handleChatEvent({
      runId: "run-streamed-final",
      sessionKey,
      seq: 1,
      message: { role: "assistant", content: "Assembled streamed reply." },
    });
    handleChatEvent({
      runId: "run-streamed-final",
      sessionKey,
      seq: 2,
      state: "final",
      message: { role: "assistant", content: [] },
    });
    reduceTuiSessionProjection(state, {
      type: "snapshotLoaded",
      messages: [],
      scope: readTuiSessionProjectionScope(state),
    });

    expect(state.sessionProjection?.entries[0]?.message).toMatchObject({
      role: "assistant",
      content: "Assembled streamed reply.",
    });
  });

  it("forces render when a command final only adds system text", () => {
    const { chatLog, tui, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-command",
    });
    handleChatEvent({
      runId: "run-command",
      state: "final",
      message: {
        command: true,
        content: [{ type: "text", text: "/status done" }],
      },
    });

    expect(chatLog.addSystem).toHaveBeenCalledWith("/status done");
    expect(tui.requestRender).toHaveBeenCalledTimes(1);
    expect(tui.requestRender).toHaveBeenCalledWith(true);
  });

  it("does not let unrelated same-session events claim a pending optimistic run", () => {
    const { state, chatLog, loadHistory, noteLocalRunId, isLocalRunId, handleChatEvent } =
      createHandlersHarness({
        activeChatRunId: null,
        pendingSubmit: acceptedSubmit("run-pending"),
      });
    noteLocalRunId("run-pending");
    handleChatEvent(textEvent("run-other", "other done", "final"));

    expect(getPendingSubmitAcceptedRunId(state)).toBe("run-pending");
    expect(isLocalRunId("run-other")).toBe(false);
    expect(loadHistory).not.toHaveBeenCalled();
    handleChatEvent(textEvent("run-pending", "done", "final"));
    expect(state.pendingSubmit).toBeNull();
    expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending", []);
    expect(loadHistory).toHaveBeenCalledTimes(1);
  });

  it("ignores settled snapshots from an older incarnation of the selected session", () => {
    const { state, setActivityStatus, handleSessionsChangedEvent } = createHandlersHarness({
      activeChatRunId: "run-current",
      activityStatus: "streaming",
      currentSessionId: "session-current",
    });
    handleSessionsChangedEvent({
      reason: "agent.input.settled",
      sessionId: "session-old",
      activeRunIds: [],
    });

    expect(state.activeChatRunId).toBe("run-current");
    expect(state.activityStatus).toBe("streaming");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it.each([{ pendingSubmit: sendingSubmit("run-pending"), activityStatus: "sending" }])(
    "preserves $activityStatus submit activity while retiring a stale owner",
    (pending) => {
      const { state, handleChatEvent, handleSessionsChangedEvent, setActivityStatus } =
        createHandlersHarness({ activeChatRunId: "run-stale", activityStatus: "streaming" });
      handleChatEvent({ runId: "run-stale", seq: 1, message: { content: "done" } });
      Object.assign(state, pending);
      setActivityStatus.mockClear();
      handleSessionsChangedEvent({ reason: "agent.input.settled", activeRunIds: [] });

      expect(state.activeChatRunId).toBeNull();
      expect(state.pendingSubmit).toEqual(pending.pendingSubmit);
      expect(state.activityStatus).toBe(pending.activityStatus);
      expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    },
  );

  it.each([false, true])(
    "flushes deferred history after the active owner settles with stale streaming=%s",
    (stale) => {
      const { state, loadHistory, noteLocalRunId, setActivityStatus, handleChatEvent } =
        createHandlersHarness({
          activeChatRunId: "run-main",
          activityStatus: stale ? "streaming" : "idle",
        });
      noteLocalRunId("run-local-empty");
      if (stale) {
        loadHistory.mockImplementation(async () => {
          expect(state.activeChatRunId).toBeNull();
          expect(state.activityStatus).toBe("idle");
          return { loaded: true, runOutcome: { state: "completed" } };
        });
      }
      handleChatEvent({ runId: "run-local-empty", state: "final" });
      if (stale) {
        expect(state.activeChatRunId).toBeNull();
        expect(state.activityStatus).toBe("idle");
        expect(setActivityStatus).toHaveBeenCalledWith("idle");
      } else {
        expect(state.activeChatRunId).toBe("run-main");
        expect(loadHistory).not.toHaveBeenCalled();
        noteLocalRunId("run-main");
        handleChatEvent(textEvent("run-main", "done", "final"));
      }
      expect(loadHistory).toHaveBeenCalledTimes(1);
    },
  );

  it("does not surface inactive orphan final failures as the global status", () => {
    const { state, setActivityStatus, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-stale",
      activityStatus: "streaming",
    });
    handleChatEvent({
      runId: "run-orphan-error",
      state: "final",
      message: { content: [{ type: "text", text: "failed" }], stopReason: "error" },
    });

    expect(state.activeChatRunId).toBeNull();
    expect(setActivityStatus).toHaveBeenCalledWith("idle");
    expect(setActivityStatus).not.toHaveBeenCalledWith("error");
  });

  it("does not clear global streaming for inactive local /btw aborted or error events", () => {
    const { state, setActivityStatus, noteLocalBtwRunId, handleChatEvent } = createHandlersHarness({
      activeChatRunId: null,
      activityStatus: "streaming",
    });
    for (const terminalState of ["aborted", "error"] as const) {
      const runId = `run-btw-${terminalState}`;
      state.activeChatRunId = null;
      state.activityStatus = "streaming";
      setActivityStatus.mockClear();
      noteLocalBtwRunId(runId);
      handleChatEvent({
        runId,
        state: terminalState,
        errorMessage: terminalState === "error" ? "boom" : undefined,
      });

      expect(state.activeChatRunId).toBeNull();
      expect(state.activityStatus).toBe("streaming");
      expect(setActivityStatus).not.toHaveBeenCalled();
    }
  });

  it("suppresses non-local empty final placeholders during concurrent runs", () => {
    const { state, chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-active",
    });
    handleChatEvent(contentEvent("run-active", "local stream"));
    loadHistory.mockClear();
    chatLog.finalizeAssistant.mockClear();
    chatLog.dropAssistant.mockClear();
    handleChatEvent({ runId: "run-other", state: "final", message: { content: [] } });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalledWith("(no output)", "run-other", []);
    expect(chatLog.dropAssistant).toHaveBeenCalledWith("run-other");
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-active");
  });

  it("renders final error text when chat final has no content but includes event errorMessage", () => {
    const { chatLog, handleChatEvent } = createHandlersHarness({ activeChatRunId: null });
    handleChatEvent({
      runId: "run-error-envelope",
      state: "final",
      message: { content: [] },
      errorMessage: '401 {"error":{"message":"Missing scopes: model.request"}}',
    });

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    const rendered = chatLog.finalizeAssistant.mock.calls[0]?.[0];
    expect(rendered).toContain("HTTP 401");
    expect(rendered).toContain("Missing scopes: model.request");
    expect(chatLog.dropAssistant).not.toHaveBeenCalledWith("run-error-envelope");
  });

  it("restores a terminal error when another run delays a history reload", async () => {
    const { state, chatLog, loadHistory, noteLocalRunId, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-error",
    });
    handleChatEvent(contentEvent("run-other", "still running"));
    noteLocalRunId("run-local-empty");
    handleChatEvent({ runId: "run-local-empty", state: "final" });
    handleChatEvent({ runId: "run-error", state: "error", errorMessage: "provider exploded" });

    expect(state.activeChatRunId).toBe("run-other");
    expect(loadHistory).not.toHaveBeenCalled();
    handleChatEvent(textEvent("run-other", "done", "final"));
    await vi.waitFor(() => expect(chatLog.addSystem).toHaveBeenCalledTimes(2));
    expect(loadHistory).toHaveBeenCalledTimes(1);
    expect(chatLog.addSystem).toHaveBeenLastCalledWith("run error: provider exploded");
  });

  it.each([
    {
      name: "non-auth",
      error: "fixture provider failed",
    },
    {
      name: "auth",
      provider: "openai",
      error:
        "Authentication failed with an HTML 403 response from the provider. Re-authenticate and verify your provider account access.",
      expected:
        "auth or provider access failed for openai. Run /auth openai to refresh credentials; if you already re-authed, switch models/providers because this account may still be blocked for inference.",
    },
    {
      name: "billing",
      provider: "xai",
      error:
        '403 {"code":"The caller does not have permission to execute the specified operation","error":"Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit."}',
      expected:
        "run error: HTTP 403: Your team team-redacted has either used all available credits or reached its monthly spending limit. To continue making API requests, please purchase more credits or raise your spending limit.",
    },
  ])(
    "renders local $name errors without losing the backend diagnostic",
    ({ name, provider, error, expected }) => {
      const classify =
        name === "non-auth"
          ? vi.spyOn(failoverClassifier, "classifyFailoverReasonCore").mockImplementation(() => {
              throw new Error("provider classification must not block non-auth error rendering");
            })
          : undefined;
      try {
        const { chatLog, handleChatEvent } = createHandlersHarness({
          localMode: true,
          activeChatRunId: name === "non-auth" ? "run-1" : null,
          sessionInfo: { modelProvider: provider },
        });
        handleChatEvent({
          runId: "run-provider-error",
          state: "error",
          errorMessage: error,
        });
        expect(chatLog.addSystem).toHaveBeenCalledWith(expected ?? `run error: ${error}`);
      } finally {
        classify?.mockRestore();
      }
    },
  );

  it.each([
    { label: "owned local", localMode: true, owned: true, sessionKey: "agent:main:main" },
    { label: "unowned local", localMode: true, owned: false, sessionKey: "agent:main:main" },
    { label: "remote", localMode: false, owned: true, sessionKey: "agent:main:main" },
    { label: "foreign session", localMode: true, owned: true, sessionKey: "agent:main:other" },
  ])(
    "checks ownership of an unsequenced $label provisional event",
    ({ localMode, owned, sessionKey }) => {
      const { state, chatLog, handleAgentEvent, handleChatEvent, noteLocalRunId } =
        createHandlersHarness({
          localMode,
          activeChatRunId: null,
          sessionInfo: { modelProvider: "xai" },
        });
      handleAgentEvent({
        runId: "completed-run",
        sessionKey: state.currentSessionKey,
        data: { phase: "start" },
      });
      handleChatEvent(textEvent("completed-run", "done", "final"));
      state.pendingSubmit = sendingSubmit("untrusted-run");
      if (owned) {
        noteLocalRunId("untrusted-run");
      }
      const accepted = localMode && owned && sessionKey === state.currentSessionKey;
      const errorMessage = accepted ? "monthly spending limit" : "foreign private diagnostic";
      handleChatEvent({
        runId: "untrusted-run",
        sessionKey,
        state: "error",
        errorMessage,
      });
      if (accepted) {
        expect(state.pendingSubmit).toBeNull();
        expect(chatLog.addSystem).toHaveBeenCalledWith("run error: monthly spending limit");
      } else {
        expect(state.pendingSubmit).toEqual(sendingSubmit("untrusted-run"));
        expect(chatLog.addSystem).not.toHaveBeenCalledWith("run error: foreign private diagnostic");
      }
    },
  );

  it("keeps and deduplicates distinct same-run finals with persisted identities", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-message-tool",
    });
    const sourceReply = {
      role: "assistant",
      content: [{ type: "text", text: "Visible progress from the targetless message tool." }],
      __openclaw: { id: "message-tool-source-reply", seq: 7 },
    };
    const automaticReply = {
      role: "assistant",
      content: [{ type: "text", text: "Visible automatic final reply." }],
      __openclaw: { id: "automatic-final-reply", seq: 8 },
    };
    const sourceEvent = makeChatEvent(state, {
      runId: "run-message-tool",
      state: "final",
      message: sourceReply,
    });
    const finalEvent = makeChatEvent(state, {
      runId: "run-message-tool",
      state: "final",
      message: automaticReply,
    });
    handleChatEvent(sourceEvent);
    handleChatEvent(finalEvent);
    handleChatEvent(finalEvent);

    expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(2);
    expect(chatLog.finalizeAssistant).toHaveBeenNthCalledWith(
      1,
      "Visible progress from the targetless message tool.",
      "run-message-tool",
      [],
    );
    expect(chatLog.finalizeAssistant).toHaveBeenNthCalledWith(
      2,
      "Visible automatic final reply.",
      "run-message-tool",
      [],
    );
    expect(state.activeChatRunId).toBeNull();
  });

  it("keeps a newer response streaming when a completed run fails afterward", () => {
    const { state, chatLog, setActivityStatus, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-completed",
    });
    handleChatEvent({
      runId: "run-completed",
      state: "final",
      message: { role: "assistant", content: [{ type: "text", text: "Delivered once." }] },
    });
    handleChatEvent(contentEvent("run-newer", "Newer response"));
    setActivityStatus.mockClear();
    handleChatEvent({ runId: "run-completed", state: "error", errorMessage: "  \t  " });
    const error: ChatEventOverrides = {
      runId: "run-completed",
      state: "error",
      errorMessage: "  late provider failure  ",
    };
    handleChatEvent(error);
    handleChatEvent(error);

    expect(state.activeChatRunId).toBe("run-newer");
    expect(chatLog.updateAssistant).toHaveBeenLastCalledWith("Newer response", "run-newer");
    expect(chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Delivered once.",
      "run-completed",
      [],
    );
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run error: late provider failure");
    expect(setActivityStatus).not.toHaveBeenCalledWith("error");
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("ignores an attachment final that arrives after the run was aborted", () => {
    const { state, chatLog, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-abort-late-final",
    });
    const message = {
      role: "assistant",
      content: [{ type: "image", data: "secret-image" }],
    };
    handleChatEvent({
      runId: "run-abort-late-final",
      seq: 1,
      state: "aborted",
      errorMessage: "cancelled by user",
      message,
    });
    handleChatEvent({
      runId: "run-abort-late-final",
      state: "aborted",
      errorMessage: "cancelled by user",
      message,
    });
    handleChatEvent({ runId: "run-abort-late-final", seq: 2, state: "final", message });

    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted: cancelled by user");
    expect(state.sessionProjection?.runs["run-abort-late-final"]?.status).toBe("aborted");
  });

  it.each([
    {
      name: "abort",
      terminal: { state: "aborted" as const, errorMessage: "cancelled by user" },
      expectedStatus: "aborted",
    },
    {
      name: "error",
      terminal: { state: "error" as const, errorMessage: "provider failed" },
      expectedStatus: "error",
    },
  ])(
    "renders a text-bearing recovered final after a message-less $name",
    ({ terminal, expectedStatus }) => {
      const runId = `run-recovered-${expectedStatus}`;
      const { state, chatLog, handleChatEvent } = createHandlersHarness({ activeChatRunId: runId });
      handleChatEvent({ runId, seq: 1, ...terminal });
      handleChatEvent({
        runId,
        seq: 2,
        state: "final",
        message: { role: "assistant", content: [{ type: "text", text: "Recovered reply." }] },
      });

      expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("Recovered reply.", runId, []);
      expect(state.sessionProjection?.runs[runId]?.status).toBe(expectedStatus);
    },
  );

  it("ignores duplicate empty final envelopes after a run already finalized empty", () => {
    const { state, chatLog, loadHistory, handleChatEvent } = createHandlersHarness({
      activeChatRunId: "run-empty-replay",
      activityStatus: "streaming",
    });
    handleChatEvent({ runId: "run-empty-replay", state: "final" });
    chatLog.dropAssistant.mockClear();
    chatLog.finalizeAssistant.mockClear();
    loadHistory.mockClear();
    handleChatEvent({
      runId: "run-empty-replay",
      state: "final",
      message: {
        role: "assistant",
        content: [],
      },
    });

    expect(chatLog.dropAssistant).not.toHaveBeenCalled();
    expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    expect(loadHistory).not.toHaveBeenCalled();
    expect(state.activityStatus).toBe("idle");
  });

  describe("session.message history reload", () => {
    it.each([
      {
        name: "prefers canonical persisted identity over a conflicting event envelope",
        initialSessionId: "session-1",
        metadata: {
          id: "persisted-user",
          idempotencyKey: "persisted-run:user",
          runId: "execution-run",
          seq: 7,
        },
        envelope: { messageId: "envelope-user", clientRunId: "envelope-run", messageSeq: 99 },
        expected: {
          messageId: "persisted-user",
          runId: "execution-run",
          sendId: "persisted-run",
        },
      },
      {
        name: "binds the first session identity without dropping the live canonical prompt",
        initialSessionId: null,
        metadata: { id: "persisted-user", idempotencyKey: "persisted-run:user", seq: 7 },
        envelope: { messageId: "envelope-user", clientRunId: "envelope-run", messageSeq: 99 },
        expected: { messageId: "persisted-user", runId: "persisted-run", sendId: "persisted-run" },
      },
    ])("$name", ({ initialSessionId, metadata, envelope, expected }) => {
      const { state, chatLog, handleSessionMessageEvent } = createHandlersHarness({
        activeChatRunId: "run-existing",
        currentSessionId: initialSessionId,
      });
      handleSessionMessageEvent({
        ...(initialSessionId === null ? { sessionId: "first-persisted-session" } : {}),
        ...envelope,
        message: {
          role: "user",
          content: [{ type: "text", text: "Canonical cross-client prompt." }],
          ...(metadata ? { __openclaw: metadata } : {}),
        },
      });

      expect(chatLog.addLiveUser).toHaveBeenCalledExactlyOnceWith(
        "Canonical cross-client prompt.",
        expect.objectContaining(expected),
      );
      expect(state.sessionProjection?.entries).toHaveLength(1);
      expect(state.sessionProjection?.entries[0]?.identity).toMatchObject({
        id: expected.messageId,
        runId: expected.runId,
        sequence: metadata?.seq ?? envelope.messageSeq,
      });
      if (initialSessionId === null) {
        expect(state.sessionProjection?.scope.sessionId).toBe("first-persisted-session");
      }
    });

    it.each([
      { name: "persists a canonical imported sequence", persistedSequence: 7, expectedEntries: 1 },
      {
        name: "rejects an envelope-only imported sequence",
        persistedSequence: null,
        expectedEntries: 0,
      },
    ])("$name", ({ persistedSequence, expectedEntries }) => {
      const { state, chatLog, handleSessionMessageEvent } = createHandlersHarness();
      handleSessionMessageEvent({
        messageId: "native-or-provider-local-id",
        messageSeq: 99,
        message: {
          role: "user",
          content: "Partially imported prompt.",
          __openclaw: {
            id: "provider-local-id",
            importedFrom: "claude-cli",
            ...(persistedSequence === null ? {} : { seq: persistedSequence }),
          },
        },
      });

      expect(state.sessionProjection?.entries ?? []).toHaveLength(expectedEntries);
      expect(chatLog.addLiveUser).toHaveBeenCalledTimes(expectedEntries);
    });

    it.each([
      { name: "newer timestamp", updatedAt: 300 },
      { name: "older timestamp", updatedAt: 100 },
      { name: "missing timestamp", updatedAt: undefined },
    ])("checks session replacement for a snapshot with a $name", ({ updatedAt }) => {
      const { state, chatLog, loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        activeChatRunId: null,
        currentSessionId: "session-current",
        sessionInfo: { verboseLevel: "on", updatedAt: 200 },
      });
      const newer = updatedAt === 300;
      handleSessionMessageEvent({
        sessionId: "session-other",
        ...(updatedAt === undefined ? {} : { updatedAt }),
        message: newer
          ? undefined
          : {
              role: "user",
              content: "private previous-session prompt",
              __openclaw: { id: "previous-session-message", seq: 1 },
            },
      });

      expect(state.currentSessionId).toBe(newer ? "session-other" : "session-current");
      expect(state.sessionInfo.updatedAt).toBe(newer ? 300 : 200);
      expect(loadHistory).toHaveBeenCalledTimes(newer ? 1 : 0);
      if (!newer) {
        expect(chatLog.addLiveUser).not.toHaveBeenCalled();
        expect(state.sessionProjection?.entries ?? []).toHaveLength(0);
      }
    });

    it("reloads a global session only for its selected agent", () => {
      const { loadHistory, handleSessionMessageEvent } = createHandlersHarness({
        agentDefaultId: "main",
        activeChatRunId: null,
        currentAgentId: "work",
        currentSessionKey: "global",
        sessionScope: "global",
      });
      handleSessionMessageEvent({ sessionKey: "agent:work:global", agentId: "main" });
      expect(loadHistory).not.toHaveBeenCalled();
      handleSessionMessageEvent({ sessionKey: "global", agentId: "work" });
      expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it("refreshes after a local final when terminal persistence arrives first", () => {
      const {
        chatLog,
        loadHistory,
        handleChatEvent,
        handleSessionsChangedEvent,
        handleSessionMessageEvent,
      } = createHandlersHarness({ activeChatRunId: "run-active" });
      handleSessionMessageEvent();
      handleSessionsChangedEvent({ runId: "run-active", phase: "end" });
      expect(loadHistory).not.toHaveBeenCalled();
      handleChatEvent(textEvent("run-active", "keep this visible", "final"));
      expect(chatLog.finalizeAssistant).toHaveBeenCalledWith("keep this visible", "run-active", []);
      expect(loadHistory).toHaveBeenCalledTimes(1);
    });

    it("does not reload until an optimistic submit is resolved", () => {
      const { state, loadHistory, handleSessionMessageEvent, flushPendingHistoryRefreshIfIdle } =
        createHandlersHarness({
          activeChatRunId: null,
          pendingSubmit: sendingSubmit("run-pending"),
        });
      handleSessionMessageEvent();
      expect(loadHistory).not.toHaveBeenCalled();
      state.pendingSubmit = null;
      flushPendingHistoryRefreshIfIdle();
      expect(loadHistory).toHaveBeenCalledTimes(1);
    });
  });

  describe("sessions.changed history reload", () => {
    const startRun = (
      handleChatEvent: ReturnType<typeof createHandlersHarness>["handleChatEvent"],
      runId: string,
    ) => {
      handleChatEvent({ runId, message: { content: [{ type: "text", text: "typing" }] } });
    };

    const changeSession = (
      state: TuiStateAccess,
      handleSessionsChangedEvent: ReturnType<
        typeof createHandlersHarness
      >["handleSessionsChangedEvent"],
      sessionId = state.currentSessionId,
    ) => {
      handleSessionsChangedEvent({
        reason: "new",
        sessionId: sessionId ?? undefined,
        updatedAt: 200,
      });
    };

    const finishPersistence = (
      handleSessionsChangedEvent: ReturnType<
        typeof createHandlersHarness
      >["handleSessionsChangedEvent"],
      runId: string,
    ) => {
      handleSessionsChangedEvent({ phase: "end", runId });
    };

    const deferNextHistoryLoad = (loadHistory: MockFn) => {
      const history = createDeferred<TuiHistoryLoadResult>();
      loadHistory.mockReturnValueOnce(history.promise);
      return (loaded: boolean) =>
        history.resolve(
          loaded ? { loaded: true, runOutcome: { state: "completed" } } : { loaded: false },
        );
    };

    it("waits for terminal persistence before rebuilding an active external run", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ activeChatRunId: "run-active" });
      startRun(handleChatEvent, "run-active");
      chatLog.finalizeAssistant.mockClear();
      loadHistory.mockClear();
      changeSession(state, handleSessionsChangedEvent);
      expect(loadHistory).not.toHaveBeenCalled();
      handleChatEvent(textEvent("run-active", "reply", "final"));
      expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
      finishPersistence(handleSessionsChangedEvent, "run-active");
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(state.activeChatRunId).toBeNull());
      expect(state.activityStatus).toBe("idle");
      handleChatEvent(textEvent("run-active", "reply", "final"));
      expect(chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    });

    it.each(["before", "after"] as const)(
      "preserves a final arriving %s history failure",
      async (arrival) => {
        const {
          state,
          chatLog,
          loadHistory,
          setActivityStatus,
          handleChatEvent,
          handleSessionsChangedEvent,
        } = createHandlersHarness({ activeChatRunId: "run-active" });
        const resolveHistory = deferNextHistoryLoad(loadHistory);
        startRun(handleChatEvent, "run-active");
        chatLog.finalizeAssistant.mockClear();
        changeSession(state, handleSessionsChangedEvent);
        finishPersistence(handleSessionsChangedEvent, "run-active");
        if (arrival === "before") {
          handleChatEvent(textEvent("run-active", "fallback reply", "final"));
        }
        resolveHistory(false);
        if (arrival === "after") {
          await vi.waitFor(() => expect(state.activeChatRunId).toBeNull());
          expect(setActivityStatus).toHaveBeenCalledWith("idle");
          handleChatEvent(textEvent("run-active", "fallback reply", "final"));
          expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
            "fallback reply",
            "run-active",
            [],
          );
        } else {
          await vi.waitFor(() =>
            expect(chatLog.finalizeAssistant).toHaveBeenCalledWith(
              "fallback reply",
              "run-active",
              [],
            ),
          );
        }
      },
    );

    it("keeps a later terminal reload queued behind the current rebuild", async () => {
      const { state, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ activeChatRunId: "run-a" });
      const resolveFirstHistory = deferNextHistoryLoad(loadHistory);
      startRun(handleChatEvent, "run-a");
      startRun(handleChatEvent, "run-b");
      changeSession(state, handleSessionsChangedEvent);
      finishPersistence(handleSessionsChangedEvent, "run-a");
      finishPersistence(handleSessionsChangedEvent, "run-b");
      expect(loadHistory).toHaveBeenCalledTimes(1);
      resolveFirstHistory(true);
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    });

    it("preserves immediate reload behavior when new replaces a known session", () => {
      const { state, loadHistory, setActivityStatus, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({
          activeChatRunId: "run-old",
          currentSessionId: "session-old",
          activityStatus: "streaming",
        });
      startRun(handleChatEvent, "run-old");
      loadHistory.mockClear();
      changeSession(state, handleSessionsChangedEvent, "session-new");

      expect(loadHistory).toHaveBeenCalledTimes(1);
      expect(state.currentSessionId).toBe("session-new");
      expect(state.activeChatRunId).toBeNull();
      expect(setActivityStatus).toHaveBeenCalledWith("idle");
    });

    it("preserves displayed-run dedupe when reset history fails", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ activeChatRunId: "run-reset" });
      const resolveHistory = deferNextHistoryLoad(loadHistory);
      handleChatEvent(textEvent("run-reset", "done", "final"));
      chatLog.finalizeAssistant.mockClear();
      handleSessionsChangedEvent({
        reason: "reset",
        sessionId: state.currentSessionId ?? undefined,
      });
      resolveHistory(false);
      await Promise.resolve();
      handleChatEvent(textEvent("run-reset", "done", "final"));

      expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
    });

    it("gates late run events while reset history is rebuilding", async () => {
      const { state, chatLog, loadHistory, handleChatEvent, handleSessionsChangedEvent } =
        createHandlersHarness({ activeChatRunId: "run-reset" });
      startRun(handleChatEvent, "run-reset");
      chatLog.finalizeAssistant.mockClear();
      loadHistory.mockClear();
      handleSessionsChangedEvent({
        reason: "reset",
        sessionId: state.currentSessionId ?? undefined,
      });
      handleChatEvent(textEvent("run-reset", "stale after reset", "final"));
      await vi.waitFor(() => expect(loadHistory).toHaveBeenCalledTimes(1));
      expect(chatLog.finalizeAssistant).not.toHaveBeenCalled();
      expect(state.activeChatRunId).toBeNull();
    });
  });
});

describe("tui-event-handlers: streaming watchdog", () => {
  const expectedTimeoutMessage =
    "This response is taking longer than expected. Still waiting for the current run.";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createHarness = (options?: { streamingWatchdogMs?: number }) => {
    const state = makeTuiState();
    const chatLog = createMockChatLog();
    const btw = createMockBtwPresenter();
    const tui = { requestRender: vi.fn() };
    const setActivityStatus = vi.fn();
    const loadHistory = vi.fn();
    const localRunIds = new Set<string>();
    const noteLocalRunId = (runId: string) => {
      localRunIds.add(runId);
    };
    const rawHandlers = createEventHandlers({
      chatLog,
      btw,
      tui,
      state,
      setActivityStatus,
      updateFooter: vi.fn(),
      loadHistory,
      noteLocalRunId,
      isLocalRunId: localRunIds.has.bind(localRunIds),
      forgetLocalRunId: localRunIds.delete.bind(localRunIds),
      streamingWatchdogMs: options?.streamingWatchdogMs,
    });
    const handlers = {
      ...rawHandlers,
      handleChatEvent: (event: ChatEventOverrides) =>
        rawHandlers.handleChatEvent(makeChatEvent(state, event)),
      handleAgentEvent: (event: Partial<AgentEvent>) =>
        rawHandlers.handleAgentEvent(makeAgentEvent(event)),
    };
    return { state, chatLog, tui, setActivityStatus, loadHistory, noteLocalRunId, handlers };
  };

  it("keeps the watchdog busy until authoritative idle ownership settles", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });
    handlers.handleChatEvent(contentEvent("run-stuck", "hello"));

    expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
    expect(state.activeChatRunId).toBe("run-stuck");
    vi.advanceTimersByTime(5_001);
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-stuck");
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-stuck", expectedTimeoutMessage);
    handlers.handleSessionsChangedEvent({
      sessionKey: state.currentSessionKey,
      reason: "agent.input.settled",
      activeRunIds: [],
    });
    expect(state.activeChatRunId).toBeNull();
    expect(state.activityStatus).toBe("idle");
    expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-stuck");
    chatLog.addPendingSystem.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(chatLog.addPendingSystem).not.toHaveBeenCalled();
    handlers.dispose?.();
  });

  it.each(["replacement", "queued refresh", "lifecycle end"] as const)(
    "recovers once after reconnect with %s",
    (recovery) => {
      const { state, chatLog, loadHistory, noteLocalRunId, setActivityStatus, handlers } =
        createHarness({
          streamingWatchdogMs: 5_000,
        });
      handlers.handleChatEvent(contentEvent("run-reconnect", "hello"));
      if (recovery === "queued refresh") {
        noteLocalRunId("run-local-empty");
        handlers.handleChatEvent({ runId: "run-local-empty", state: "final" });
        vi.advanceTimersByTime(5_001);
        expect(state.activeChatRunId).toBe("run-reconnect");
        expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
        expect(loadHistory).not.toHaveBeenCalled();
      }
      handlers.pauseStreamingWatchdog();
      if (recovery === "queued refresh") {
        vi.advanceTimersByTime(10_000);
        expect(state.activeChatRunId).toBe("run-reconnect");
        expect(loadHistory).not.toHaveBeenCalled();
      }
      handlers.reconnectStreamingWatchdog();
      expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
      if (recovery === "replacement") {
        state.activeChatRunId = "run-after-reconnect";
        handlers.reconnectStreamingWatchdog({ state: "active", runId: "run-after-reconnect" });
      } else if (recovery === "lifecycle end") {
        handlers.handleAgentEvent({ runId: "run-reconnect", data: { phase: "end" } });
      }
      vi.advanceTimersByTime(5_001);
      expect(state.activeChatRunId).toBeNull();
      expect(setActivityStatus).toHaveBeenLastCalledWith("idle");
      expect(loadHistory).toHaveBeenCalledTimes(1);
      if (recovery === "lifecycle end") {
        expect(chatLog.addPendingSystem).not.toHaveBeenCalled();
      }
      handlers.dispose?.();
    },
  );

  it("is disabled when streamingWatchdogMs is 0", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 0,
    });
    handlers.handleChatEvent(contentEvent("run-no-watchdog", "hi"));
    vi.advanceTimersByTime(60_000);

    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(chatLog.addPendingSystem).not.toHaveBeenCalled();
    expect(state.activeChatRunId).toBe("run-no-watchdog");
    handlers.dispose?.();
  });

  it("does not let another run replace a watchdog-noticed active run", () => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });
    handlers.handleChatEvent(contentEvent("run-old", "old"));
    vi.advanceTimersByTime(5_001);
    expect(state.activeChatRunId).toBe("run-old");
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-old", expectedTimeoutMessage);
    handlers.handleChatEvent(contentEvent("run-new", "new"));
    expect(state.activeChatRunId).toBe("run-old");
    vi.advanceTimersByTime(3_000);
    handlers.handleChatEvent(contentEvent("run-old", "old again"));
    expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-old");
    vi.advanceTimersByTime(2_001);
    expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
    expect(state.activeChatRunId).toBe("run-old");
    expect(chatLog.addPendingSystem).toHaveBeenCalledTimes(1);
    handlers.dispose?.();
  });

  it("dismisses the watchdog notice when the final arrives after the watchdog fires", () => {
    const { chatLog, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });
    handlers.handleChatEvent(contentEvent("run-final-late", "starting"));
    vi.advanceTimersByTime(5_001);
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-final-late", expectedTimeoutMessage);
    handlers.handleChatEvent({
      runId: "run-final-late",
      state: "final",
      message: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
    });
    expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-final-late");
    handlers.dispose?.();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
