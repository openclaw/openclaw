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

type RecoveryKind = "retrying" | "fallback";
const recoveryEvent = (
  kind: RecoveryKind,
  retry: { message: string; retryAt?: number } = {
    message: "Rate limited. Retrying in 4 seconds (attempt 3/8).",
    retryAt: 40_000,
  },
) =>
  kind === "retrying"
    ? event(2, "run_status", {
        phase: "retrying",
        ...retry,
      })
    : event(2, "lifecycle", {
        phase: "fallback_step",
        fallbackStepToModel: "example/fallback",
        fallbackStepFinalOutcome: "next_fallback",
      });
const label = (state: ReturnType<typeof createState>) =>
  chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
const text = (state: ReturnType<typeof createState>) =>
  materializeVisibleAssistantStreamMessages(state.chatMessages, state).map(extractText);
const expectedLabel = (kind: RecoveryKind) =>
  kind === "retrying" ? "Retrying…" : "Trying fallback model…";

it.each(["retrying", "fallback"] as const)(
  "reconciles %s waits after live progress",
  async (kind) => {
    const history = activeHistory("run-live");
    history.inFlightRun!.text = "I finished the first step.";
    const retry = recoveryEvent(kind);
    history.inFlightRun!.events = [
      event(1, "tool", { phase: "result", toolCallId: "read-1", name: "read", result: "done" }),
      retry,
    ];
    const state = createState(history);
    await loadChatHistory(state);
    expect(label(state)).toBe(expectedLabel(kind));
    expect(state.chatRunId).toBe("run-live");
    expect(text(state)).toEqual(["I finished the first step."]);
    await loadChatHistory(state);
    expect(label(state)).toBe(expectedLabel(kind));
    expect(text(state)).toEqual(["I finished the first step."]);
    const progress = event(3, "assistant", { text: "Continuing" });
    handleAgentEvent(state, progress);
    await loadChatHistory(state);
    expect(label(state)).toBeUndefined();
    handleAgentEvent(state, { ...retry, seq: 4 });
    await loadChatHistory(state);
    expect(label(state)).toBe(expectedLabel(kind));
    handleChatGatewayEvent(state, {
      runId: "run-live",
      sessionKey: "main",
      state: "final",
      message: { role: "assistant", content: "Finished" },
    });
    expect(state.chatRunId).toBeNull();
    expect(label(state)).toBeUndefined();
  },
);

it.each(["retrying", "fallback"] as const)(
  "clears %s after reconnect replays compact assistant progress",
  async (kind) => {
    const history = activeHistory("run-live");
    const recovery = recoveryEvent(kind, { message: "Retrying the request." });
    const snapshot = updateChatRunProgressSnapshot(
      updateChatRunProgressSnapshot(undefined, recovery),
      event(3, "assistant", { text: "The resumed answer." }),
    );
    expect(snapshot?.events).toEqual([event(3, "assistant", {})]);
    const state = createState(history);
    state.chatRunId = "run-live";
    handleAgentEvent(state, recovery);
    expect(label(state)).toBe(expectedLabel(kind));

    state.connectionEpoch += 1;
    history.inFlightRun!.text = "The resumed answer.";
    history.inFlightRun!.events = snapshot!.events;
    await loadChatHistory(state);
    expect(label(state)).toBeUndefined();
    expect(text(state)).toEqual(["The resumed answer."]);

    // A delayed snapshot cannot clear a recovery that started after its assistant frame.
    handleAgentEvent(state, { ...recovery, seq: 4 });
    await loadChatHistory(state);
    expect(label(state)).toBe(expectedLabel(kind));
  },
);
