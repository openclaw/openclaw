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

function assistantText(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function expectUnused(...mocks: ReturnType<typeof vi.fn>[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

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
  return { runId: "run-1", sessionKey: state.currentSessionKey, state: "delta", ...overrides };
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
  return { runId: "run-1", stream: "lifecycle", data: { phase: "start" }, ...overrides };
}

const createHandlersHarness = (
  params?: Partial<TuiStateAccess> & {
    localMode?: boolean;
    refreshSessionInfo?: () => Promise<void>;
    streamingWatchdogMs?: number;
  },
  loadHistory = vi.fn<() => Promise<TuiHistoryLoadResult>>(async () => ({
    loaded: true,
    runOutcome: { state: "completed" },
  })),
) => {
  const { localMode, refreshSessionInfo, streamingWatchdogMs, ...overrides } = params ?? {};
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
    loadHistory,
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
    streamingWatchdogMs,
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
  return { ...context, ...handlers };
};

describe("tui-event-handlers: handleAgentEvent", () => {
  it("retires a gap-recovery run only after authoritative history reports completion", async () => {
    const h = createHandlersHarness({ activeChatRunId: "run-gap" });
    h.loadHistory.mockResolvedValueOnce({
      loaded: true,
      runOutcome: { state: "active", runId: "run-gap" },
    });
    h.reconcileHistoryAfterGap();
    expect(h.state.sessionProjection?.hasTransportGap).toBe(true);
    await settleHistory();
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    expect(h.state.activeChatRunId).toBe("run-gap");
    expect(h.setActivityStatus).not.toHaveBeenCalledWith("idle");
    h.reconcileHistoryAfterGap();
    await settleHistory();
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    h.dispose();
    h.reconcileHistoryAfterGap();
    await settleHistory();
    expect(h.loadHistory).toHaveBeenCalledTimes(3);
    expect(h.state.activeChatRunId).toBeNull();
  });

  it.each(["interrupted", "failed", "completed"] as const)(
    "reconciles a %s reconnect",
    (outcome) => {
      const h = createHandlersHarness({
        activeChatRunId: "run-current",
        activityStatus: "streaming",
      });
      if (outcome === "completed") {
        h.handleChatEvent(contentEvent("run-current", "partial"));
        h.chatLog.addSystem.mockClear();
        h.setActivityStatus.mockClear();
      }
      h.reconnectStreamingWatchdog(
        outcome === "failed"
          ? { state: outcome, errorMessage: "provider failed" }
          : { state: outcome },
      );
      if (outcome === "interrupted") {
        h.reconnectStreamingWatchdog({ state: outcome });
        h.handleChatEvent({
          runId: "run-current",
          message: { role: "assistant", content: "late stale output" },
        });
        expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
        expect(h.chatLog.updateAssistant).not.toHaveBeenCalled();
      } else if (outcome === "failed") {
        expect(h.chatLog.addSystem).toHaveBeenCalledWith("run error: provider failed");
      } else {
        expect(h.chatLog.addSystem).not.toHaveBeenCalledWith("run aborted");
      }
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.setActivityStatus).toHaveBeenLastCalledWith(outcome === "failed" ? "error" : "idle");
    },
  );

  it("honors the authoritative stop reason over the nested message stop reason", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-provider-error" });
    h.handleChatEvent({
      runId: "run-provider-error",
      state: "final",
      stopReason: "error",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Provider response." }],
        stopReason: "stop",
      },
    });
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Provider response.",
      "run-provider-error",
      [],
    );
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.setActivityStatus).toHaveBeenCalledWith("error");
    expect(h.setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it.each(["buffered", "literal", "thinking-only"] as const)(
    "preserves %s content when a local run aborts",
    (content) => {
      const h = createHandlersHarness({ activeChatRunId: "run-aborted-partial" });
      h.noteLocalRunId("run-aborted-partial");
      if (content !== "thinking-only") {
        h.handleChatEvent({
          runId: "run-aborted-partial",
          ...(content === "buffered" ? { seq: 1 } : {}),
          message: assistantText(content === "buffered" ? "(no " : "(no output)"),
        });
      }
      h.handleChatEvent({
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
        expect(h.chatLog.updateAssistant).toHaveBeenCalledWith("(no", "run-aborted-partial");
      }
      if (content === "thinking-only") {
        expect(h.chatLog.finalizeAssistant).not.toHaveBeenCalled();
      } else {
        expect(h.chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
          "(no output)",
          "run-aborted-partial",
        );
      }
      expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
      expectUnused(h.chatLog.dropAssistant, h.loadHistory);
      expect(h.isLocalRunId("run-aborted-partial")).toBe(false);
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.setActivityStatus).toHaveBeenLastCalledWith("aborted");
    },
  );

  it("sanitizes and truncates abort diagnostics on a UTF-16 boundary", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-hostile" });
    const prefix = `${"word ".repeat(31)}abc`;
    h.handleChatEvent({
      runId: "run-hostile",
      state: "aborted",
      errorMessage: `\u001b[31m\n${prefix}🚀tail`,
    });
    expect(h.chatLog.addSystem).toHaveBeenCalledWith(`run aborted: ${prefix}…`);
  });

  it.each([false, true])("settles a terminal lifecycle error with retry=%s", (retry) => {
    vi.useFakeTimers();
    const h = createHandlersHarness({ activeChatRunId: "run-error" });
    h.handleAgentEvent({
      runId: "run-error",
      data: {
        phase: "error",
        ...(retry ? {} : { endedAt: Date.now() }),
        error: "provider exploded",
      },
    });
    expect(h.chatLog.addSystem).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("run-error");
    expect(h.setActivityStatus).toHaveBeenCalledWith("error");
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);
    if (retry) {
      h.handleAgentEvent({
        runId: "run-error",
        data: { phase: "error", endedAt: Date.now(), error: "provider exploded" },
      });
      h.handleAgentEvent({ runId: "run-error", data: { phase: "start", startedAt: Date.now() } });
    }
    vi.advanceTimersByTime(15_000);
    if (retry) {
      expect(h.chatLog.addSystem).not.toHaveBeenCalledWith("run error: provider exploded");
      expect(h.state.activeChatRunId).toBe("run-error");
      expect(h.setActivityStatus).toHaveBeenCalledWith("running");
    } else {
      h.handleChatEvent({ runId: "run-error", state: "error", errorMessage: "provider exploded" });
      expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run error: provider exploded");
      expect(h.chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-error");
      expect(h.loadHistory).not.toHaveBeenCalled();
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.tui.requestRender).toHaveBeenCalledTimes(2);
    }
    vi.useRealTimers();
  });

  it.each([null, 1, "provider/"].map((destination) => ({ destination })))(
    "preserves model state for an invalid reported destination %#",
    ({ destination }) => {
      const h = createHandlersHarness({
        activeChatRunId: "run-invalid-destination",
        sessionInfo: { modelProvider: "openai", model: "gpt-4o" },
      });
      try {
        h.handleAgentEvent({
          runId: "run-invalid-destination",
          data: { phase: "fallback_step", fallbackStepToModel: destination },
        });
        expect(h.state.sessionInfo.modelProvider).toBe("openai");
        expect(h.state.sessionInfo.model).toBe("gpt-4o");
        expect(h.state.activeChatRunId).toBe("run-invalid-destination");
      } finally {
        h.dispose();
      }
    },
  );

  it.each(["active", "pending", "tracked"])(
    "refreshes the fallback model for a %s run",
    (ownership) => {
      const h = createHandlersHarness({
        activeChatRunId:
          ownership === "pending"
            ? null
            : ownership === "active"
              ? "run-pending"
              : "other-active-run",
        pendingSubmit: ownership === "pending" ? acceptedSubmit("run-pending") : null,
        sessionInfo: { verboseLevel: "on", modelProvider: "llamaforge", model: "qwen/qwen3.5-9b" },
      });
      if (ownership === "tracked") {
        h.handleAgentEvent({
          runId: "run-pending",
          sessionKey: h.state.currentSessionKey,
          data: { phase: "start" },
        });
        expect(h.state.activeChatRunId).toBe("other-active-run");
      }
      h.handleAgentEvent({
        runId: "run-pending",
        data: {
          phase: "fallback_step",
          fallbackStepFinalOutcome: "succeeded",
          fallbackStepFromModel: "openrouter/meta-llama/llama-3.1-70b",
          fallbackStepToModel: "nvidia/deepseek-ai/deepseek-v3.2",
        },
      });
      expect(h.state.sessionInfo.modelProvider).toBe("nvidia");
      expect(h.state.sessionInfo.model).toBe("deepseek-ai/deepseek-v3.2");
      expect(h.updateFooter).toHaveBeenCalledExactlyOnceWith();
      expect(h.updateFooter.mock.invocationCallOrder[0]).toBeLessThan(
        h.tui.requestRender.mock.invocationCallOrder.at(-1)!,
      );
      expect(h.tui.requestRender).toHaveBeenCalled();
    },
  );

  it("preserves a pending local run when the session key catches up before the first event", () => {
    const h = createHandlersHarness({
      currentSessionKey: "agent:main:initial",
      activeChatRunId: null,
      pendingSubmit: acceptedSubmit("run-pending"),
    });
    h.noteLocalRunId("run-pending");
    h.state.currentSessionKey = "agent:main:restored";
    h.handleChatEvent({
      ...textEvent("run-pending", "done", "final"),
      sessionKey: "agent:main:restored",
    });
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.isLocalRunId("run-pending")).toBe(false);
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending", []);
    expect(h.loadHistory).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps local finishing ownership with final pending=%s", (pending) => {
    const h = createHandlersHarness({
      localMode: true,
      activeChatRunId: null,
      pendingSubmit: pending ? acceptedSubmit("run-final") : null,
    });
    if (!pending) {
      h.handleChatEvent(textEvent("run-final", "done", "final"));
    }
    h.setActivityStatus.mockClear();
    h.tui.requestRender.mockClear();
    h.handleAgentEvent({ runId: "run-final", data: { phase: "finishing" } });
    expect(h.setActivityStatus).toHaveBeenCalledWith("finishing context");
    expect(h.tui.requestRender).toHaveBeenCalled();
    h.setActivityStatus.mockClear();
    h.tui.requestRender.mockClear();
    h.handleAgentEvent({ runId: "run-final", data: { phase: "end" } });
    expect(h.tui.requestRender).toHaveBeenCalledWith(true);
    if (pending) {
      expect(h.setActivityStatus).not.toHaveBeenCalledWith("idle");
      h.handleChatEvent(textEvent("run-final", "done", "final"));
    }
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
  });

  it("does not let delayed finalized-run lifecycle clobber a newer active run", () => {
    const h = createHandlersHarness({ activeChatRunId: null });
    h.handleChatEvent(textEvent("run-old", "old done", "final"));
    h.handleChatEvent(contentEvent("run-new", "new running"));
    h.setActivityStatus.mockClear();
    h.tui.requestRender.mockClear();
    h.handleAgentEvent({ runId: "run-old", data: { phase: "finishing" } });
    h.handleAgentEvent({ runId: "run-old", data: { phase: "end" } });
    expect(h.state.activeChatRunId).toBe("run-new");
    expectUnused(h.setActivityStatus, h.tui.requestRender);
  });

  it("promotes the confirmed concurrent run instead of a newer orphan delta", () => {
    const h = createHandlersHarness({ activeChatRunId: null });
    h.handleChatEvent(textEvent("run-first", "first live response"));
    h.handleAgentEvent({ runId: "run-second", sessionKey: h.state.currentSessionKey });
    h.handleChatEvent(textEvent("run-second", "second live response"));
    for (let index = 0; index < 500; index += 1) {
      h.handleChatEvent({
        runId: `run-orphan-${index}`,
        message: { content: [{ type: "text", text: `orphan ${index}` }] },
      });
    }
    h.handleSessionMessageEvent({ updatedAt: 200 });
    expect(h.loadHistory).not.toHaveBeenCalled();
    h.handleChatEvent({
      runId: "run-first",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(h.state.activeChatRunId).toBe("run-second");
    h.handleChatEvent({
      runId: "run-second",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "first live response",
      "run-first",
      [],
    );
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "second live response",
      "run-second",
      [],
    );
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    for (const runId of ["run-first", "run-second"]) {
      h.handleSessionsChangedEvent({ runId, phase: "end" });
    }
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    const displayedDeltaCount = h.chatLog.updateAssistant.mock.calls.length;
    h.handleChatEvent(textEvent("run-orphan-499", "late orphan"));
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.chatLog.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);
    h.handleChatEvent(textEvent("run-never-seen-orphan", "untracked late orphan"));
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.chatLog.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);
  });

  it("preserves a sequenced lifecycle-less peer behind a confirmed run handoff", () => {
    const h = createHandlersHarness({ activeChatRunId: null });
    h.handleChatEvent(textEvent("run-first", "first live response"));
    h.handleAgentEvent({ runId: "run-confirmed", sessionKey: h.state.currentSessionKey });
    h.handleChatEvent(textEvent("run-confirmed", "confirmed response"));
    h.handleChatEvent({
      runId: "run-without-lifecycle",
      seq: 1,
      message: { content: [{ type: "text", text: "older peer response" }] },
    });
    h.handleChatEvent(textEvent("run-orphan", "unconfirmed orphan"));
    h.handleChatEvent({
      runId: "run-first",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expect(["run-confirmed", "run-without-lifecycle"]).toContain(h.state.activeChatRunId);
    for (const runId of ["run-confirmed", "run-without-lifecycle"]) {
      h.handleChatEvent({
        runId,
        ...(runId === "run-without-lifecycle" ? { seq: 2 } : {}),
        state: "final",
        message: { role: "assistant", content: [] },
      });
    }
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith(
      "older peer response",
      "run-without-lifecycle",
      [],
    );
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
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
      const h = createHandlersHarness({
        activeChatRunId: null,
        currentSessionKey: selectedSessionKey,
        currentSessionId: "selected-session",
        sessionInfo: { verboseLevel: "on", updatedAt: 100 },
      });
      h.handleChatEvent({
        runId: "run-other-session",
        sessionKey: otherSessionKey,
        message: { content: "message from another conversation" },
      });
      h.handleAgentEvent({ runId: "run-other-lifecycle", sessionKey: otherSessionKey });
      h.handleBtwEvent({
        kind: "btw",
        runId: "run-other-btw",
        sessionKey: otherSessionKey,
        question: "other conversation?",
        text: "private answer",
      } satisfies BtwEvent);
      h.handleSessionsChangedEvent({
        sessionKey: otherSessionKey,
        reason: "reset",
        sessionId: "other-session",
        updatedAt: 200,
      });
      h.handleSessionMessageEvent({
        sessionKey: otherSessionKey,
        agentId: "main",
        sessionId: "other-session",
        updatedAt: 200,
      });
      expectUnused(h.chatLog.updateAssistant, h.btw.showResult, h.loadHistory);
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.state.currentSessionKey).toBe(selectedSessionKey);
      expect(h.state.currentSessionId).toBe("selected-session");
      expect(h.state.sessionInfo.updatedAt).toBe(100);
    },
  );

  it("discards a delayed local BTW result from the previous same-key session incarnation", () => {
    const h = createHandlersHarness({
      localMode: true,
      activeChatRunId: null,
      currentSessionId: "private-session",
    });
    h.noteLocalBtwRunId("private-btw-run");
    h.handleSessionsChangedEvent({
      sessionKey: h.state.currentSessionKey,
      reason: "reset",
      sessionId: "replacement-session",
      updatedAt: Date.now(),
    });
    h.handleBtwEvent({
      kind: "btw",
      runId: "private-btw-run",
      sessionKey: h.state.currentSessionKey,
      question: "what was discussed?",
      text: "answer from the previous session",
    });
    expect(h.state.currentSessionId).toBe("replacement-session");
    expect(h.btw.showResult).not.toHaveBeenCalled();
    h.noteLocalBtwRunId("replacement-btw-run");
    h.handleBtwEvent({
      kind: "btw",
      runId: "replacement-btw-run",
      sessionKey: h.state.currentSessionKey,
      question: "what changed?",
      text: "answer for the replacement session",
    });
    expect(h.btw.showResult).toHaveBeenCalledExactlyOnceWith({
      question: "what changed?",
      text: "answer for the replacement session",
      isError: undefined,
    });
  });

  it("clears stale streaming for a local BTW empty final without hiding the result", () => {
    const h = createHandlersHarness({ activeChatRunId: null, activityStatus: "streaming" });
    h.noteLocalBtwRunId("run-btw");
    h.handleBtwEvent({
      kind: "btw",
      runId: "run-btw",
      sessionKey: h.state.currentSessionKey,
      question: "what changed?",
      text: "nothing important",
    } satisfies BtwEvent);
    h.setActivityStatus.mockClear();
    h.handleChatEvent({ runId: "run-btw", state: "final" });
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.state.activityStatus).toBe("idle");
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.btw.showResult).toHaveBeenCalledWith({
      question: "what changed?",
      text: "nothing important",
      isError: undefined,
    });
  });

  it("clears run mapping when the session changes", () => {
    const h = createHandlersHarness({ activeChatRunId: null });
    h.handleChatEvent(contentEvent("run-old", "hello"));
    h.state.currentSessionKey = "agent:main:other";
    h.state.activeChatRunId = null;
    h.tui.requestRender.mockClear();
    h.handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc2", name: "exec" },
    });
    expectUnused(h.chatLog.startTool, h.tui.requestRender);
  });

  it("reloads the current session and clears stale run state after sessions.changed reset", () => {
    const refreshSessionInfo = vi.fn<() => Promise<void>>(async () => undefined);
    const h = createHandlersHarness({
      activeChatRunId: null,
      currentAgentId: "work",
      currentSessionKey: "agent:work:support",
      currentSessionId: "session-before",
      sessionInfo: { verboseLevel: "on", updatedAt: 100 },
      refreshSessionInfo,
    });
    h.handleChatEvent(textEvent("run-old", "done", "final"));
    h.noteLocalRunId("run-local");
    h.state.activeChatRunId = "run-stale";
    h.state.pendingSubmit = acceptedSubmit("run-pending");
    h.state.activityStatus = "streaming";
    h.loadHistory.mockClear();
    refreshSessionInfo.mockClear();
    h.chatLog.startTool.mockClear();
    h.btw.clear.mockClear();
    h.tui.requestRender.mockClear();
    h.setActivityStatus.mockClear();
    h.handleSessionsChangedEvent({
      sessionKey: "support",
      agentId: "work",
      reason: "reset",
      sessionId: "session-after",
      updatedAt: 200,
    });
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.state.activityStatus).toBe("idle");
    expect(h.state.currentSessionId).toBe("session-after");
    expect(h.state.sessionProjection?.scope.sessionId).toBe("session-after");
    expect(h.state.sessionProjection?.runs).toEqual({});
    expect(h.state.sessionInfo.updatedAt).toBe(200);
    expect(h.isLocalRunId("run-local")).toBe(false);
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    expect(h.btw.clear).toHaveBeenCalledTimes(1);
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    expect(refreshSessionInfo).not.toHaveBeenCalled();
    expect(h.tui.requestRender).toHaveBeenCalledTimes(1);
    h.handleAgentEvent({
      runId: "run-old",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-old", name: "exec" },
    });
    expect(h.chatLog.startTool).not.toHaveBeenCalled();
  });

  it("reports only the latest reset after all queued history reloads settle", async () => {
    const first = createDeferred<TuiHistoryLoadResult>();
    const second = createDeferred<TuiHistoryLoadResult>();
    const h = createHandlersHarness({ activeChatRunId: null });
    h.loadHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    try {
      h.handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1", updatedAt: 20 });
      h.handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1", updatedAt: 30 });
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      first.resolve({ loaded: true, runOutcome: { state: "completed" } });
      await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(2));
      expect(h.chatLog.addSystem).not.toHaveBeenCalled();
      h.state.activeChatRunId = "newly-adopted-run";
      second.resolve({ loaded: true, runOutcome: { state: "active", runId: "newly-adopted-run" } });
      await vi.waitFor(() =>
        expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith(
          "session agent:main:main reset",
        ),
      );
      expect(h.state.activeChatRunId).toBe("newly-adopted-run");
    } finally {
      h.dispose();
    }
  });

  it.each(["session", "global agent", "new lifecycle"])(
    "discards a reset receipt retired by %s while history loads",
    async (retirement) => {
      const history = createDeferred<TuiHistoryLoadResult>();
      const h = createHandlersHarness({
        currentSessionKey: retirement === "global agent" ? "global" : "agent:main:main",
        activeChatRunId: null,
      });
      h.loadHistory.mockReturnValueOnce(history.promise);
      h.handleSessionsChangedEvent({ reason: "reset", agentId: "main", sessionId: "session-1" });
      if (retirement === "session") {
        h.state.currentSessionKey = "agent:main:other";
      } else if (retirement === "global agent") {
        h.state.currentAgentId = "work";
      } else if (retirement === "new lifecycle") {
        h.handleSessionsChangedEvent({ reason: "new", sessionId: "replacement" });
      } else {
        h.dispose();
      }
      history.resolve({ loaded: true, runOutcome: { state: "completed" } });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(h.chatLog.addSystem).not.toHaveBeenCalled();
      h.dispose();
    },
  );

  it("reports an observed reset even when its history reload fails", async () => {
    const h = createHandlersHarness({ activeChatRunId: null });
    h.loadHistory.mockRejectedValueOnce(new Error("history unavailable"));
    try {
      h.handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1" });
      await vi.waitFor(() =>
        expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith(
          "session agent:main:main reset",
        ),
      );
    } finally {
      h.dispose();
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
      const h = createHandlersHarness({
        activeChatRunId: "run-active",
        activityStatus: "streaming",
        currentSessionId: "session-1",
        pendingSubmit,
      });
      h.handleSessionsChangedEvent({
        agentId: h.state.currentAgentId,
        sessionId: foreign ? "session-other" : "session-1",
        phase: "message",
        ...(foreign ? { activeRunIds: [] } : {}),
        ...identity,
      });
      expect(h.loadHistory).toHaveBeenCalledTimes(reloads);
      expect(h.state.currentSessionId).toBe("session-1");
      expect(h.state.activeChatRunId).toBe("run-active");
      expect(h.state.activityStatus).toBe("streaming");
      expect(h.state.pendingSubmit).toBe(pendingSubmit);
      expectUnused(h.setActivityStatus, h.chatLog.dropAssistant, h.btw.clear);
    },
  );

  it.each(["finalized", "off", "on"] as const)(
    "routes tool events with %s visibility",
    (visibility) => {
      const h = createHandlersHarness({
        activeChatRunId: visibility === "finalized" ? null : "run-final",
        sessionInfo: { verboseLevel: visibility === "off" ? "off" : "on" },
      });
      if (visibility === "finalized") {
        h.handleChatEvent(textEvent("run-final", "done", "final"));
      }
      if (visibility !== "on") {
        h.handleAgentEvent({
          runId: "run-final",
          stream: "tool",
          data: { phase: "start", toolCallId: "tc-final", name: "session_status" },
        });
      }
      if (visibility === "finalized") {
        expect(h.chatLog.startTool).toHaveBeenCalledWith(
          "tc-final",
          "session_status",
          undefined,
          "run-final",
        );
        expect(h.tui.requestRender).toHaveBeenCalled();
      } else if (visibility === "off") {
        expectUnused(h.chatLog.startTool, h.tui.requestRender);
      } else {
        for (const phase of ["update", "result"] as const) {
          h.handleAgentEvent({
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
        expect(h.chatLog.updateToolResult).toHaveBeenCalledExactlyOnceWith(
          "tc-on",
          { content: [] },
          { isError: false },
        );
      }
    },
  );

  it.each([
    {
      name: "attachment-only reply",
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
      errorMessage: undefined,
      text: "Attached image",
      sources: [{ source: "file:///Users/operator/private/image.png" }],
      detail: undefined,
    },
    {
      name: "contentless provider error",
      message: { content: [] },
      errorMessage: '401 {"error":{"message":"Missing scopes: model.request"}}',
      text: expect.stringContaining("HTTP 401"),
      sources: [],
      detail: "Missing scopes: model.request",
    },
  ])(
    "finalizes a $name instead of dropping it",
    ({ message, errorMessage, text, sources, detail }) => {
      const h = createHandlersHarness({ activeChatRunId: null });
      h.handleChatEvent({ runId: "run-final", state: "final", message, errorMessage });
      expect(h.chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
        text,
        "run-final",
        sources,
      );
      if (detail) {
        expect(h.chatLog.finalizeAssistant.mock.calls[0]?.[0]).toContain(detail);
      }
      expectUnused(h.chatLog.dropAssistant, h.loadHistory);
    },
  );

  it("preserves the assembled delta-only final across an older history snapshot", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-streamed-final" });
    const sessionKey = h.state.currentSessionKey;
    h.handleChatEvent({
      runId: "run-streamed-final",
      sessionKey,
      seq: 1,
      message: { role: "assistant", content: "Assembled streamed reply." },
    });
    h.handleChatEvent({
      runId: "run-streamed-final",
      sessionKey,
      seq: 2,
      state: "final",
      message: { role: "assistant", content: [] },
    });
    reduceTuiSessionProjection(h.state, {
      type: "snapshotLoaded",
      messages: [],
      scope: readTuiSessionProjectionScope(h.state),
    });
    expect(h.state.sessionProjection?.entries[0]?.message).toMatchObject({
      role: "assistant",
      content: "Assembled streamed reply.",
    });
  });

  it("forces render when a command final only adds system text", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-command" });
    h.handleChatEvent({
      runId: "run-command",
      state: "final",
      message: { command: true, content: [{ type: "text", text: "/status done" }] },
    });
    expect(h.chatLog.addSystem).toHaveBeenCalledWith("/status done");
    expect(h.tui.requestRender).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not let unrelated same-session events claim a pending optimistic run", () => {
    const h = createHandlersHarness({
      activeChatRunId: null,
      pendingSubmit: acceptedSubmit("run-pending"),
    });
    h.noteLocalRunId("run-pending");
    h.handleChatEvent(textEvent("run-other", "other done", "final"));
    expect(getPendingSubmitAcceptedRunId(h.state)).toBe("run-pending");
    expect(h.isLocalRunId("run-other")).toBe(false);
    expect(h.loadHistory).not.toHaveBeenCalled();
    h.handleChatEvent(textEvent("run-pending", "done", "final"));
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending", []);
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("ignores settled snapshots from an older incarnation of the selected session", () => {
    const h = createHandlersHarness({
      activeChatRunId: "run-current",
      activityStatus: "streaming",
      currentSessionId: "session-current",
    });
    h.handleSessionsChangedEvent({
      reason: "agent.input.settled",
      sessionId: "session-old",
      activeRunIds: [],
    });
    expect(h.state.activeChatRunId).toBe("run-current");
    expect(h.state.activityStatus).toBe("streaming");
    expect(h.setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it.each([{ pendingSubmit: sendingSubmit("run-pending"), activityStatus: "sending" }])(
    "preserves $activityStatus submit activity while retiring a stale owner",
    (pending) => {
      const h = createHandlersHarness({
        activeChatRunId: "run-stale",
        activityStatus: "streaming",
      });
      h.handleChatEvent({ runId: "run-stale", seq: 1, message: { content: "done" } });
      Object.assign(h.state, pending);
      h.setActivityStatus.mockClear();
      h.handleSessionsChangedEvent({ reason: "agent.input.settled", activeRunIds: [] });
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.state.pendingSubmit).toEqual(pending.pendingSubmit);
      expect(h.state.activityStatus).toBe(pending.activityStatus);
      expect(h.setActivityStatus).not.toHaveBeenCalledWith("idle");
    },
  );

  it.each([false, true])(
    "flushes deferred history after the active owner settles with stale streaming=%s",
    (stale) => {
      const h = createHandlersHarness({
        activeChatRunId: "run-main",
        activityStatus: stale ? "streaming" : "idle",
      });
      h.noteLocalRunId("run-local-empty");
      if (stale) {
        h.loadHistory.mockImplementation(async () => {
          expect(h.state.activeChatRunId).toBeNull();
          expect(h.state.activityStatus).toBe("idle");
          return { loaded: true, runOutcome: { state: "completed" } };
        });
      }
      h.handleChatEvent({ runId: "run-local-empty", state: "final" });
      if (stale) {
        expect(h.state.activeChatRunId).toBeNull();
        expect(h.state.activityStatus).toBe("idle");
        expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
      } else {
        expect(h.state.activeChatRunId).toBe("run-main");
        expect(h.loadHistory).not.toHaveBeenCalled();
        h.noteLocalRunId("run-main");
        h.handleChatEvent(textEvent("run-main", "done", "final"));
      }
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
    },
  );

  it("does not surface inactive orphan final failures as the global status", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-stale", activityStatus: "streaming" });
    h.handleChatEvent({
      runId: "run-orphan-error",
      state: "final",
      message: { content: [{ type: "text", text: "failed" }], stopReason: "error" },
    });
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    expect(h.setActivityStatus).not.toHaveBeenCalledWith("error");
  });

  it("does not clear global streaming for inactive local /btw aborted or error events", () => {
    const h = createHandlersHarness({ activeChatRunId: null, activityStatus: "streaming" });
    for (const terminalState of ["aborted", "error"] as const) {
      const runId = `run-btw-${terminalState}`;
      h.state.activeChatRunId = null;
      h.state.activityStatus = "streaming";
      h.setActivityStatus.mockClear();
      h.noteLocalBtwRunId(runId);
      h.handleChatEvent({
        runId,
        state: terminalState,
        errorMessage: terminalState === "error" ? "boom" : undefined,
      });
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.state.activityStatus).toBe("streaming");
      expect(h.setActivityStatus).not.toHaveBeenCalled();
    }
  });

  it("suppresses non-local empty final placeholders during concurrent runs", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-active" });
    h.handleChatEvent(contentEvent("run-active", "local stream"));
    h.loadHistory.mockClear();
    h.chatLog.finalizeAssistant.mockClear();
    h.chatLog.dropAssistant.mockClear();
    h.handleChatEvent({ runId: "run-other", state: "final", message: { content: [] } });
    expect(h.chatLog.finalizeAssistant).not.toHaveBeenCalledWith("(no output)", "run-other", []);
    expect(h.chatLog.dropAssistant).toHaveBeenCalledWith("run-other");
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("run-active");
  });

  it("restores a terminal error when another run delays a history reload", async () => {
    const h = createHandlersHarness({ activeChatRunId: "run-error" });
    h.handleChatEvent(contentEvent("run-other", "still running"));
    h.noteLocalRunId("run-local-empty");
    h.handleChatEvent({ runId: "run-local-empty", state: "final" });
    h.handleChatEvent({ runId: "run-error", state: "error", errorMessage: "provider exploded" });
    expect(h.state.activeChatRunId).toBe("run-other");
    expect(h.loadHistory).not.toHaveBeenCalled();
    h.handleChatEvent(textEvent("run-other", "done", "final"));
    await vi.waitFor(() => expect(h.chatLog.addSystem).toHaveBeenCalledTimes(2));
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    expect(h.chatLog.addSystem).toHaveBeenLastCalledWith("run error: provider exploded");
  });

  it.each([
    { name: "non-auth", error: "fixture provider failed" },
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
        const h = createHandlersHarness({
          localMode: true,
          activeChatRunId: name === "non-auth" ? "run-1" : null,
          sessionInfo: { modelProvider: provider },
        });
        h.handleChatEvent({ runId: "run-provider-error", state: "error", errorMessage: error });
        expect(h.chatLog.addSystem).toHaveBeenCalledWith(expected ?? `run error: ${error}`);
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
      const h = createHandlersHarness({
        localMode,
        activeChatRunId: null,
        sessionInfo: { modelProvider: "xai" },
      });
      h.handleAgentEvent({
        runId: "completed-run",
        sessionKey: h.state.currentSessionKey,
        data: { phase: "start" },
      });
      h.handleChatEvent(textEvent("completed-run", "done", "final"));
      h.state.pendingSubmit = sendingSubmit("untrusted-run");
      if (owned) {
        h.noteLocalRunId("untrusted-run");
      }
      const accepted = localMode && owned && sessionKey === h.state.currentSessionKey;
      const errorMessage = accepted ? "monthly spending limit" : "foreign private diagnostic";
      h.handleChatEvent({ runId: "untrusted-run", sessionKey, state: "error", errorMessage });
      if (accepted) {
        expect(h.state.pendingSubmit).toBeNull();
        expect(h.chatLog.addSystem).toHaveBeenCalledWith("run error: monthly spending limit");
      } else {
        expect(h.state.pendingSubmit).toEqual(sendingSubmit("untrusted-run"));
        expect(h.chatLog.addSystem).not.toHaveBeenCalledWith(
          "run error: foreign private diagnostic",
        );
      }
    },
  );

  it("keeps and deduplicates distinct same-run finals with persisted identities", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-message-tool" });
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
    const sourceEvent = makeChatEvent(h.state, {
      runId: "run-message-tool",
      state: "final",
      message: sourceReply,
    });
    const finalEvent = makeChatEvent(h.state, {
      runId: "run-message-tool",
      state: "final",
      message: automaticReply,
    });
    h.handleChatEvent(sourceEvent);
    h.handleChatEvent(finalEvent);
    h.handleChatEvent(finalEvent);
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledTimes(2);
    expect(h.chatLog.finalizeAssistant).toHaveBeenNthCalledWith(
      1,
      "Visible progress from the targetless message tool.",
      "run-message-tool",
      [],
    );
    expect(h.chatLog.finalizeAssistant).toHaveBeenNthCalledWith(
      2,
      "Visible automatic final reply.",
      "run-message-tool",
      [],
    );
    expect(h.state.activeChatRunId).toBeNull();
  });

  it("keeps a newer response streaming when a completed run fails afterward", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-completed" });
    h.handleChatEvent({
      runId: "run-completed",
      state: "final",
      message: assistantText("Delivered once."),
    });
    h.handleChatEvent(contentEvent("run-newer", "Newer response"));
    h.setActivityStatus.mockClear();
    h.handleChatEvent({ runId: "run-completed", state: "error", errorMessage: "  \t  " });
    const error: ChatEventOverrides = {
      runId: "run-completed",
      state: "error",
      errorMessage: "  late provider failure  ",
    };
    h.handleChatEvent(error);
    h.handleChatEvent(error);
    expect(h.state.activeChatRunId).toBe("run-newer");
    expect(h.chatLog.updateAssistant).toHaveBeenLastCalledWith("Newer response", "run-newer");
    expect(h.chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
      "Delivered once.",
      "run-completed",
      [],
    );
    expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run error: late provider failure");
    expect(h.setActivityStatus).not.toHaveBeenCalledWith("error");
    expect(h.setActivityStatus).not.toHaveBeenCalledWith("idle");
  });

  it("ignores an attachment final that arrives after the run was aborted", () => {
    const h = createHandlersHarness({ activeChatRunId: "run-abort-late-final" });
    const message = { role: "assistant", content: [{ type: "image", data: "secret-image" }] };
    h.handleChatEvent({
      runId: "run-abort-late-final",
      seq: 1,
      state: "aborted",
      errorMessage: "cancelled by user",
      message,
    });
    h.handleChatEvent({
      runId: "run-abort-late-final",
      state: "aborted",
      errorMessage: "cancelled by user",
      message,
    });
    h.handleChatEvent({ runId: "run-abort-late-final", seq: 2, state: "final", message });
    expect(h.chatLog.finalizeAssistant).not.toHaveBeenCalled();
    expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted: cancelled by user");
    expect(h.state.sessionProjection?.runs["run-abort-late-final"]?.status).toBe("aborted");
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
      const h = createHandlersHarness({ activeChatRunId: runId });
      h.handleChatEvent({ runId, seq: 1, ...terminal });
      h.handleChatEvent({
        runId,
        seq: 2,
        state: "final",
        message: assistantText("Recovered reply."),
      });
      expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith("Recovered reply.", runId, []);
      expect(h.state.sessionProjection?.runs[runId]?.status).toBe(expectedStatus);
    },
  );

  it("ignores duplicate empty final envelopes after a run already finalized empty", () => {
    const h = createHandlersHarness({
      activeChatRunId: "run-empty-replay",
      activityStatus: "streaming",
    });
    h.handleChatEvent({ runId: "run-empty-replay", state: "final" });
    h.chatLog.dropAssistant.mockClear();
    h.chatLog.finalizeAssistant.mockClear();
    h.loadHistory.mockClear();
    h.handleChatEvent({
      runId: "run-empty-replay",
      state: "final",
      message: { role: "assistant", content: [] },
    });
    expectUnused(h.chatLog.dropAssistant, h.chatLog.finalizeAssistant, h.loadHistory);
    expect(h.state.activityStatus).toBe("idle");
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
        expected: { messageId: "persisted-user", runId: "execution-run", sendId: "persisted-run" },
      },
      {
        name: "binds the first session identity without dropping the live canonical prompt",
        initialSessionId: null,
        metadata: { id: "persisted-user", idempotencyKey: "persisted-run:user", seq: 7 },
        envelope: { messageId: "envelope-user", clientRunId: "envelope-run", messageSeq: 99 },
        expected: { messageId: "persisted-user", runId: "persisted-run", sendId: "persisted-run" },
      },
    ])("$name", ({ initialSessionId, metadata, envelope, expected }) => {
      const h = createHandlersHarness({
        activeChatRunId: "run-existing",
        currentSessionId: initialSessionId,
      });
      h.handleSessionMessageEvent({
        ...(initialSessionId === null ? { sessionId: "first-persisted-session" } : {}),
        ...envelope,
        message: {
          role: "user",
          content: [{ type: "text", text: "Canonical cross-client prompt." }],
          ...(metadata ? { __openclaw: metadata } : {}),
        },
      });
      expect(h.chatLog.addLiveUser).toHaveBeenCalledExactlyOnceWith(
        "Canonical cross-client prompt.",
        expect.objectContaining(expected),
      );
      expect(h.state.sessionProjection?.entries).toHaveLength(1);
      expect(h.state.sessionProjection?.entries[0]?.identity).toMatchObject({
        id: expected.messageId,
        runId: expected.runId,
        sequence: metadata?.seq ?? envelope.messageSeq,
      });
      if (initialSessionId === null) {
        expect(h.state.sessionProjection?.scope.sessionId).toBe("first-persisted-session");
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
      const h = createHandlersHarness();
      h.handleSessionMessageEvent({
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
      expect(h.state.sessionProjection?.entries ?? []).toHaveLength(expectedEntries);
      expect(h.chatLog.addLiveUser).toHaveBeenCalledTimes(expectedEntries);
    });

    it.each([
      { name: "newer timestamp", updatedAt: 300 },
      { name: "older timestamp", updatedAt: 100 },
      { name: "missing timestamp", updatedAt: undefined },
    ])("checks session replacement for a snapshot with a $name", ({ updatedAt }) => {
      const h = createHandlersHarness({
        activeChatRunId: null,
        currentSessionId: "session-current",
        sessionInfo: { verboseLevel: "on", updatedAt: 200 },
      });
      const newer = updatedAt === 300;
      h.handleSessionMessageEvent({
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
      expect(h.state.currentSessionId).toBe(newer ? "session-other" : "session-current");
      expect(h.state.sessionInfo.updatedAt).toBe(newer ? 300 : 200);
      expect(h.loadHistory).toHaveBeenCalledTimes(newer ? 1 : 0);
      if (!newer) {
        expect(h.chatLog.addLiveUser).not.toHaveBeenCalled();
        expect(h.state.sessionProjection?.entries ?? []).toHaveLength(0);
      }
    });

    it("reloads a global session only for its selected agent", () => {
      const h = createHandlersHarness({
        agentDefaultId: "main",
        activeChatRunId: null,
        currentAgentId: "work",
        currentSessionKey: "global",
        sessionScope: "global",
      });
      h.handleSessionMessageEvent({ sessionKey: "agent:work:global", agentId: "main" });
      expect(h.loadHistory).not.toHaveBeenCalled();
      h.handleSessionMessageEvent({ sessionKey: "global", agentId: "work" });
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
    });

    it("reconciles terminal persistence before a late chat final", async () => {
      const h = createHandlersHarness({ activeChatRunId: "run-active" });
      h.handleSessionMessageEvent();
      h.handleSessionsChangedEvent({ runId: "run-active", phase: "end" });
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      h.handleChatEvent(textEvent("run-active", "keep this visible", "final"));
      await settleHistory();
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      expect(h.chatLog.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(
        "keep this visible",
        "run-active",
        [],
      );
    });

    it("does not reload until an optimistic submit is resolved", () => {
      const h = createHandlersHarness({
        activeChatRunId: null,
        pendingSubmit: sendingSubmit("run-pending"),
      });
      h.handleSessionMessageEvent();
      expect(h.loadHistory).not.toHaveBeenCalled();
      h.state.pendingSubmit = null;
      h.flushPendingHistoryRefreshIfIdle();
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
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
      const h = createHandlersHarness({ activeChatRunId: "run-active" });
      startRun(h.handleChatEvent, "run-active");
      h.chatLog.finalizeAssistant.mockClear();
      h.loadHistory.mockClear();
      changeSession(h.state, h.handleSessionsChangedEvent);
      expect(h.loadHistory).not.toHaveBeenCalled();
      h.handleChatEvent(textEvent("run-active", "reply", "final"));
      expect(h.chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
      finishPersistence(h.handleSessionsChangedEvent, "run-active");
      await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(h.state.activeChatRunId).toBeNull());
      expect(h.state.activityStatus).toBe("idle");
      h.handleChatEvent(textEvent("run-active", "reply", "final"));
      expect(h.chatLog.finalizeAssistant).toHaveBeenCalledTimes(1);
    });

    it.each(["before", "after"] as const)(
      "preserves a final arriving %s history failure",
      async (arrival) => {
        const h = createHandlersHarness({ activeChatRunId: "run-active" });
        const resolveHistory = deferNextHistoryLoad(h.loadHistory);
        startRun(h.handleChatEvent, "run-active");
        h.chatLog.finalizeAssistant.mockClear();
        changeSession(h.state, h.handleSessionsChangedEvent);
        finishPersistence(h.handleSessionsChangedEvent, "run-active");
        if (arrival === "before") {
          h.handleChatEvent(textEvent("run-active", "fallback reply", "final"));
        }
        resolveHistory(false);
        if (arrival === "after") {
          await vi.waitFor(() => expect(h.state.activeChatRunId).toBeNull());
          expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
          h.handleChatEvent(textEvent("run-active", "fallback reply", "final"));
          expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith(
            "fallback reply",
            "run-active",
            [],
          );
        } else {
          await vi.waitFor(() =>
            expect(h.chatLog.finalizeAssistant).toHaveBeenCalledWith(
              "fallback reply",
              "run-active",
              [],
            ),
          );
        }
      },
    );

    it("keeps a later terminal reload queued behind the current rebuild", async () => {
      const h = createHandlersHarness({ activeChatRunId: "run-a" });
      const resolveFirstHistory = deferNextHistoryLoad(h.loadHistory);
      startRun(h.handleChatEvent, "run-a");
      startRun(h.handleChatEvent, "run-b");
      changeSession(h.state, h.handleSessionsChangedEvent);
      finishPersistence(h.handleSessionsChangedEvent, "run-a");
      finishPersistence(h.handleSessionsChangedEvent, "run-b");
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      resolveFirstHistory(true);
      await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    });

    it("preserves immediate reload behavior when new replaces a known session", () => {
      const h = createHandlersHarness({
        activeChatRunId: "run-old",
        currentSessionId: "session-old",
        activityStatus: "streaming",
      });
      startRun(h.handleChatEvent, "run-old");
      h.loadHistory.mockClear();
      changeSession(h.state, h.handleSessionsChangedEvent, "session-new");
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      expect(h.state.currentSessionId).toBe("session-new");
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.setActivityStatus).toHaveBeenCalledWith("idle");
    });

    it("preserves displayed-run dedupe when reset history fails", async () => {
      const h = createHandlersHarness({ activeChatRunId: "run-reset" });
      const resolveHistory = deferNextHistoryLoad(h.loadHistory);
      h.handleChatEvent(textEvent("run-reset", "done", "final"));
      h.chatLog.finalizeAssistant.mockClear();
      h.handleSessionsChangedEvent({
        reason: "reset",
        sessionId: h.state.currentSessionId ?? undefined,
      });
      resolveHistory(false);
      await Promise.resolve();
      h.handleChatEvent(textEvent("run-reset", "done", "final"));
      expect(h.chatLog.finalizeAssistant).not.toHaveBeenCalled();
    });

    it("gates late run events while reset history is rebuilding", async () => {
      const h = createHandlersHarness({ activeChatRunId: "run-reset" });
      startRun(h.handleChatEvent, "run-reset");
      h.chatLog.finalizeAssistant.mockClear();
      h.loadHistory.mockClear();
      h.handleSessionsChangedEvent({
        reason: "reset",
        sessionId: h.state.currentSessionId ?? undefined,
      });
      h.handleChatEvent(textEvent("run-reset", "stale after reset", "final"));
      await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(1));
      expect(h.chatLog.finalizeAssistant).not.toHaveBeenCalled();
      expect(h.state.activeChatRunId).toBeNull();
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
    const harness = createHandlersHarness(
      { activeChatRunId: null, ...options },
      vi.fn<() => Promise<TuiHistoryLoadResult>>(),
    );
    return { ...harness, handlers: harness };
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
        createHarness({ streamingWatchdogMs: 5_000 });
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

  it.each(["delta", "final"] as const)("dismisses a watchdog notice on a late %s", (event) => {
    const { state, chatLog, setActivityStatus, handlers } = createHarness({
      streamingWatchdogMs: 5_000,
    });
    handlers.handleChatEvent(contentEvent("run-old", "old"));
    vi.advanceTimersByTime(5_001);
    expect(state.activeChatRunId).toBe("run-old");
    expect(chatLog.addPendingSystem).toHaveBeenCalledWith("run-old", expectedTimeoutMessage);
    if (event === "delta") {
      handlers.handleChatEvent(contentEvent("run-new", "new"));
      expect(state.activeChatRunId).toBe("run-old");
      vi.advanceTimersByTime(3_000);
      handlers.handleChatEvent(contentEvent("run-old", "old again"));
      vi.advanceTimersByTime(2_001);
      expect(setActivityStatus).not.toHaveBeenCalledWith("idle");
      expect(state.activeChatRunId).toBe("run-old");
      expect(chatLog.addPendingSystem).toHaveBeenCalledTimes(1);
    } else {
      handlers.handleChatEvent({
        runId: "run-old",
        state: "final",
        message: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
      });
    }
    expect(chatLog.dismissPendingSystem).toHaveBeenCalledWith("run-old");
    handlers.dispose?.();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
