import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSessionControllerSourceSettlement } from "../../../sessions/session-controller.mailbox.js";
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
const keys = new Set<string>();
afterEach(() => {
  for (const key of keys) {
    clearFollowupQueue(key);
  }
  keys.clear();
});

function source(key: string, prompt: string) {
  keys.add(key);
  const run = createQueueTestRun({ prompt });
  Object.assign(run.run, { agentId: "main", sessionKey: key });
  const end = vi.fn();
  const begin = vi.fn(() => end);
  run.deliveryCorrelations = [{ begin }];
  return { run, begin, end };
}

describe("queued delivery correlation cleanup", () => {
  it.each(["clear", "stop"] as const)(
    "settles captured pending, summary and elided sources once through %s",
    async (boundary) => {
      const key = `agent:main:correlation-${boundary}`;
      const sources = Array.from({ length: 6 }, (_, index) => source(key, `source-${index}`));
      sources[0]!.end.mockImplementation(() => {
        throw new Error("reaction transport unavailable");
      });
      for (const { run } of sources) {
        enqueueFollowupRun(key, run, createQueueSettings({ cap: 2 }), "none", undefined, false);
      }
      const queue = sources[0]!.run.controllerInput!.mailbox;
      expect(queue.items.map((run) => run.prompt)).toEqual(["source-4", "source-5"]);
      expect(queue.summarySources.map((run) => run.prompt)).toEqual(["source-2", "source-3"]);
      expect(
        queue.summaryElisions.flatMap((part) => part.sources.map((run) => run.prompt)),
      ).toEqual(["source-0", "source-1"]);
      const inputs = sources
        .filter((_, index) => index % 2 === 0)
        .map(({ run }) => run.controllerInput!);
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
      await Promise.all(inputs.map(captureSessionControllerSourceSettlement));
      expect(await clear()).toBe(0);
      for (const [index, { begin, end }] of sources.entries()) {
        expect(begin).toHaveBeenCalledTimes(index % 2 === 0 ? 1 : 0);
        expect(end).toHaveBeenCalledTimes(index % 2 === 0 ? 1 : 0);
        if (index % 2 === 0) {
          expect(end).toHaveBeenCalledWith({ visibleReplySent: false, failed: true });
        }
      }
    },
  );

  it.each(["final", "retry", "source-owned"] as const)(
    "preserves the delivery runner's %s correlation outcome during retirement",
    async (outcome) => {
      const key = `agent:main:correlation-runner-${outcome}`;
      const { run, begin, end } = source(key, "runner source");
      enqueueFollowupRun(key, run, createQueueSettings(), "none", undefined, false);
      // Exercise the same public begin/end contract used by the delivery runner.
      const finish = run.deliveryCorrelations?.[0]?.begin();
      if (typeof finish !== "function") {
        throw new Error("Expected a delivery correlation receipt");
      }
      const delivered = { visibleReplySent: true, failed: false, completed: true };
      finish(outcome === "final" ? delivered : undefined);
      if (outcome === "source-owned") {
        completeFollowupRunLifecycle(run, "consumed");
      } else {
        clearSessionQueues([key], undefined, [run.controllerInput!]);
      }
      await captureSessionControllerSourceSettlement(run.controllerInput!);
      expect(begin).toHaveBeenCalledTimes(outcome === "retry" ? 2 : 1);
      expect(end).toHaveBeenCalledTimes(outcome === "retry" ? 2 : 1);
      if (outcome === "retry") {
        expect(end).toHaveBeenLastCalledWith({ visibleReplySent: false, failed: true });
      } else {
        expect(end).toHaveBeenLastCalledWith(outcome === "final" ? delivered : undefined);
      }
    },
  );

  it.each([true, false])(
    "does not synthesize failure for consumed native steering with acceptance=%s",
    async (accepted) => {
      const key = `agent:main:correlation-native-${accepted}`;
      const { run, begin } = source(key, "native source");
      const reservation = expectDefined(
        reserveSteerCandidate(key, run, createQueueSettings({ mode: "steer" }), async () => {}),
        "native reservation",
      );
      expect(await reservation.admit()).toBe("steer");
      reservation.accepted(accepted);
      // Both accepted and indeterminate outcomes are consumed without replay.
      reservation.consume("consumed");
      await captureSessionControllerSourceSettlement(run.controllerInput!);
      clearSessionQueues([key]);
      expect(begin).not.toHaveBeenCalled();
    },
  );

  it("retains abandonment through asynchronous cleanup and a later consumed completion", async () => {
    const key = "agent:main:correlation-async-abandonment";
    const { run, begin, end } = source(key, "async source");
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
      clearSessionQueues([key], undefined, [run.controllerInput!]);
      await entered.promise;
      completeFollowupRunLifecycle(run, "consumed");
      clearSessionQueues([key], undefined, [run.controllerInput!]);
      expect(begin).not.toHaveBeenCalled();
      release.resolve();
      await captureSessionControllerSourceSettlement(run.controllerInput!);
      expect(begin).toHaveBeenCalledOnce();
      expect(end).toHaveBeenCalledExactlyOnceWith({ visibleReplySent: false, failed: true });
    } finally {
      release.resolve();
      await captureSessionControllerSourceSettlement(run.controllerInput!);
    }
  });
});
