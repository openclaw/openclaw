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
