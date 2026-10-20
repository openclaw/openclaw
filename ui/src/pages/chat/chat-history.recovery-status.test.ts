// @vitest-environment node
import { expect, it } from "vitest";
import { updateChatRunProgressSnapshot } from "../../../../src/gateway/server-chat-progress-snapshot.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { materializeVisibleAssistantStreamMessages } from "./chat-history-stream.ts";
import { activeHistory, createState, emit, event } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { handleAgentEvent } from "./tool-stream.ts";

it.each([
  ["retrying", false],
  ["fallback", false],
  ["retrying", true],
  ["fallback", true],
] as const)("reconciles %s recovery (reconnect: %s)", async (kind, reconnect) => {
  const history = activeHistory("run-live");
  const recovery =
    kind === "retrying"
      ? event(2, "run_status", {
          phase: "retrying",
          message: "Retrying the request.",
          ...(reconnect ? {} : { retryAt: 40_000 }),
        })
      : event(2, "lifecycle", {
          phase: "fallback_step",
          fallbackStepToModel: "example/fallback",
          fallbackStepFinalOutcome: "next_fallback",
        });
  const expectedLabel = kind === "retrying" ? "Retrying…" : "Trying fallback model…";
  const state = createState(history);
  const label = () =>
    chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
  const text = () =>
    materializeVisibleAssistantStreamMessages(state.chatMessages, state).map(extractText);
  if (reconnect) {
    const snapshot = updateChatRunProgressSnapshot(
      updateChatRunProgressSnapshot(undefined, recovery),
      event(3, "assistant", { text: "The resumed answer." }),
    );
    expect(snapshot?.events).toEqual([event(3, "assistant", {})]);
    state.chatRunId = "run-live";
    handleAgentEvent(state, recovery);
    expect(label()).toBe(expectedLabel);
    state.connectionEpoch += 1;
    history.inFlightRun!.text = "The resumed answer.";
    history.inFlightRun!.events = snapshot!.events;
  } else {
    history.inFlightRun!.text = "I finished the first step.";
    history.inFlightRun!.events = [
      event(1, "tool", { phase: "result", toolCallId: "read-1", name: "read", result: "done" }),
      recovery,
    ];
    for (let read = 0; read < 2; read++) {
      await loadChatHistory(state);
      expect(label()).toBe(expectedLabel);
      expect(state.chatRunId).toBe("run-live");
      expect(text()).toEqual(["I finished the first step."]);
    }
    handleAgentEvent(state, event(3, "assistant", { text: "Continuing" }));
  }
  await loadChatHistory(state);
  expect(label()).toBeUndefined();
  if (reconnect) {
    expect(text()).toEqual(["The resumed answer."]);
  }
  // Older assistant snapshots cannot clear a recovery with a newer agent sequence.
  handleAgentEvent(state, { ...recovery, seq: 4 });
  await loadChatHistory(state);
  expect(label()).toBe(expectedLabel);
  if (!reconnect) {
    emit(state, "run-live", {
      state: "final",
      message: { role: "assistant", content: "Finished" },
    });
    expect(state.chatRunId).toBeNull();
    expect(label()).toBeUndefined();
  }
});
