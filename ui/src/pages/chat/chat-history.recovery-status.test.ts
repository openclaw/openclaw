// @vitest-environment node
import { expect, it } from "vitest";
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
