import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../test/helpers/promise.js";
import * as failoverClassifier from "../agents/failover/classify-core.js";
import { createTuiCommandHandlersHarness } from "./tui-command-handlers-test-support.js";
import {
  createTuiEventHandlersHarness as createHarness,
  textEvent,
  type ChatEventOverrides,
} from "./tui-event-handlers-test-support.js";
import { expectUnused, expectCall, textMessage, clearMocks } from "./tui-handler-test-support.js";
import {
  readTuiSessionProjectionScope,
  reduceTuiSessionProjection,
} from "./tui-session-projection.js";
import { getPendingSubmitAcceptedRunId, type TuiPendingSubmit } from "./tui-submit-state.js";
import type { BtwEvent, ChatEvent, TuiHistoryLoadResult } from "./tui-types.js";

type MockFn = ReturnType<typeof vi.fn>;
function sendingSubmit(runId: string, draftText = "pending"): TuiPendingSubmit {
  return { phase: "sending", runId, draftText };
}

function acceptedSubmit(runId: string, draftText: string | null = "pending"): TuiPendingSubmit {
  return { phase: "accepted", runId, draftText };
}

function contentEvent(
  runId: string,
  content: string,
  state: ChatEvent["state"] = "delta",
): ChatEventOverrides {
  return { runId, state, message: { content } };
}

describe("tui-event-handlers: handleAgentEvent", () => {
  it.each([true, false])(
    "reports actual explicit followup starts only in local=%s mode",
    (localMode) => {
      const h = createHarness({ localMode });
      h.agent(h.runId, { phase: "start", explicitFollowup: true });
      expect(h.log.addSystem.mock.calls).toEqual(localMode ? [["Your followup has started."]] : []);
    },
  );

  it("retires a gap-recovery run only after authoritative history reports completion", async () => {
    const h = createHarness({ activeChatRunId: "run-gap" });
    h.loadHistory.mockResolvedValueOnce({
      loaded: true,
      runOutcome: { state: "active", runId: h.runId },
    });
    h.reconcileHistoryAfterGap();
    expect(h.state.sessionProjection?.hasTransportGap).toBe(true);
    await nextEventLoopTurn();
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    expect(h.state.activeChatRunId).toBe(h.runId);
    expect(h.status).not.toHaveBeenCalledWith("idle");
    h.reconcileHistoryAfterGap();
    await nextEventLoopTurn();
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.status).toHaveBeenCalledWith("idle", "completed");
    expect(h.programStates).toEqual(["done"]);
    h.dispose();
    h.reconcileHistoryAfterGap();
    await nextEventLoopTurn();
    expect(h.loadHistory).toHaveBeenCalledTimes(3);
    expect(h.state.activeChatRunId).toBeNull();
  });

  it.each(["interrupted", "failed"] as const)(
    "does not report completion when gap recovery finds a %s run",
    async (outcome) => {
      const h = createHarness();
      h.text(h.runId, "partial reply");
      h.loadHistory.mockResolvedValueOnce({
        loaded: true,
        runOutcome:
          outcome === "failed"
            ? { state: outcome, errorMessage: "provider failed" }
            : { state: outcome },
      });
      h.reconcileHistoryAfterGap();
      await nextEventLoopTurn();
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.programStates).toEqual(["working", outcome === "failed" ? "error" : "idle"]);
    },
  );

  it.each(["interrupted", "failed", "completed"] as const)("reconnect: %s", (outcome) => {
    const h = createHarness({ activeChatRunId: "run-current", activityStatus: "streaming" });
    if (outcome === "completed") {
      h.handleChatEvent(contentEvent(h.runId, "partial"));
      clearMocks(h.log.addSystem, h.status);
    }
    h.reconnectStreamingWatchdog(
      outcome === "failed"
        ? { state: outcome, errorMessage: "provider failed" }
        : { state: outcome },
    );
    if (outcome === "interrupted") {
      h.reconnectStreamingWatchdog({ state: outcome });
      h.chat(h.runId, { message: { role: "assistant", content: "late stale output" } });
      expect(h.log.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
      expect(h.log.updateAssistant).not.toHaveBeenCalled();
    } else if (outcome === "failed") {
      expect(h.log.addSystem).toHaveBeenCalledWith("run error: provider failed");
    } else {
      expect(h.log.addSystem).not.toHaveBeenCalledWith("run aborted");
    }
    expect(h.state.activeChatRunId).toBeNull();
    if (outcome === "failed") {
      expect(h.status).toHaveBeenLastCalledWith("error");
      expect(h.programStates).toEqual(["error"]);
    } else {
      expect(h.status).toHaveBeenCalledWith(
        "idle",
        outcome === "completed" ? "completed" : "aborted",
      );
      expect(h.programStates).toEqual(outcome === "completed" ? ["working", "done"] : ["idle"]);
    }
  });

  it("honors the authoritative stop reason over the nested message stop reason", () => {
    const h = createHarness({ activeChatRunId: "run-provider-error" });
    h.chat(h.runId, {
      state: "final",
      stopReason: "error",
      message: { ...textMessage("Provider response."), stopReason: "stop" },
    });
    expectCall(h.log.finalizeAssistant, ["Provider response.", h.runId, []], "once");
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.status).toHaveBeenCalledWith("error");
    expect(h.status).not.toHaveBeenCalledWith("idle");
    h.agent(h.runId, { phase: "finishing" });
    h.agent(h.runId, { phase: "end" });
    expect(h.programStates).toEqual(["error", "working", "error"]);
  });

  it.each(["buffered", "literal", "thinking-only"] as const)(
    "local abort preserves %s",
    (content) => {
      const h = createHarness({ activeChatRunId: "run-aborted-partial" });
      h.noteLocalRunId(h.runId);
      if (content !== "thinking-only") {
        h.chat(h.runId, {
          ...(content === "buffered" ? { seq: 1 } : {}),
          message: textMessage(content === "buffered" ? "(no " : "(no output)"),
        });
      }
      h.chat(h.runId, {
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
        expect(h.log.updateAssistant).toHaveBeenCalledWith("(no", h.runId);
      }
      if (content === "thinking-only") {
        expect(h.log.finalizeAssistant).not.toHaveBeenCalled();
      } else {
        expect(h.log.finalizeAssistant).toHaveBeenCalledExactlyOnceWith("(no output)", h.runId);
      }
      expect(h.log.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
      expectUnused(h.log.dropAssistant, h.loadHistory);
      expect(h.isLocalRunId(h.runId)).toBe(false);
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.status).toHaveBeenLastCalledWith("aborted");
    },
  );

  it("sanitizes and truncates abort diagnostics on a UTF-16 boundary", () => {
    const h = createHarness({ activeChatRunId: "run-hostile" });
    const prefix = `${"word ".repeat(31)}abc`;
    h.chat(h.runId, { state: "aborted", errorMessage: `\u001b[31m\n${prefix}🚀tail` });
    expect(h.log.addSystem).toHaveBeenCalledWith(`run aborted: ${prefix}…`);
  });

  it.each([false, true])("settles a terminal lifecycle error with retry=%s", (retry) => {
    vi.useFakeTimers();
    const h = createHarness({ activeChatRunId: "run-error" });
    h.agent(h.runId, {
      phase: "error",
      ...(retry ? {} : { endedAt: Date.now() }),
      error: "provider exploded",
    });
    expect(h.log.addSystem).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe(h.runId);
    expect(h.status).toHaveBeenCalledWith("error");
    expect(h.render).toHaveBeenCalledTimes(1);
    if (retry) {
      h.agent(h.runId, { phase: "error", endedAt: Date.now(), error: "provider exploded" });
      h.agent(h.runId, { phase: "start", startedAt: Date.now() });
    }
    vi.advanceTimersByTime(15_000);
    if (retry) {
      expect(h.log.addSystem).not.toHaveBeenCalledWith("run error: provider exploded");
      expect(h.state.activeChatRunId).toBe(h.runId);
      expect(h.status).toHaveBeenCalledWith("running");
    } else {
      h.chat(h.runId, { state: "error", errorMessage: "provider exploded" });
      expect(h.log.addSystem).toHaveBeenCalledExactlyOnceWith("run error: provider exploded");
      expect(h.log.dismissPendingSystem).toHaveBeenCalledWith(h.runId);
      expect(h.loadHistory).not.toHaveBeenCalled();
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.render).toHaveBeenCalledTimes(2);
    }
    vi.useRealTimers();
  });

  it.each([null, 1, "provider/"])("rejects invalid fallback destination %#", (destination) => {
    const h = createHarness({
      activeChatRunId: "run-invalid-destination",
      sessionInfo: { modelProvider: "openai", model: "gpt-4o" },
    });
    h.agent(h.runId, { phase: "fallback_step", fallbackStepToModel: destination });
    expect(h.state.sessionInfo).toMatchObject({ modelProvider: "openai", model: "gpt-4o" });
    expect(h.state.activeChatRunId).toBe(h.runId);
  });

  it.each(["active", "pending", "tracked"])("fallback model: %s ownership", (ownership) => {
    const h = createHarness({
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
      h.agent("run-pending", { phase: "start" }, { sessionKey: h.state.currentSessionKey });
      expect(h.state.activeChatRunId).toBe("other-active-run");
    }
    h.agent("run-pending", {
      phase: "fallback_step",
      fallbackStepFinalOutcome: "succeeded",
      fallbackStepFromModel: "openrouter/meta-llama/llama-3.1-70b",
      fallbackStepToModel: "nvidia/deepseek-ai/deepseek-v3.2",
    });
    expect(h.state.sessionInfo).toMatchObject({
      modelProvider: "nvidia",
      model: "deepseek-ai/deepseek-v3.2",
    });
    expect(h.updateFooter).toHaveBeenCalledExactlyOnceWith();
    expect(h.updateFooter.mock.invocationCallOrder[0]).toBeLessThan(
      h.render.mock.invocationCallOrder.at(-1)!,
    );
    expect(h.render).toHaveBeenCalled();
  });

  it("preserves a pending local run when the session key catches up before the first event", () => {
    const h = createHarness({
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
    expect(h.log.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending", []);
    expect(h.loadHistory).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps local finishing ownership with final pending=%s", (pending) => {
    const h = createHarness({
      localMode: true,
      activeChatRunId: null,
      pendingSubmit: pending ? acceptedSubmit("run-final") : null,
    });
    if (!pending) {
      h.text("run-final", "done", "final");
    }
    clearMocks(h.status, h.render);
    h.agent("run-final", { phase: "finishing" });
    expect(h.status).toHaveBeenCalledWith("finishing context");
    expect(h.render).toHaveBeenCalled();
    clearMocks(h.status, h.render);
    h.agent("run-final", { phase: "end" });
    expect(h.render).toHaveBeenCalledWith(true);
    if (pending) {
      expect(h.status).not.toHaveBeenCalledWith("idle");
      h.text("run-final", "done", "final");
    }
    expect(h.status).toHaveBeenCalledWith("idle", "completed");
    expect(h.programStates).toEqual(pending ? ["working", "done"] : ["done", "working", "done"]);
  });

  it.each(["sending", "accepted"] as const)(
    "does not report completion while another submission is %s",
    (phase) => {
      const h = createHarness();
      h.text(h.runId, "first reply");
      h.state.pendingSubmit =
        phase === "sending" ? sendingSubmit("run-next") : acceptedSubmit("run-next");
      h.state.activityStatus = phase === "sending" ? "sending" : "waiting";
      h.status(h.state.activityStatus);
      h.text(h.runId, "first reply", "final");
      h.agent(h.runId, { phase: "finishing" });
      h.agent(h.runId, { phase: "end" });
      expect(h.state.pendingSubmit?.runId).toBe("run-next");
      expect(h.programStates).toEqual(["working"]);
      h.state.pendingSubmit = acceptedSubmit("run-next");
      h.agent("run-next", { phase: "start" });
      h.text("run-next", "second reply", "final");
      expect(h.programStates).toEqual(["working", "done"]);
    },
  );

  it.each(["final", "error", "aborted"] as const)(
    "preserves a %s outcome when the accepted run finishes before its differently keyed ACK",
    async (outcome) => {
      const ack = createDeferred<{ runId: string }>();
      const h = createHarness({ activeChatRunId: null });
      const commands = createTuiCommandHandlersHarness({
        state: h.state,
        sendChat: vi.fn(() => ack.promise),
        setActivityStatus: h.status,
        consumeCompletedRunForPendingSend: vi.fn(h.consumeCompletedRunForPendingSend),
        isRunObserved: h.isRunObserved,
        flushPendingHistoryRefreshIfIdle: vi.fn(h.flushPendingHistoryRefreshIfIdle),
      });
      const sending = commands.handleCommand("steered request");
      expect(h.state.pendingSubmit?.runId).not.toBe("accepted-run");
      h.agent("accepted-run", { phase: "start" }, { sessionKey: h.state.currentSessionKey });
      h.chat("accepted-run", { state: outcome, message: { content: "reply" } });
      expect(h.state.pendingSubmit).not.toBeNull();
      ack.resolve({ runId: "accepted-run" });
      await sending;
      expect(h.state.pendingSubmit).toBeNull();
      expect(h.programStates.at(-1)).toBe(
        outcome === "final" ? "done" : outcome === "error" ? "error" : "idle",
      );
      if (outcome !== "final") {
        expect(h.programStates).not.toContain("done");
      }
    },
  );

  it("does not let delayed finalized-run lifecycle clobber a newer active run", () => {
    const h = createHarness({ activeChatRunId: null });
    h.text("run-old", "old done", "final");
    h.handleChatEvent(contentEvent("run-new", "new running"));
    clearMocks(h.status, h.render);
    h.agent("run-old", { phase: "finishing" });
    h.agent("run-old", { phase: "end" });
    expect(h.state.activeChatRunId).toBe("run-new");
    expectUnused(h.status, h.render);
  });

  it("promotes the confirmed concurrent run instead of a newer orphan delta", () => {
    const h = createHarness({ activeChatRunId: null });
    h.text("run-first", "first live response");
    h.agent("run-second", undefined, { sessionKey: h.state.currentSessionKey });
    h.text("run-second", "second live response");
    for (let index = 0; index < 500; index += 1) {
      h.chat(`run-orphan-${index}`, {
        message: { content: [{ type: "text", text: `orphan ${index}` }] },
      });
    }
    h.handleSessionMessageEvent({ updatedAt: 200 });
    expect(h.loadHistory).not.toHaveBeenCalled();
    h.chat("run-first", { state: "final", message: { role: "assistant", content: [] } });
    expect(h.state.activeChatRunId).toBe("run-second");
    h.chat("run-second", { state: "final", message: { role: "assistant", content: [] } });
    expect(h.log.finalizeAssistant).toHaveBeenCalledWith("first live response", "run-first", []);
    expect(h.log.finalizeAssistant).toHaveBeenCalledWith("second live response", "run-second", []);
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.status).toHaveBeenCalledWith("idle", "completed");
    for (const runId of ["run-first", "run-second"]) {
      h.handleSessionsChangedEvent({ runId, phase: "end" });
    }
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    const displayedDeltaCount = h.log.updateAssistant.mock.calls.length;
    h.text("run-orphan-499", "late orphan");
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.log.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);
    h.text("run-never-seen-orphan", "untracked late orphan");
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.log.updateAssistant).toHaveBeenCalledTimes(displayedDeltaCount);
  });

  it("preserves a sequenced lifecycle-less peer behind a confirmed run handoff", () => {
    const h = createHarness({ activeChatRunId: null });
    h.text("run-first", "first live response");
    h.agent("run-confirmed", undefined, { sessionKey: h.state.currentSessionKey });
    h.text("run-confirmed", "confirmed response");
    h.chat("run-without-lifecycle", {
      seq: 1,
      message: { content: [{ type: "text", text: "older peer response" }] },
    });
    h.text("run-orphan", "unconfirmed orphan");
    h.chat("run-first", { state: "final", message: { role: "assistant", content: [] } });
    expect(["run-confirmed", "run-without-lifecycle"]).toContain(h.state.activeChatRunId);
    for (const runId of ["run-confirmed", "run-without-lifecycle"]) {
      h.chat(runId, {
        ...(runId === "run-without-lifecycle" ? { seq: 2 } : {}),
        state: "final",
        message: { role: "assistant", content: [] },
      });
    }
    expectCall(h.log.finalizeAssistant, ["older peer response", "run-without-lifecycle", []]);
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.status).toHaveBeenCalledWith("idle", "completed");
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
      const h = createHarness({
        activeChatRunId: null,
        currentSessionKey: selectedSessionKey,
        currentSessionId: "selected-session",
        sessionInfo: { verboseLevel: "on", updatedAt: 100 },
      });
      h.chat("run-other-session", {
        sessionKey: otherSessionKey,
        message: { content: "message from another conversation" },
      });
      h.agent("run-other-lifecycle", undefined, { sessionKey: otherSessionKey });
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
      expectUnused(h.log.updateAssistant, h.btw.showResult, h.loadHistory);
      expect(h.state).toMatchObject({
        activeChatRunId: null,
        currentSessionKey: selectedSessionKey,
        currentSessionId: "selected-session",
      });
      expect(h.state.sessionInfo.updatedAt).toBe(100);
    },
  );

  it("discards a delayed local BTW result from the previous same-key session incarnation", () => {
    const h = createHarness({
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
    const h = createHarness({ activeChatRunId: null, activityStatus: "streaming" });
    h.noteLocalBtwRunId("run-btw");
    h.handleBtwEvent({
      kind: "btw",
      runId: "run-btw",
      sessionKey: h.state.currentSessionKey,
      question: "what changed?",
      text: "nothing important",
    } satisfies BtwEvent);
    h.status.mockClear();
    h.chat("run-btw", { state: "final" });
    expect(h.state).toMatchObject({ activeChatRunId: null, activityStatus: "idle" });
    expect(h.status).toHaveBeenCalledWith("idle");
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.btw.showResult).toHaveBeenCalledWith({
      question: "what changed?",
      text: "nothing important",
      isError: undefined,
    });
  });

  it("clears run mapping when the session changes", () => {
    const h = createHarness({ activeChatRunId: null });
    h.handleChatEvent(contentEvent("run-old", "hello"));
    h.state.currentSessionKey = "agent:main:other";
    h.state.activeChatRunId = null;
    h.render.mockClear();
    h.agent("run-old", { phase: "start", toolCallId: "tc2", name: "exec" }, { stream: "tool" });
    expectUnused(h.log.startTool, h.render);
  });

  it("reloads the current session and clears stale run state after sessions.changed reset", async () => {
    const refreshSessionInfo = vi.fn<() => Promise<void>>(async () => undefined);
    const h = createHarness({
      activeChatRunId: null,
      currentAgentId: "work",
      currentSessionKey: "agent:work:support",
      currentSessionId: "session-before",
      sessionInfo: { verboseLevel: "on", updatedAt: 100 },
      refreshSessionInfo,
    });
    h.text("run-old", "done", "final");
    h.noteLocalRunId("run-local");
    h.text("run-stale", "still streaming");
    h.state.pendingSubmit = acceptedSubmit("run-pending");
    h.state.activityStatus = "streaming";
    h.loadHistory.mockClear();
    clearMocks(refreshSessionInfo, h.log.startTool, h.btw.clear, h.render, h.status);
    h.handleSessionsChangedEvent({
      sessionKey: "support",
      agentId: "work",
      reason: "reset",
      sessionId: "session-after",
      updatedAt: 200,
    });
    expect(h.state).toMatchObject({
      activeChatRunId: null,
      pendingSubmit: null,
      activityStatus: "idle",
      currentSessionId: "session-after",
    });
    expect(h.state.sessionProjection?.scope.sessionId).toBe("session-after");
    expect(h.state.sessionProjection?.runs).toEqual({});
    expect(h.state.sessionInfo.updatedAt).toBe(200);
    expect(h.isLocalRunId("run-local")).toBe(false);
    expect(h.status).toHaveBeenCalledWith("idle");
    expect(h.btw.clear).toHaveBeenCalledTimes(1);
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    expect(refreshSessionInfo).not.toHaveBeenCalled();
    expect(h.render).toHaveBeenCalledTimes(1);
    h.agent("run-old", { phase: "start", toolCallId: "tc-old", name: "exec" }, { stream: "tool" });
    expect(h.log.startTool).not.toHaveBeenCalled();
    await nextEventLoopTurn();
    expect(h.programStates).toEqual(["done", "working", "idle"]);
  });

  it("reports only the latest reset after all queued history reloads settle", async () => {
    const first = createDeferred<TuiHistoryLoadResult>();
    const second = createDeferred<TuiHistoryLoadResult>();
    const h = createHarness({ activeChatRunId: null });
    h.loadHistory.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    h.handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1", updatedAt: 20 });
    h.handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1", updatedAt: 30 });
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    first.resolve({ loaded: true, runOutcome: { state: "completed" } });
    await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(2));
    expect(h.log.addSystem).not.toHaveBeenCalled();
    h.state.activeChatRunId = "newly-adopted-run";
    second.resolve({ loaded: true, runOutcome: { state: "active", runId: "newly-adopted-run" } });
    await vi.waitFor(() =>
      expect(h.log.addSystem).toHaveBeenCalledExactlyOnceWith("session agent:main:main reset"),
    );
    expect(h.state.activeChatRunId).toBe("newly-adopted-run");
  });

  it.each(["session", "global agent", "new lifecycle"])(
    "retires reset receipt during %s",
    async (retirement) => {
      const history = createDeferred<TuiHistoryLoadResult>();
      const h = createHarness({
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
      }
      history.resolve({ loaded: true, runOutcome: { state: "completed" } });
      await nextEventLoopTurn();
      expect(h.log.addSystem).not.toHaveBeenCalled();
    },
  );

  it("reports an observed reset even when its history reload fails", async () => {
    const h = createHarness({ activeChatRunId: null });
    h.loadHistory.mockRejectedValueOnce(new Error("history unavailable"));
    h.handleSessionsChangedEvent({ reason: "reset", sessionId: "session-1" });
    await vi.waitFor(() =>
      expect(h.log.addSystem).toHaveBeenCalledExactlyOnceWith("session agent:main:main reset"),
    );
  });

  it.each([
    ["legacy batch", {}, false, 1],
    ["foreign incarnation", {}, true, 0],
    ["persisted identity", { messageId: "message-1" }, false, 0],
    ["persisted sequence", { messageSeq: 7 }, false, 0],
    ["concrete message", { message: { role: "user", content: "hello" } }, false, 0],
    ["run identity", { runId: "run-message" }, false, 0],
    ["client run identity", { clientRunId: "run-message" }, false, 0],
  ] as const)("message ownership: %s", (_name, identity, foreign, reloads) => {
    const pendingSubmit = acceptedSubmit("run-pending");
    const h = createHarness({
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
    expect(h.state).toMatchObject({
      currentSessionId: "session-1",
      activeChatRunId: h.runId,
      activityStatus: "streaming",
    });
    expect(h.state.pendingSubmit).toBe(pendingSubmit);
    expectUnused(h.status, h.log.dropAssistant, h.btw.clear);
  });

  it.each(["finalized", "off", "on"] as const)("tool visibility: %s", (visibility) => {
    const h = createHarness({
      activeChatRunId: visibility === "finalized" ? null : "run-final",
      sessionInfo: { verboseLevel: visibility === "off" ? "off" : "on" },
    });
    if (visibility === "finalized") {
      h.text("run-final", "done", "final");
    }
    if (visibility !== "on") {
      h.agent(
        "run-final",
        { phase: "start", toolCallId: "tc-final", name: "session_status" },
        { stream: "tool" },
      );
    }
    if (visibility === "finalized") {
      expectCall(h.log.startTool, ["tc-final", "session_status", undefined, "run-final"]);
      expect(h.render).toHaveBeenCalled();
    } else if (visibility === "off") {
      expectUnused(h.log.startTool, h.render);
    } else {
      for (const phase of ["update", "result"] as const) {
        h.agent(
          "run-final",
          {
            phase,
            toolCallId: "tc-on",
            name: "session_status",
            partialResult: { content: [{ type: "text", text: "secret" }] },
            result: { content: [{ type: "text", text: "secret" }] },
            isError: false,
          },
          { stream: "tool" },
        );
      }
      expectCall(h.log.updateToolResult, ["tc-on", { content: [] }, { isError: false }], "once");
    }
  });

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
      const h = createHarness({ activeChatRunId: null });
      h.chat("run-final", { state: "final", message, errorMessage });
      expect(h.log.finalizeAssistant).toHaveBeenCalledExactlyOnceWith(text, "run-final", sources);
      if (detail) {
        expect(h.log.finalizeAssistant.mock.calls[0]?.[0]).toContain(detail);
      }
      expectUnused(h.log.dropAssistant, h.loadHistory);
    },
  );

  it("preserves the assembled delta-only final across an older history snapshot", () => {
    const h = createHarness({ activeChatRunId: "run-streamed-final" });
    const sessionKey = h.state.currentSessionKey;
    h.chat(h.runId, {
      sessionKey,
      seq: 1,
      message: { role: "assistant", content: "Assembled streamed reply." },
    });
    h.chat(h.runId, {
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
    const h = createHarness({ activeChatRunId: "run-command" });
    h.chat(h.runId, {
      state: "final",
      message: { command: true, content: [{ type: "text", text: "/status done" }] },
    });
    expect(h.log.addSystem).toHaveBeenCalledWith("/status done");
    expect(h.render).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not let unrelated same-session events claim a pending optimistic run", () => {
    const h = createHarness({
      activeChatRunId: null,
      pendingSubmit: acceptedSubmit("run-pending"),
    });
    h.noteLocalRunId("run-pending");
    h.text("run-other", "other done", "final");
    expect(getPendingSubmitAcceptedRunId(h.state)).toBe("run-pending");
    expect(h.isLocalRunId("run-other")).toBe(false);
    expect(h.loadHistory).not.toHaveBeenCalled();
    h.text("run-pending", "done", "final");
    expect(h.state.pendingSubmit).toBeNull();
    expect(h.log.finalizeAssistant).toHaveBeenCalledWith("done", "run-pending", []);
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("ignores settled snapshots from an older incarnation of the selected session", () => {
    const h = createHarness({
      activeChatRunId: "run-current",
      activityStatus: "streaming",
      currentSessionId: "session-current",
    });
    h.handleSessionsChangedEvent({
      reason: "agent.input.settled",
      sessionId: "session-old",
      activeRunIds: [],
    });
    expect(h.state).toMatchObject({ activeChatRunId: h.runId, activityStatus: "streaming" });
    expect(h.status).not.toHaveBeenCalledWith("idle");
  });

  it.each([{ pendingSubmit: sendingSubmit("run-pending"), activityStatus: "sending" }])(
    "preserves $activityStatus submit activity while retiring a stale owner",
    (pending) => {
      const h = createHarness({ activeChatRunId: "run-stale", activityStatus: "streaming" });
      h.chat(h.runId, { seq: 1, message: { content: "done" } });
      Object.assign(h.state, pending);
      h.status.mockClear();
      h.handleSessionsChangedEvent({ reason: "agent.input.settled", activeRunIds: [] });
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.state.pendingSubmit).toEqual(pending.pendingSubmit);
      expect(h.state.activityStatus).toBe(pending.activityStatus);
      expect(h.status).not.toHaveBeenCalledWith("idle");
    },
  );

  it.each([false, true])("flushes deferred history (stale streaming=%s)", (stale) => {
    const h = createHarness({
      activeChatRunId: "run-main",
      activityStatus: stale ? "streaming" : "idle",
    });
    h.noteLocalRunId("run-local-empty");
    if (stale) {
      h.loadHistory.mockImplementation(async () => {
        expect(h.state).toMatchObject({ activeChatRunId: null, activityStatus: "idle" });
        return { loaded: true, runOutcome: { state: "completed" } };
      });
    }
    h.chat("run-local-empty", { state: "final" });
    if (stale) {
      expect(h.state).toMatchObject({ activeChatRunId: null, activityStatus: "idle" });
      expect(h.status).toHaveBeenCalledWith("idle");
    } else {
      expect(h.state.activeChatRunId).toBe(h.runId);
      expect(h.loadHistory).not.toHaveBeenCalled();
      h.noteLocalRunId(h.runId);
      h.text(h.runId, "done", "final");
    }
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not surface inactive orphan final failures as the global status", () => {
    const h = createHarness({ activeChatRunId: "run-stale", activityStatus: "streaming" });
    h.chat("run-orphan-error", {
      state: "final",
      message: { content: [{ type: "text", text: "failed" }], stopReason: "error" },
    });
    expect(h.state.activeChatRunId).toBeNull();
    expect(h.status).toHaveBeenCalledWith("idle");
    expect(h.status).not.toHaveBeenCalledWith("error");
  });

  it("does not clear global streaming for inactive local /btw aborted or error events", () => {
    const h = createHarness({ activeChatRunId: null, activityStatus: "streaming" });
    for (const terminalState of ["aborted", "error"] as const) {
      const runId = `run-btw-${terminalState}`;
      h.state.activeChatRunId = null;
      h.state.activityStatus = "streaming";
      h.status.mockClear();
      h.noteLocalBtwRunId(runId);
      h.chat(runId, {
        state: terminalState,
        errorMessage: terminalState === "error" ? "boom" : undefined,
      });
      expect(h.state).toMatchObject({ activeChatRunId: null, activityStatus: "streaming" });
      expect(h.status).not.toHaveBeenCalled();
    }
  });

  it("suppresses non-local empty final placeholders during concurrent runs", () => {
    const h = createHarness({ activeChatRunId: "run-active" });
    h.handleChatEvent(contentEvent(h.runId, "local stream"));
    clearMocks(h.loadHistory, h.log.finalizeAssistant, h.log.dropAssistant);
    h.chat("run-other", { state: "final", message: { content: [] } });
    expect(h.log.finalizeAssistant).not.toHaveBeenCalledWith("(no output)", "run-other", []);
    expect(h.log.dropAssistant).toHaveBeenCalledWith("run-other");
    expect(h.loadHistory).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe(h.runId);
  });

  it("restores a terminal error when another run delays a history reload", async () => {
    const h = createHarness({ activeChatRunId: "run-error" });
    h.handleChatEvent(contentEvent("run-other", "still running"));
    h.noteLocalRunId("run-local-empty");
    h.chat("run-local-empty", { state: "final" });
    h.chat(h.runId, { state: "error", errorMessage: "provider exploded" });
    expect(h.state.activeChatRunId).toBe("run-other");
    expect(h.loadHistory).not.toHaveBeenCalled();
    h.text("run-other", "done", "final");
    await vi.waitFor(() => expect(h.log.addSystem).toHaveBeenCalledTimes(2));
    expect(h.loadHistory).toHaveBeenCalledTimes(1);
    expect(h.log.addSystem).toHaveBeenLastCalledWith("run error: provider exploded");
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
  ])("renders local $name diagnostics", ({ name, provider, error, expected }) => {
    const classify =
      name === "non-auth"
        ? vi.spyOn(failoverClassifier, "classifyFailoverReasonCore").mockImplementation(() => {
            throw new Error("provider classification must not block non-auth error rendering");
          })
        : undefined;
    try {
      const h = createHarness({
        localMode: true,
        activeChatRunId: name === "non-auth" ? "run-1" : null,
        sessionInfo: { modelProvider: provider },
      });
      h.chat("run-provider-error", { state: "error", errorMessage: error });
      expect(h.log.addSystem).toHaveBeenCalledWith(expected ?? `run error: ${error}`);
    } finally {
      classify?.mockRestore();
    }
  });

  it.each([
    { label: "owned local", localMode: true, owned: true, sessionKey: "agent:main:main" },
    { label: "unowned local", localMode: true, owned: false, sessionKey: "agent:main:main" },
    { label: "remote", localMode: false, owned: true, sessionKey: "agent:main:main" },
    { label: "foreign session", localMode: true, owned: true, sessionKey: "agent:main:other" },
  ])("unsequenced event ownership: $label", ({ localMode, owned, sessionKey }) => {
    const h = createHarness({
      localMode,
      activeChatRunId: null,
      sessionInfo: { modelProvider: "xai" },
    });
    h.agent("completed-run", { phase: "start" }, { sessionKey: h.state.currentSessionKey });
    h.text("completed-run", "done", "final");
    h.state.pendingSubmit = sendingSubmit("untrusted-run");
    if (owned) {
      h.noteLocalRunId("untrusted-run");
    }
    const accepted = localMode && owned && sessionKey === h.state.currentSessionKey;
    const errorMessage = accepted ? "monthly spending limit" : "foreign private diagnostic";
    h.chat("untrusted-run", { sessionKey, state: "error", errorMessage });
    if (accepted) {
      expect(h.state.pendingSubmit).toBeNull();
      expect(h.log.addSystem).toHaveBeenCalledWith("run error: monthly spending limit");
    } else {
      expect(h.state.pendingSubmit).toEqual(sendingSubmit("untrusted-run"));
      expect(h.log.addSystem).not.toHaveBeenCalledWith("run error: foreign private diagnostic");
    }
  });

  it("keeps and deduplicates distinct same-run finals with persisted identities", () => {
    const h = createHarness({ activeChatRunId: "run-message-tool" });
    const sourceReply = {
      ...textMessage("Tool reply"),
      __openclaw: { id: "message-tool-source-reply", seq: 7 },
    };
    const automaticReply = {
      ...textMessage("Final reply"),
      __openclaw: { id: "automatic-final-reply", seq: 8 },
    };
    h.chat(h.runId, { state: "final", message: sourceReply });
    h.chat(h.runId, { state: "final", message: automaticReply });
    h.chat(h.runId, { state: "final", message: automaticReply });
    expect(h.log.finalizeAssistant.mock.calls).toEqual([
      ["Tool reply", h.runId, []],
      ["Final reply", h.runId, []],
    ]);
    expect(h.state.activeChatRunId).toBeNull();
  });

  it("keeps a newer response streaming when a completed run fails afterward", () => {
    const h = createHarness({ activeChatRunId: "run-completed" });
    h.chat(h.runId, { state: "final", message: textMessage("Delivered once.") });
    h.handleChatEvent(contentEvent("run-newer", "Newer response"));
    h.status.mockClear();
    h.chat(h.runId, { state: "error", errorMessage: "  \t  " });
    const error: ChatEventOverrides = {
      runId: h.runId,
      state: "error",
      errorMessage: "  late provider failure  ",
    };
    h.handleChatEvent(error);
    h.handleChatEvent(error);
    expect(h.state.activeChatRunId).toBe("run-newer");
    expect(h.log.updateAssistant).toHaveBeenLastCalledWith("Newer response", "run-newer");
    expect(h.log.finalizeAssistant).toHaveBeenCalledExactlyOnceWith("Delivered once.", h.runId, []);
    expect(h.log.addSystem).toHaveBeenCalledExactlyOnceWith("run error: late provider failure");
    expect(h.status).not.toHaveBeenCalledWith("error");
    expect(h.status).not.toHaveBeenCalledWith("idle");
  });

  it("ignores an attachment final that arrives after the run was aborted", () => {
    const h = createHarness({ activeChatRunId: "run-abort-late-final" });
    const message = { role: "assistant", content: [{ type: "image", data: "secret-image" }] };
    h.chat(h.runId, { seq: 1, state: "aborted", errorMessage: "cancelled by user", message });
    h.chat(h.runId, { state: "aborted", errorMessage: "cancelled by user", message });
    h.chat(h.runId, { seq: 2, state: "final", message });
    expect(h.log.finalizeAssistant).not.toHaveBeenCalled();
    expect(h.log.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted: cancelled by user");
    expect(h.state.sessionProjection?.runs[h.runId]?.status).toBe("aborted");
  });

  it.each([
    ["aborted", "cancelled by user"],
    ["error", "provider failed"],
  ] as const)("renders recovered text after a message-less %s", (expectedStatus, errorMessage) => {
    const runId = `run-recovered-${expectedStatus}`;
    const h = createHarness({ activeChatRunId: runId });
    h.chat(runId, { seq: 1, state: expectedStatus, errorMessage });
    h.chat(runId, { seq: 2, state: "final", message: textMessage("Recovered reply.") });
    expect(h.log.finalizeAssistant).toHaveBeenCalledWith("Recovered reply.", runId, []);
    expect(h.state.sessionProjection?.runs[runId]?.status).toBe(expectedStatus);
  });

  it("ignores duplicate empty final envelopes after a run already finalized empty", () => {
    const h = createHarness({ activeChatRunId: "run-empty-replay", activityStatus: "streaming" });
    h.chat(h.runId, { state: "final" });
    clearMocks(h.log.dropAssistant, h.log.finalizeAssistant, h.loadHistory);
    h.chat(h.runId, { state: "final", message: { role: "assistant", content: [] } });
    expectUnused(h.log.dropAssistant, h.log.finalizeAssistant, h.loadHistory);
    expect(h.state.activityStatus).toBe("idle");
  });

  describe("session.message history reload", () => {
    it.each([
      ["session-1", "execution-run", "execution-run"],
      [null, undefined, "persisted-run"],
    ] as const)(
      "prefers persisted identity and binds initial session %s",
      (initialSessionId, executionRunId, expectedRunId) => {
        const h = createHarness({
          activeChatRunId: "run-existing",
          currentSessionId: initialSessionId,
        });
        h.handleSessionMessageEvent({
          ...(initialSessionId === null ? { sessionId: "first-persisted-session" } : {}),
          messageId: "envelope-user",
          clientRunId: "envelope-run",
          messageSeq: 99,
          message: {
            ...textMessage("Canonical cross-client prompt.", "user"),
            __openclaw: {
              id: "persisted-user",
              idempotencyKey: "persisted-run:user",
              seq: 7,
              ...(executionRunId ? { runId: executionRunId } : {}),
            },
          },
        });
        expect(h.log.addLiveUser).toHaveBeenCalledExactlyOnceWith(
          "Canonical cross-client prompt.",
          expect.objectContaining({
            messageId: "persisted-user",
            runId: expectedRunId,
            sendId: "persisted-run",
          }),
        );
        expect(h.state.sessionProjection?.entries).toHaveLength(1);
        expect(h.state.sessionProjection?.entries[0]?.identity).toMatchObject({
          id: "persisted-user",
          runId: expectedRunId,
          sequence: 7,
        });
        if (initialSessionId === null) {
          expect(h.state.sessionProjection?.scope.sessionId).toBe("first-persisted-session");
        }
      },
    );

    it.each([
      [7, 1],
      [null, 0],
    ] as const)("imported sequence: %s", (persistedSequence, expectedEntries) => {
      const h = createHarness();
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
      expect(h.log.addLiveUser).toHaveBeenCalledTimes(expectedEntries);
    });

    it.each([300, 100, undefined])("gates session replacement for timestamp %s", (updatedAt) => {
      const h = createHarness({
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
        expect(h.log.addLiveUser).not.toHaveBeenCalled();
        expect(h.state.sessionProjection?.entries ?? []).toHaveLength(0);
      }
    });

    it("reloads a global session only for its selected agent", () => {
      const h = createHarness({
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
      const h = createHarness({ activeChatRunId: "run-active" });
      h.handleSessionMessageEvent();
      h.handleSessionsChangedEvent({ runId: h.runId, phase: "end" });
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      h.text(h.runId, "keep this visible", "final");
      await nextEventLoopTurn();
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      expectCall(h.log.finalizeAssistant, ["keep this visible", h.runId, []], "once");
    });

    it("does not reload until an optimistic submit is resolved", () => {
      const h = createHarness({
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
    const changeSession = (
      h: ReturnType<typeof createHarness>,
      sessionId = h.state.currentSessionId,
    ) => {
      h.handleSessionsChangedEvent({
        reason: "new",
        sessionId: sessionId ?? undefined,
        updatedAt: 200,
      });
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
      const h = createHarness({ activeChatRunId: "run-active" });
      h.text(h.runId, "typing");
      clearMocks(h.log.finalizeAssistant, h.loadHistory);
      changeSession(h);
      expect(h.loadHistory).not.toHaveBeenCalled();
      h.text(h.runId, "reply", "final");
      expect(h.log.finalizeAssistant).toHaveBeenCalledTimes(1);
      h.handleSessionsChangedEvent({ phase: "end", runId: h.runId });
      await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(1));
      await vi.waitFor(() => expect(h.state.activeChatRunId).toBeNull());
      expect(h.state.activityStatus).toBe("idle");
      h.text(h.runId, "reply", "final");
      expect(h.log.finalizeAssistant).toHaveBeenCalledTimes(1);
    });

    it.each(["before", "after"] as const)("final %s failed history", async (arrival) => {
      const h = createHarness({ activeChatRunId: "run-active" });
      const resolveHistory = deferNextHistoryLoad(h.loadHistory);
      h.text(h.runId, "typing");
      h.log.finalizeAssistant.mockClear();
      changeSession(h);
      h.handleSessionsChangedEvent({ phase: "end", runId: h.runId });
      if (arrival === "before") {
        h.text(h.runId, "fallback reply", "final");
      }
      resolveHistory(false);
      if (arrival === "after") {
        await vi.waitFor(() => expect(h.state.activeChatRunId).toBeNull());
        expect(h.status).toHaveBeenCalledWith("idle");
        h.text(h.runId, "fallback reply", "final");
        expect(h.log.finalizeAssistant).toHaveBeenCalledWith("fallback reply", h.runId, []);
      } else {
        await vi.waitFor(() =>
          expect(h.log.finalizeAssistant).toHaveBeenCalledWith("fallback reply", h.runId, []),
        );
      }
    });

    it("keeps a later terminal reload queued behind the current rebuild", async () => {
      const h = createHarness({ activeChatRunId: "run-a" });
      const resolveFirstHistory = deferNextHistoryLoad(h.loadHistory);
      h.text(h.runId, "typing");
      h.text("run-b", "typing");
      changeSession(h);
      h.handleSessionsChangedEvent({ phase: "end", runId: h.runId });
      h.handleSessionsChangedEvent({ phase: "end", runId: "run-b" });
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      resolveFirstHistory(true);
      await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    });

    it("preserves immediate reload behavior when new replaces a known session", () => {
      const h = createHarness({
        activeChatRunId: "run-old",
        currentSessionId: "session-old",
        activityStatus: "streaming",
      });
      h.text(h.runId, "typing");
      h.loadHistory.mockClear();
      changeSession(h, "session-new");
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      expect(h.state).toMatchObject({ currentSessionId: "session-new", activeChatRunId: null });
      expect(h.status).toHaveBeenCalledWith("idle");
    });

    it("preserves displayed-run dedupe when reset history fails", async () => {
      const h = createHarness({ activeChatRunId: "run-reset" });
      const resolveHistory = deferNextHistoryLoad(h.loadHistory);
      h.text(h.runId, "done", "final");
      h.log.finalizeAssistant.mockClear();
      h.handleSessionsChangedEvent({
        reason: "reset",
        sessionId: h.state.currentSessionId ?? undefined,
      });
      resolveHistory(false);
      await Promise.resolve();
      h.text(h.runId, "done", "final");
      expect(h.log.finalizeAssistant).not.toHaveBeenCalled();
    });

    it("gates late run events while reset history is rebuilding", async () => {
      const h = createHarness({ activeChatRunId: "run-reset" });
      h.text(h.runId, "typing");
      clearMocks(h.log.finalizeAssistant, h.loadHistory);
      h.handleSessionsChangedEvent({
        reason: "reset",
        sessionId: h.state.currentSessionId ?? undefined,
      });
      h.text(h.runId, "stale after reset", "final");
      await vi.waitFor(() => expect(h.loadHistory).toHaveBeenCalledTimes(1));
      expect(h.log.finalizeAssistant).not.toHaveBeenCalled();
      expect(h.state.activeChatRunId).toBeNull();
    });
  });
});

describe("tui-event-handlers: streaming watchdog", () => {
  const expectedTimeoutMessage =
    "This response is taking longer than expected. Still waiting for the current run.";

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const createWatchdog = (streamingWatchdogMs: number) =>
    createHarness(
      { activeChatRunId: null, streamingWatchdogMs },
      vi.fn<() => Promise<TuiHistoryLoadResult>>(),
    );

  it("keeps the watchdog busy until authoritative idle ownership settles", () => {
    const h = createWatchdog(5_000);
    h.handleChatEvent(contentEvent("run-stuck", "hello"));
    expect(h.status).toHaveBeenLastCalledWith("streaming");
    expect(h.state.activeChatRunId).toBe("run-stuck");
    vi.advanceTimersByTime(5_001);
    expect(h.status).not.toHaveBeenCalledWith("idle");
    expect(h.state.activeChatRunId).toBe("run-stuck");
    expect(h.log.addPendingSystem).toHaveBeenCalledWith("run-stuck", expectedTimeoutMessage);
    h.handleSessionsChangedEvent({
      sessionKey: h.state.currentSessionKey,
      reason: "agent.input.settled",
      activeRunIds: [],
    });
    expect(h.state).toMatchObject({ activeChatRunId: null, activityStatus: "idle" });
    expect(h.log.dismissPendingSystem).toHaveBeenCalledWith("run-stuck");
    h.log.addPendingSystem.mockClear();
    vi.advanceTimersByTime(10_000);
    expect(h.log.addPendingSystem).not.toHaveBeenCalled();
  });

  it.each(["replacement", "queued refresh", "lifecycle end"] as const)(
    "recovers once after reconnect with %s",
    (recovery) => {
      const h = createWatchdog(5_000);
      h.handleChatEvent(contentEvent("run-reconnect", "hello"));
      if (recovery === "queued refresh") {
        h.noteLocalRunId("run-local-empty");
        h.handleChatEvent({ runId: "run-local-empty", state: "final" });
        vi.advanceTimersByTime(5_001);
        expect(h.state.activeChatRunId).toBe("run-reconnect");
        expect(h.status).not.toHaveBeenCalledWith("idle");
        expect(h.loadHistory).not.toHaveBeenCalled();
      }
      h.pauseStreamingWatchdog();
      if (recovery === "queued refresh") {
        vi.advanceTimersByTime(10_000);
        expect(h.state.activeChatRunId).toBe("run-reconnect");
        expect(h.loadHistory).not.toHaveBeenCalled();
      }
      h.reconnectStreamingWatchdog();
      expect(h.status).toHaveBeenLastCalledWith("streaming");
      if (recovery === "replacement") {
        h.state.activeChatRunId = "run-after-reconnect";
        h.reconnectStreamingWatchdog({ state: "active", runId: "run-after-reconnect" });
      } else if (recovery === "lifecycle end") {
        h.handleAgentEvent({ runId: "run-reconnect", data: { phase: "end" } });
      }
      vi.advanceTimersByTime(5_001);
      expect(h.state.activeChatRunId).toBeNull();
      expect(h.status).toHaveBeenLastCalledWith("idle");
      expect(h.loadHistory).toHaveBeenCalledTimes(1);
      if (recovery === "lifecycle end") {
        expect(h.log.addPendingSystem).not.toHaveBeenCalled();
      }
    },
  );

  it("is disabled when streamingWatchdogMs is 0", () => {
    const h = createWatchdog(0);
    h.handleChatEvent(contentEvent("run-no-watchdog", "hi"));
    vi.advanceTimersByTime(60_000);
    expect(h.status).not.toHaveBeenCalledWith("idle");
    expect(h.log.addPendingSystem).not.toHaveBeenCalled();
    expect(h.state.activeChatRunId).toBe("run-no-watchdog");
  });

  it.each(["delta", "final"] as const)("dismisses a watchdog notice on a late %s", (event) => {
    const h = createWatchdog(5_000);
    h.handleChatEvent(contentEvent("run-old", "old"));
    vi.advanceTimersByTime(5_001);
    expect(h.state.activeChatRunId).toBe("run-old");
    expect(h.log.addPendingSystem).toHaveBeenCalledWith("run-old", expectedTimeoutMessage);
    if (event === "delta") {
      h.handleChatEvent(contentEvent("run-new", "new"));
      expect(h.state.activeChatRunId).toBe("run-old");
      vi.advanceTimersByTime(3_000);
      h.handleChatEvent(contentEvent("run-old", "old again"));
      vi.advanceTimersByTime(2_001);
      expect(h.status).not.toHaveBeenCalledWith("idle");
      expect(h.state.activeChatRunId).toBe("run-old");
      expect(h.log.addPendingSystem).toHaveBeenCalledTimes(1);
    } else {
      h.handleChatEvent({
        runId: "run-old",
        state: "final",
        message: { content: [{ type: "text", text: "done" }], stopReason: "stop" },
      });
    }
    expect(h.log.dismissPendingSystem).toHaveBeenCalledWith("run-old");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
