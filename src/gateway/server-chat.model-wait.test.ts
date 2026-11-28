import { expect, it, onTestFinished } from "vitest";
import { createAgentEventTestHarness } from "./server-chat.agent-events.test-harness.js";

it("projects request-correlated model waits and clears across model calls", async () => {
  const h = createAgentEventTestHarness();
  onTestFinished(async () => {
    await h.handler.dispose();
    h.chatRunState.clear();
  });
  h.registerNamed("wait");
  await h.emit(
    "run-wait",
    "run_status",
    { phase: "waiting_for_model", reason: "slot" },
    { seq: 1 },
  );
  await h.emit("run-wait", "assistant", { text: "First", delta: "First" }, { seq: 2 });
  await h.emit(
    "run-wait",
    "run_status",
    { phase: "waiting_for_model", reason: "response" },
    { seq: 3 },
  );
  await h.emit("run-wait", "run_status", { phase: "starting_model" }, { seq: 4 });
  expect(
    h
      .chat()
      .map(([, payload]) => payload)
      .filter((payload) => payload.state === "status"),
  ).toMatchObject([
    { runId: "client-wait", phase: "waiting_for_model", waitReason: "slot", seq: 1 },
    { runId: "client-wait", phase: "waiting_for_model", waitReason: "response", seq: 3 },
    { runId: "client-wait", phase: "starting_model", seq: 4 },
  ]);
});
