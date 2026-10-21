import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureSessionControllerSourceSettlement as settleSource } from "../../../sessions/session-controller.mailbox.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../../sessions/session-controller.stop.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  createQueueSettings,
  createQueueTestRun,
  installQueueRuntimeErrorSilencer,
} from "../queue.test-helpers.js";
import { clearSessionQueues } from "./cleanup.js";
import { enqueueFollowupRun, reserveSteerCandidate } from "./enqueue.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { clearFollowupQueue } from "./state.js";

installQueueRuntimeErrorSilencer();
const failed = { visibleReplySent: false, failed: true };
let key: string;
beforeEach(() => {
  key = `agent:main:${expect.getState().currentTestName}`;
});
afterEach(() => clearFollowupQueue(key));

function source(prompt = "source", cap: number | false = 50) {
  const run = createQueueTestRun({ prompt }, { agentId: "main", sessionKey: key });
  const end = vi.fn();
  const begin = vi.fn(() => end);
  run.deliveryCorrelations = [{ begin }];
  if (cap !== false) {
    enqueueFollowupRun(key, run, createQueueSettings({ cap }), "none", undefined, false);
  }
  return {
    run,
    begin,
    end,
    settle: () => settleSource(run.controllerInput!),
    clear: () => clearSessionQueues([key], undefined, [run.controllerInput!]),
  };
}
function expectOutcomes({ begin, end }: ReturnType<typeof source>, outcomes: unknown[]) {
  expect(begin).toHaveBeenCalledTimes(outcomes.length);
  expect(end.mock.calls).toEqual(outcomes.map((outcome) => [outcome]));
}

it.each(["clear", "stop"] as const)(
  "settles captured pending, summary and elided sources once through %s",
  async (boundary) => {
    const sources = Array.from({ length: 6 }, (_, index) => source(`source-${index}`, 2));
    sources[0]!.end.mockImplementation(() => {
      throw new Error("reaction transport unavailable");
    });
    const queue = sources[0]!.run.controllerInput!.mailbox;
    expect(queue.items.map((run) => run.prompt)).toEqual(["source-4", "source-5"]);
    expect(queue.summarySources.map((run) => run.prompt)).toEqual(["source-2", "source-3"]);
    expect(queue.summaryElisions.flatMap((part) => part.sources.map((run) => run.prompt))).toEqual([
      "source-0",
      "source-1",
    ]);
    const inputs = [0, 2, 4].map((index) => sources[index]!.run.controllerInput!);
    const clear = async () => {
      if (boundary === "clear") {
        return clearSessionQueues([key], undefined, inputs).followupCleared;
      }
      const result = await stopSession({
        source: "restart",
        capture: captureSessionControllerStop({ inputs }),
      }).completed;
      await result.settled;
      return result.queuedCancelled;
    };
    expect(await clear()).toBe(3);
    await Promise.all(inputs.map(settleSource));
    expect(await clear()).toBe(0);
    for (const [index, sample] of sources.entries()) {
      expectOutcomes(sample, index % 2 === 0 ? [failed] : []);
    }
  },
);

it.each(["final", "retry", "source-owned"] as const)(
  "preserves the delivery runner's %s correlation outcome during retirement",
  async (outcome) => {
    const sample = source();
    const { run } = sample;
    const finish = expectDefined(run.deliveryCorrelations?.[0]?.begin(), "correlation receipt");
    const delivered = { visibleReplySent: true, failed: false, completed: true };
    finish(outcome === "final" ? delivered : undefined);
    if (outcome === "source-owned") {
      completeFollowupRunLifecycle(run, "consumed");
    } else {
      sample.clear();
    }
    await sample.settle();
    expectOutcomes(
      sample,
      outcome === "retry" ? [undefined, failed] : [outcome === "final" ? delivered : undefined],
    );
  },
);

it.each([true, false])(
  "does not synthesize failure for consumed native steering with acceptance=%s",
  async (accepted) => {
    const sample = source("native source", false);
    const { run, begin } = sample;
    const reservation = expectDefined(
      reserveSteerCandidate(key, run, createQueueSettings({ mode: "steer" }), async () => {}),
      "native reservation",
    );
    expect(await reservation.admit()).toBe("steer");
    reservation.accepted(accepted);
    reservation.consume("consumed");
    await sample.settle();
    clearSessionQueues([key]);
    expect(begin).not.toHaveBeenCalled();
  },
);

it("retains abandonment through asynchronous cleanup and a later consumed completion", async () => {
  const sample = source("async source", false);
  const { run, begin } = sample;
  const entered = createDeferredCore();
  const release = createDeferredCore();
  run.turnAdoptionLifecycle = {
    onAdopted: () => {},
    onAbandoned: async () => {
      entered.resolve();
      await release.promise;
    },
  };
  enqueueFollowupRun(key, run, createQueueSettings(), "none", undefined, false);
  try {
    sample.clear();
    await entered.promise;
    completeFollowupRunLifecycle(run, "consumed");
    sample.clear();
    expect(begin).not.toHaveBeenCalled();
    release.resolve();
    await sample.settle();
    expectOutcomes(sample, [failed]);
  } finally {
    release.resolve();
    await sample.settle();
  }
});
