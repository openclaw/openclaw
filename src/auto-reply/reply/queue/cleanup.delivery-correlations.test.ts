import { expectDefined } from "@openclaw/normalization-core";
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
function expectOutcomes({ begin, end }: ReturnType<typeof source>, outcomes: unknown[]) {
  expect(begin).toHaveBeenCalledTimes(outcomes.length);
  expect(end.mock.calls).toEqual(outcomes.map((outcome) => [outcome]));
}

it.each(["clear", "stop"] as const)(
  "settles captured pending, summary and elided sources once through %s",
  async (boundary) => {
    const sources = Array.from({ length: 6 }, (_, index) => source(String(index), 2));
    sources[0]!.end.mockImplementation(() => {
      throw new Error("reaction transport unavailable");
    });
    const mailbox = sources[0]!.run.controllerInput!.mailbox;
    expect(mailbox.items.map((run) => run.prompt)).toEqual(["4", "5"]);
    expect(mailbox.summarySources.map((run) => run.prompt)).toEqual(["2", "3"]);
    expect(
      mailbox.summaryElisions.flatMap((part) => part.sources.map((run) => run.prompt)),
    ).toEqual(["0", "1"]);
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
    const first = await clear();
    if (boundary === "stop") {
      expect(first).toBe(3);
    }
    await Promise.all(inputs.map(settleSource));
    const second = await clear();
    if (boundary === "stop") {
      expect(second).toBe(0);
    }
    for (const [index, sample] of sources.entries()) {
      expectOutcomes(sample, index % 2 === 0 ? [failed] : []);
    }
  },
);

it.each(["final", "retry", "source-owned", true, false] as const)(
  "preserves the correlation outcome on %s retirement",
  async (outcome) => {
    const sample = source("source", false);
    const { run } = sample;
    const delivered = { visibleReplySent: true, failed: false, completed: true };
    if (typeof outcome === "boolean") {
      queue.settings.mode = "steer";
      const reservation = await queue.admit(run);
      reservation.accepted(outcome);
      reservation.consume("consumed");
    } else {
      queue.enqueue(run, false, "none");
      const finish = expectDefined(run.deliveryCorrelations?.[0]?.begin(), "correlation receipt");
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
      expectOutcomes(sample, []);
    } else {
      expectOutcomes(
        sample,
        outcome === "retry" ? [undefined, failed] : [outcome === "final" ? delivered : undefined],
      );
    }
  },
);

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
