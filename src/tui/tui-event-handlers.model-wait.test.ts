import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createEventHandlers } from "./tui-event-handlers.js";
import {
  createMockBtwPresenter,
  createMockChatLog,
  makeTuiState,
} from "./tui-event-test-support.js";
import type { ChatEvent } from "./tui-types.js";

afterEach(() => vi.useRealTimers());
const cancellationNotice = "Cancellation requested; the local model may still be finishing.";

function createHarness(modelWait = false, sideQuestion = false) {
  vi.useFakeTimers();
  const state = makeTuiState({
    activeChatRunId: "run-1",
    ...(modelWait ? { sessionInfo: { verboseLevel: "off" } } : {}),
  });
  const setActivityStatus = vi.fn((status: string) => {
    if (!modelWait) {
      state.activityStatus = status;
    }
  });
  const chatLog = createMockChatLog();
  const handlers = createEventHandlers({
    state,
    setActivityStatus,
    chatLog,
    btw: createMockBtwPresenter(),
    tui: { requestRender: vi.fn() },
    updateFooter: vi.fn(),
    loadHistory: async () =>
      modelWait ? { loaded: true, runOutcome: { state: "completed" } } : { loaded: false },
    isLocalBtwRunId: sideQuestion ? (id) => id === "side-run" : undefined,
  });
  onTestFinished(handlers.dispose);
  const chat = (event: Omit<ChatEvent, "runId" | "sessionKey"> & { runId?: string }) =>
    handlers.handleChatEvent({ runId: "run-1", sessionKey: state.currentSessionKey, ...event });
  const abort = () => chat({ state: "aborted", localModelMayStillBeFinishing: true });
  const status = (phase: string, reason?: "slot" | "response") =>
    handlers.handleAgentEvent({ runId: "run-1", stream: "run_status", data: { phase, reason } });
  const expectStatus = (value: string) => expect(setActivityStatus).toHaveBeenLastCalledWith(value);
  return { state, setActivityStatus, chatLog, handlers, chat, abort, status, expectStatus };
}

it("renders local model waits with verbosity off and clears each wait", () => {
  const h = createHarness(true);
  h.status("waiting_for_model", "slot");
  h.expectStatus("Waiting for a free model slot");
  h.status("starting_model");
  h.expectStatus("running");
  h.status("waiting_for_model", "response");
  h.expectStatus("Waiting for the local model to respond");
  h.chat({ state: "delta", message: { role: "assistant", content: "First response" } });
  h.expectStatus("streaming");
  h.status("waiting_for_model", "slot");
  h.chat({ state: "aborted" });
  h.expectStatus("aborted");
});

it.each(["replayed abort", "side question", "session idle"] as const)(
  "preserves the cancellation caveat and its deadline through %s",
  (event) => {
    const h = createHarness(false, event === "side question");
    h.abort();
    expect(h.state.activeChatRunId).toBeNull();
    h.expectStatus(cancellationNotice);
    expect(h.chatLog.addSystem).toHaveBeenCalledExactlyOnceWith("run aborted");
    const elapsed = event === "session idle" ? 0 : 4_000;
    vi.advanceTimersByTime(elapsed);
    if (event === "replayed abort") {
      h.abort();
    } else if (event === "side question") {
      h.chat({ runId: "side-run", state: "final" });
    } else {
      h.status("starting_model");
      h.handlers.handleAgentEvent({
        runId: "run-1",
        stream: "lifecycle",
        data: { phase: "end", status: "cancelled", aborted: true },
      });
      h.handlers.handleSessionsChangedEvent({
        sessionKey: h.state.currentSessionKey,
        sessionId: h.state.currentSessionId,
        reason: "agent.input.settled",
        activeRunIds: [],
      });
    }
    h.expectStatus(cancellationNotice);
    expect(h.state.activityStatus).toBe(cancellationNotice);
    vi.advanceTimersByTime(5_000 - elapsed);
    h.expectStatus("aborted");
    expect(h.state.activityStatus).toBe("aborted");
  },
);

it.each(["new run", "pending run", "session change", "dispose"] as const)(
  "clears the cancellation notice on %s without overwriting later activity",
  (change) => {
    const h = createHarness();
    h.abort();
    if (change === "new run") {
      h.chat({
        runId: "run-2",
        state: "delta",
        message: { role: "assistant", content: "New answer" },
      });
    } else if (change === "pending run") {
      h.state.pendingSubmit = { phase: "sending", runId: "run-2", draftText: "Next question" };
      h.setActivityStatus("sending");
    } else if (change === "session change") {
      h.state.currentSessionKey = "agent:main:other";
      h.handlers.handleChatEvent({ runId: "other", sessionKey: "old-session", state: "aborted" });
    } else {
      h.handlers.dispose();
    }
    h.expectStatus(
      change === "new run" ? "streaming" : change === "pending run" ? "sending" : "idle",
    );
    h.setActivityStatus.mockClear();
    vi.advanceTimersByTime(5_000);
    expect(h.setActivityStatus).not.toHaveBeenCalled();
  },
);
