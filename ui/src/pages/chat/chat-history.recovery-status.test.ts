// @vitest-environment node
import { expect, it } from "vitest";
import { updateChatRunProgressSnapshot } from "../../../../src/gateway/server-chat-progress-snapshot.js";
import { extractText } from "../../lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { materializeVisibleAssistantStreamMessages } from "./chat-history-stream.ts";
import { activeHistory, createState, event } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { handleAgentEvent } from "./tool-stream.ts";

it.each(["retrying", "fallback"] as const)(
  "reconciles %s waits after live progress",
  async (kind) => {
    const history = activeHistory("run-live");
    history.inFlightRun!.text = "I finished the first step.";
    const retry =
      kind === "retrying"
        ? event(2, "run_status", {
            phase: "retrying",
            message: "Rate limited. Retrying in 4 seconds (attempt 3/8).",
            retryAt: 40_000,
          })
        : event(2, "lifecycle", {
            phase: "fallback_step",
            fallbackStepToModel: "example/fallback",
            fallbackStepFinalOutcome: "next_fallback",
          });
    const expectedLabel = kind === "retrying" ? "Retrying…" : "Trying fallback model…";
    history.inFlightRun!.events = [
      event(1, "tool", { phase: "result", toolCallId: "read-1", name: "read", result: "done" }),
      retry,
    ];
    const state = createState(history);
    const label = () =>
      chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
    const text = () =>
      materializeVisibleAssistantStreamMessages(state.chatMessages, state).map(extractText);
    await loadChatHistory(state);
    expect(label()).toBe(expectedLabel);
    expect(state.chatRunId).toBe("run-live");
    expect(text()).toEqual(["I finished the first step."]);
    await loadChatHistory(state);
    expect(label()).toBe(expectedLabel);
    expect(text()).toEqual(["I finished the first step."]);
    const progress = event(3, "assistant", { text: "Continuing" });
    handleAgentEvent(state, progress);
    await loadChatHistory(state);
    expect(label()).toBeUndefined();
    handleAgentEvent(state, { ...retry, seq: 4 });
    await loadChatHistory(state);
    expect(label()).toBe(expectedLabel);
    handleChatGatewayEvent(state, {
      runId: "run-live",
      sessionKey: "main",
      state: "final",
      message: { role: "assistant", content: "Finished" },
    });
    expect(state.chatRunId).toBeNull();
    expect(label()).toBeUndefined();
  },
);

it.each(["retrying", "fallback"] as const)(
  "clears %s after reconnect replays compact assistant progress",
  async (kind) => {
    const history = activeHistory("run-live");
    const recovery =
      kind === "retrying"
        ? event(2, "run_status", { phase: "retrying", message: "Retrying the request." })
        : event(2, "lifecycle", {
            phase: "fallback_step",
            fallbackStepToModel: "example/fallback",
            fallbackStepFinalOutcome: "next_fallback",
          });
    const snapshot = updateChatRunProgressSnapshot(
      updateChatRunProgressSnapshot(undefined, recovery),
      event(3, "assistant", { text: "The resumed answer." }),
    );
    expect(snapshot?.events).toEqual([event(3, "assistant", {})]);
    const state = createState(history);
    state.chatRunId = "run-live";
    handleAgentEvent(state, recovery);
    const expectedLabel = kind === "retrying" ? "Retrying…" : "Trying fallback model…";
    expect(chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null)).toBe(
      expectedLabel,
    );

    state.connectionEpoch += 1;
    history.inFlightRun!.text = "The resumed answer.";
    history.inFlightRun!.events = snapshot!.events;
    await loadChatHistory(state);
    expect(
      chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null),
    ).toBeUndefined();
    expect(
      materializeVisibleAssistantStreamMessages(state.chatMessages, state).map(extractText),
    ).toEqual(["The resumed answer."]);

    // A delayed snapshot cannot clear a recovery that started after its assistant frame.
    handleAgentEvent(state, { ...recovery, seq: 4 });
    await loadChatHistory(state);
    expect(chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null)).toBe(
      expectedLabel,
    );
  },
);
