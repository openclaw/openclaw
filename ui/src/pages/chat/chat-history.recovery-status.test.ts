// @vitest-environment node
import { expect, it, vi } from "vitest";
import { updateChatRunProgressSnapshot } from "../../../../src/gateway/server-chat-progress-snapshot.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { materializeVisibleAssistantStreamMessages } from "./chat-history-stream.ts";
import { activeHistory, createState, emit, event } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { handleAgentEvent } from "./tool-stream.ts";

it("restores active recovery compaction from Gateway history after reconnect", async () => {
  vi.stubGlobal("window", globalThis);
  vi.useFakeTimers();
  try {
    const history = activeHistory("run-live");
    const state = createState(history);
    const snapshot = updateChatRunProgressSnapshot(
      updateChatRunProgressSnapshot(
        undefined,
        event(1, "lifecycle", { phase: "finishing", error: "Context overflow" }),
        "summary",
      ),
      event(2, "compaction", { phase: "start", itemId: "recovery" }),
      "summary",
    );
    history.inFlightRun!.events = snapshot?.events;
    await loadChatHistory(state);
    expect(state.compactionStatus).toMatchObject({
      phase: "active",
      runId: "run-live",
      itemId: "recovery",
    });
    expect(state.chatRunId).toBe("run-live");

    history.inFlightRun!.events = updateChatRunProgressSnapshot(
      snapshot,
      event(3, "compaction", { phase: "end", itemId: "recovery", completed: true }),
      "summary",
    )?.events;
    await loadChatHistory(state);
    expect(state.compactionStatus?.phase).toBe("complete");
    expect(state.chatRunId).toBe("run-live");
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

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

it("keeps the current model wait when compact history omits its replay events", async () => {
  const state = createState(activeHistory("run-live"));
  await loadChatHistory(state);
  handleAgentEvent(state, event(1, "lifecycle", { phase: "start" }));
  handleAgentEvent(state, event(2, "run_status", { phase: "waiting_for_model", reason: "slot" }));

  await loadChatHistory(state);

  expect(chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null)).toBe(
    "Waiting for a free model slot",
  );
});
