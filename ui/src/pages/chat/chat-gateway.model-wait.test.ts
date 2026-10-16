// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it.each(["final", "aborted", "error"] as const)(
  "clears local model waits on %s after later calls",
  (terminal) => {
    const state = makeChatHost({
      sessionKey: "main",
      chatRunId: "run-1",
      chatStream: "",
      chatRunStartup: null,
    });
    const receive = (
      eventState: ChatEventPayload["state"],
      event: Omit<ChatEventPayload, "state" | "sessionKey">,
    ) =>
      handleChatGatewayEvent(state, {
        runId: "run-1",
        sessionKey: "main",
        state: eventState,
        ...event,
      });
    const label = () =>
      chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
    receive("status", { phase: "starting_model", seq: 1 });
    receive("status", { phase: "waiting_for_model", waitReason: "slot", seq: 2 });
    expect(label()).toBe("Waiting for a free model slot");
    receive("delta", { message: { role: "assistant", content: "First result" } });
    expect(label()).toBeUndefined();
    receive("status", { phase: "waiting_for_model", waitReason: "response", seq: 4 });
    expect(label()).toBe("Waiting for the local model to respond");
    receive("status", { phase: "waiting_for_model", waitReason: "slot", seq: 3 });
    expect(label()).toBe("Waiting for the local model to respond");
    receive("status", { phase: "starting_model", seq: 5 });
    expect(label()).toBe("Waiting for a response");
    receive("status", { phase: "waiting_for_model", waitReason: "slot", seq: 6 });
    receive(terminal, { message: { role: "assistant", content: "Done" } });
    expect(state.chatRunStartup).toBeNull();
  },
);
