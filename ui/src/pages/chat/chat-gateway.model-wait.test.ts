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

function fixture() {
  const host = makeChatHost({
    sessionKey: "main",
    chatRunId: "run-1",
    chatStream: "",
    chatRunStartup: null,
  });
  const receive = (
    state: ChatEventPayload["state"],
    event: Omit<ChatEventPayload, "state" | "sessionKey" | "runId"> = {},
  ) => handleChatGatewayEvent(host, { runId: "run-1", sessionKey: "main", state, ...event });
  return { state: host, receive };
}

it.each(["final", "aborted", "error"] as const)("clears later model waits on %s", (terminal) => {
  const { state, receive } = fixture();
  const label = () =>
    chatStartupStatusLabel(activeChatRunStartupStatus(state.chatRunStartup), null);
  receive("status", { phase: "preparing_worktree_base", seq: 0 });
  expect(label()).toBe("Updating repository…");
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
});

it("keeps a local cancellation caveat terminal, bounded, and unchanged by replay", () => {
  const { state, receive } = fixture();
  const abort = () => receive("aborted", { localModelMayStillBeFinishing: true });

  abort();
  expect(state).toMatchObject({ chatRunId: null, chatRunStartup: null });
  expect(state.chatRunStatus).toMatchObject({
    phase: "interrupted",
    localModelMayStillBeFinishing: true,
  });
  const terminal = state.chatRunStatus;
  vi.advanceTimersByTime(4_000);
  abort();
  expect(state.chatRunStatus).toBe(terminal);
  vi.advanceTimersByTime(1_000);
  expect(state.chatRunStatus).toBeNull();
  abort();
  expect(state.chatRunStatus).toBeNull();

  adoptStartedChatRun(state, "run-2", Date.now());
  abort();
  expect(state).toMatchObject({ chatRunId: "run-2", chatRunStatus: null });
});

it("clears the cancellation caveat when another run starts or the pane resets", () => {
  for (const reset of [
    (state: ReturnType<typeof makeChatHost>) => adoptStartedChatRun(state, "run-2", Date.now()),
    (state: ReturnType<typeof makeChatHost>) =>
      reconcileChatRunLifecycle(state, { clearRunStatus: true }),
  ]) {
    const { state, receive } = fixture();
    receive("aborted", { localModelMayStillBeFinishing: true });
    reset(state);
    expect(state).toMatchObject({ chatRunStatus: null, chatRunStatusClearTimer: null });
  }
});
