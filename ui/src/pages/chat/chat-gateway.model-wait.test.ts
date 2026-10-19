// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleChatGatewayEvent, type ChatEventPayload } from "./chat-gateway.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { activeChatRunStartupStatus, chatStartupStatusLabel } from "./chat-run-startup.ts";
import { adoptStartedChatRun, reconcileChatRunLifecycle } from "./run-lifecycle.ts";

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
    expect(state.chatRunStatus?.localModelMayStillBeFinishing).toBeUndefined();
  },
);

it("keeps a local cancellation caveat terminal, bounded, and unchanged by replay", () => {
  const state = makeChatHost({
    sessionKey: "main",
    chatRunId: "run-1",
    chatStream: "",
    chatRunStartup: null,
  });
  const aborted: ChatEventPayload = {
    runId: "run-1",
    sessionKey: "main",
    state: "aborted",
    localModelMayStillBeFinishing: true,
  };

  handleChatGatewayEvent(state, aborted);
  expect(state.chatRunId).toBeNull();
  expect(state.chatRunStartup).toBeNull();
  expect(state.chatRunStatus).toMatchObject({
    phase: "interrupted",
    localModelMayStillBeFinishing: true,
  });
  const terminal = state.chatRunStatus;
  vi.advanceTimersByTime(4_000);
  handleChatGatewayEvent(state, aborted);
  expect(state.chatRunStatus).toBe(terminal);
  vi.advanceTimersByTime(1_000);
  expect(state.chatRunStatus).toBeNull();
  handleChatGatewayEvent(state, aborted);
  expect(state.chatRunStatus).toBeNull();

  adoptStartedChatRun(state, "run-2", Date.now());
  handleChatGatewayEvent(state, aborted);
  expect(state.chatRunId).toBe("run-2");
  expect(state.chatRunStatus).toBeNull();
});

it("clears the cancellation caveat when another run starts or the pane resets", () => {
  for (const reset of [
    (state: ReturnType<typeof makeChatHost>) => adoptStartedChatRun(state, "run-2", Date.now()),
    (state: ReturnType<typeof makeChatHost>) =>
      reconcileChatRunLifecycle(state, { clearRunStatus: true }),
  ]) {
    const state = makeChatHost({ sessionKey: "main", chatRunId: "run-1", chatStream: "" });
    handleChatGatewayEvent(state, {
      runId: "run-1",
      sessionKey: "main",
      state: "aborted",
      localModelMayStillBeFinishing: true,
    });
    reset(state);
    expect(state.chatRunStatus).toBeNull();
    expect(state.chatRunStatusClearTimer).toBeNull();
  }
});
