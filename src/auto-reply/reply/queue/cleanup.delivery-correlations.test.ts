import { expect, it, vi } from "vitest";
import { captureSessionControllerSourceSettlement as settleSource } from "../../../sessions/session-controller.mailbox.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../../sessions/session-controller.stop.js";
import { installQueueRuntimeErrorSilencer } from "../queue.test-helpers.js";
import { clearSessionQueues } from "./cleanup.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { queueFixture } from "./lifecycle.test-support.js";

installQueueRuntimeErrorSilencer();
const failed = { visibleReplySent: false, failed: true };
const delivered = { visibleReplySent: true, failed: false, completed: true };
const queue = queueFixture("collect");

function source(prompt = "source", cap: number | false = 50) {
  const run = queue.source(prompt);
  const end = vi.fn();
  const begin = vi.fn(() => end);
  run.deliveryCorrelations = [{ begin }];
  if (cap !== false) {
    queue.settings.cap = cap;
    queue.enqueue(run, false, "none");
  }
  return { run, begin, end };
}
function expectOutcomes({ begin, end }: ReturnType<typeof source>, outcomes: readonly unknown[]) {
  expect(begin).toHaveBeenCalledTimes(outcomes.length);
  expect(end.mock.calls).toEqual(outcomes.map((outcome) => [outcome]));
}

it.each(["clear", "stop"] as const)("settles %s captures once", async (boundary) => {
  const sources = Array.from({ length: 6 }, (_, index) => source(String(index), 2));
  sources[0]!.end.mockImplementation(() => {
    throw new Error("reaction transport unavailable");
  });
  const inputs = [0, 2, 4].map((index) => sources[index]!.run.controllerInput!);
  const clear = async () => {
    if (boundary === "clear") {
      clearSessionQueues([queue.key], undefined, inputs);
      return undefined;
    }
    const result = await stopSession({
      source: "restart",
      capture: captureSessionControllerStop({ inputs }),
    }).completed;
    await result.settled;
    return result.queuedCancelled;
  };
  expect(await clear()).toBe(boundary === "stop" ? 3 : undefined);
  await Promise.all(inputs.map(settleSource));
  expect(await clear()).toBe(boundary === "stop" ? 0 : undefined);
  for (const [index, sample] of sources.entries()) {
    expectOutcomes(sample, index % 2 === 0 ? [failed] : []);
  }
});

it.each([
  ["final", [delivered]],
  ["retry", [undefined, failed]],
  ["source-owned", [undefined]],
  [true, []],
  [false, []],
] as const)("preserves %s retirement outcome", async (outcome, expected) => {
  const sample = source("source", false);
  const { run } = sample;
  if (typeof outcome === "boolean") {
    queue.settings.mode = "steer";
    const reservation = await queue.admit(run);
    reservation.accepted(outcome);
    reservation.consume("consumed");
  } else {
    queue.enqueue(run, false, "none");
    const finish = run.deliveryCorrelations?.[0]?.begin();
    if (typeof finish !== "function") {
      throw new Error("Expected correlation settlement callback");
    }
    finish(outcome === "final" ? delivered : undefined);
    if (outcome === "source-owned") {
      completeFollowupRunLifecycle(run, "consumed");
    } else {
      queue.clear(run);
    }
  }
  await queue.settle(run);
  if (typeof outcome === "boolean") {
    clearSessionQueues([queue.key]);
  }
  expectOutcomes(sample, expected);
});

it("retains abandonment through asynchronous cleanup and a later consumed completion", async () => {
  const sample = source("async source", false);
  const { run, begin } = sample;
  const release = queue.gate();
  run.turnAdoptionLifecycle = { onAdopted: () => {}, onAbandoned: release.wait };
  queue.enqueue(run, false, "none");
  try {
    queue.clear(run);
    await release.entered;
    completeFollowupRunLifecycle(run, "consumed");
    queue.clear(run);
    expect(begin).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await queue.settle(run);
  }
  expectOutcomes(sample, [failed]);
});
