import { afterEach, beforeEach, expect, vi } from "vitest";
import { captureSessionControllerSourceSettlement } from "../../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createQueueSettings, createQueueTestRun } from "../queue.test-helpers.js";
import { clearSessionQueues } from "./cleanup.js";
import { enqueueFollowupRun, reserveSteerCandidate } from "./enqueue.js";
import { clearFollowupQueue } from "./state.js";
import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";

export function queueFixture(mode: QueueSettings["mode"]) {
  const releases: Array<() => void> = [];
  const fixture = {
    key: "",
    settings: createQueueSettings({ mode }),
    runFollowup: async (_run: FollowupRun) => {},
    source: (prompt = "source", messageId?: string): FollowupRun =>
      createQueueTestRun({ prompt, messageId }, { agentId: "main", sessionKey: fixture.key }),
    enqueue: (run: FollowupRun, restart = true, dedupe: QueueDedupeMode = "message-id") =>
      enqueueFollowupRun(
        fixture.key,
        run,
        fixture.settings,
        dedupe,
        mode === "steer" ? fixture.runFollowup : undefined,
        restart,
      ),
    reserve: (run: FollowupRun): NonNullable<ReturnType<typeof reserveSteerCandidate>> =>
      reserveSteerCandidate(fixture.key, run, fixture.settings, fixture.runFollowup)!,
    async admit(run: FollowupRun): Promise<NonNullable<ReturnType<typeof reserveSteerCandidate>>> {
      const reservation = fixture.reserve(run);
      await expect(reservation.admit()).resolves.toBe("steer");
      return reservation;
    },
    settle: (run: FollowupRun) => captureSessionControllerSourceSettlement(run.controllerInput!),
    clear: (run: FollowupRun) =>
      clearSessionQueues([fixture.key], undefined, [run.controllerInput!]),
    release: () => releases.splice(0).forEach((release) => release()),
    gate() {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      releases.push(() => release.resolve());
      return {
        entered: entered.promise,
        resolve: () => release.resolve(),
        wait: async () => {
          entered.resolve();
          await release.promise;
        },
      };
    },
  };
  beforeEach(() => {
    fixture.key = `agent:main:${expect.getState().currentTestName}`;
    fixture.settings = createQueueSettings({ mode });
    fixture.runFollowup = vi.fn(async () => {});
  });
  afterEach(() => {
    try {
      if (vi.isMockFunction(fixture.runFollowup)) {
        expect(fixture.runFollowup).not.toHaveBeenCalled();
      }
    } finally {
      fixture.release();
      clearFollowupQueue(fixture.key);
      vi.useRealTimers();
    }
  });
  return fixture;
}

export function observe<T>(promise: Promise<T>) {
  const called = vi.fn((value: T) => value);
  return { called, promise: promise.then(called) };
}
