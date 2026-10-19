import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  createMockBtwPresenter,
  createMockChatLog,
  makeTuiState,
} from "./tui-event-test-support.js";

afterEach(() => vi.useRealTimers());

it("renders local model waits with verbosity off and clears each wait", () => {
  vi.useFakeTimers();
  const state = makeTuiState({ activeChatRunId: "run-1", sessionInfo: { verboseLevel: "off" } });
  const setActivityStatus = vi.fn();
  const handlers = createEventHandlers({
    state,
    setActivityStatus,
    chatLog: createMockChatLog(),
    btw: createMockBtwPresenter(),
    tui: { requestRender: vi.fn() },
    updateFooter: vi.fn(),
    loadHistory: async () => ({ loaded: true, runOutcome: { state: "completed" } }),
  });
  onTestFinished(handlers.dispose);
  const status = (phase: string, reason?: "slot" | "response") =>
    handlers.handleAgentEvent({
      runId: "run-1",
      stream: "run_status",
      data: { phase, reason },
    });
  status("waiting_for_model", "slot");
  expect(setActivityStatus).toHaveBeenLastCalledWith("Waiting for a free model slot");
  status("starting_model");
  expect(setActivityStatus).toHaveBeenLastCalledWith("running");
  status("waiting_for_model", "response");
  expect(setActivityStatus).toHaveBeenLastCalledWith("Waiting for the local model to respond");
  handlers.handleChatEvent({
    runId: "run-1",
    sessionKey: state.currentSessionKey,
    state: "delta",
    message: { role: "assistant", content: "First response" },
  });
  expect(setActivityStatus).toHaveBeenLastCalledWith("streaming");
  status("waiting_for_model", "slot");
  handlers.handleChatEvent({
    runId: "run-1",
    sessionKey: state.currentSessionKey,
    state: "aborted",
  });
  expect(setActivityStatus).toHaveBeenLastCalledWith("aborted");
});

function createCancellationHarness(isLocalBtwRunId?: (runId: string) => boolean) {
  vi.useFakeTimers();
  const state = makeTuiState({ activeChatRunId: "run-1" });
  const setActivityStatus = vi.fn((status: string) => {
    state.activityStatus = status;
  });
  const chatLog = createMockChatLog();
  const handlers = createEventHandlers({
    state,
    setActivityStatus,
    chatLog,
    btw: createMockBtwPresenter(),
    tui: { requestRender: vi.fn() },
    updateFooter: vi.fn(),
    loadHistory: async () => ({ loaded: false }),
    isLocalBtwRunId,
  });
  onTestFinished(handlers.dispose);
  const aborted = {
    runId: "run-1",
    sessionKey: state.currentSessionKey,
    state: "aborted",
    localModelMayStillBeFinishing: true,
  };
  return { state, setActivityStatus, chatLog, handlers, aborted };
}

it("bounds the terminal cancellation caveat without rearming it on replay", () => {
  const { state, setActivityStatus, chatLog, handlers, aborted } = createCancellationHarness();
  handlers.handleChatEvent(aborted);
  expect(state.activeChatRunId).toBeNull();
  expect(setActivityStatus).toHaveBeenLastCalledWith(
    "Cancellation requested; the local model may still be finishing.",
  );
  expect(chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
  vi.advanceTimersByTime(4_000);
  handlers.handleChatEvent(aborted);
  vi.advanceTimersByTime(1_000);
  expect(setActivityStatus).toHaveBeenLastCalledWith("aborted");
});

it("preserves the cancellation caveat while a surviving side question completes", () => {
  const { state, handlers, aborted } = createCancellationHarness((runId) => runId === "side-run");
  handlers.handleChatEvent(aborted);
  vi.advanceTimersByTime(4_000);
  handlers.handleChatEvent({
    runId: "side-run",
    sessionKey: state.currentSessionKey,
    state: "final",
  });
  expect(state.activityStatus).toBe(
    "Cancellation requested; the local model may still be finishing.",
  );
  vi.advanceTimersByTime(1_000);
  expect(state.activityStatus).toBe("aborted");
});

it("preserves the terminal caveat when the cancelled session reports idle", () => {
  const { state, setActivityStatus, handlers, aborted } = createCancellationHarness();
  handlers.handleChatEvent(aborted);
  handlers.handleAgentEvent({
    runId: aborted.runId,
    stream: "run_status",
    data: { phase: "starting_model" },
  });
  handlers.handleAgentEvent({
    runId: aborted.runId,
    stream: "lifecycle",
    data: { phase: "end", status: "cancelled", aborted: true },
  });
  handlers.handleSessionsChangedEvent({
    sessionKey: state.currentSessionKey,
    sessionId: state.currentSessionId,
    reason: "agent.input.settled",
    activeRunIds: [],
  });
  expect(setActivityStatus).toHaveBeenLastCalledWith(
    "Cancellation requested; the local model may still be finishing.",
  );
  expect(state.activityStatus).toBe(
    "Cancellation requested; the local model may still be finishing.",
  );
  vi.advanceTimersByTime(5_000);
  expect(setActivityStatus).toHaveBeenLastCalledWith("aborted");
});

it.each(["new run", "pending run", "session change", "dispose"] as const)(
  "clears the cancellation notice on %s without overwriting later activity",
  (change) => {
    const { state, setActivityStatus, handlers, aborted } = createCancellationHarness();
    handlers.handleChatEvent(aborted);
    if (change === "new run") {
      handlers.handleChatEvent({
        runId: "run-2",
        sessionKey: state.currentSessionKey,
        state: "delta",
        message: { role: "assistant", content: "New answer" },
      });
    } else if (change === "pending run") {
      state.pendingSubmit = { phase: "sending", runId: "run-2", draftText: "Next question" };
      setActivityStatus("sending");
    } else if (change === "session change") {
      state.currentSessionKey = "agent:main:other";
      handlers.handleChatEvent({ runId: "other", sessionKey: "old-session", state: "aborted" });
    } else {
      handlers.dispose();
    }
    const expected =
      change === "new run" ? "streaming" : change === "pending run" ? "sending" : "idle";
    expect(setActivityStatus).toHaveBeenLastCalledWith(expected);
    setActivityStatus.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(setActivityStatus).not.toHaveBeenCalled();
  },
);
