import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureSessionControllerSourceSettlement as settleSource } from "../../../sessions/session-controller.mailbox.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { createQueueTestRun } from "../queue.test-helpers.js";
import { enqueueFollowupRun } from "./enqueue.js";
import {
  admitFollowupRunLifecycle as admit,
  completeFollowupRunLifecycle as complete,
  markFollowupRunEnqueued as markEnqueued,
} from "./lifecycle.js";
import { clearFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

let run: FollowupRun;
const releases: Array<() => void> = [];
function gate() {
  const entered = createDeferredCore();
  const deferred = createDeferredCore();
  releases.push(() => deferred.resolve());
  return {
    entered: entered.promise,
    resolve: () => deferred.resolve(),
    wait: async () => {
      entered.resolve();
      await deferred.promise;
    },
  };
}
beforeEach(() => {
  run = createQueueTestRun({ prompt: "lifecycle" });
});
afterEach(async () => {
  for (const release of releases.splice(0)) {
    release();
  }
  try {
    complete(run);
    await settleSource(run.controllerInput!);
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the public deferral callback free of internal observation arguments", async () => {
  const lifecycle = { onAdopted: vi.fn(), onDeferred: vi.fn() };
  run.turnAdoptionLifecycle = lifecycle;
  expect(markEnqueued(run)).toBe(true);
  expect(lifecycle.onDeferred).toHaveBeenCalledExactlyOnceWith();
});

it.each(["abandonment", "publication failure", "adoption"] as const)(
  "retains source custody during pending %s",
  async (phase) => {
    const release = gate();
    const failure = new Error("deferral publication failed");
    const onAbandoned = vi.fn();
    const onSettled = vi.fn(phase === "publication failure" ? release.wait : undefined);
    run.turnAdoptionLifecycle = {
      onAdopted: phase === "adoption" ? release.wait : () => {},
      onAbandoned:
        phase === "abandonment" ? release.wait : phase === "adoption" ? onAbandoned : undefined,
      onSettled,
    };
    let admission: Promise<void> | undefined;
    if (phase === "adoption") {
      admission = admit(run);
      await release.entered;
      complete(run);
    } else {
      const key = "agent:main:pending-custody";
      if (phase === "publication failure") {
        run.turnAdoptionLifecycle.onDeferred = () => {
          throw failure;
        };
        expect(() => enqueueFollowupRun(key, run, { mode: "followup" })).toThrow(failure);
      } else {
        run.messageId = "source-1";
        Object.assign(run.run, { agentId: "main", sessionKey: key });
        enqueueFollowupRun(key, run, { mode: "followup" }, "message-id");
        clearFollowupQueue(key, run.controllerInput!.mailbox);
        await release.entered;
      }
    }
    expect(onSettled).toHaveBeenCalledTimes(phase === "publication failure" ? 1 : 0);
    const settled = vi.fn();
    const completion = settleSource(expectDefined(run.controllerInput, "pending source"));
    void completion.then(settled);
    expect(settled).not.toHaveBeenCalled();
    release.resolve();
    await admission;
    await completion;
    expect(settled).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledOnce();
    if (phase === "adoption") {
      expect(onAbandoned).not.toHaveBeenCalled();
    }
  },
);

it.each(["admitted", "completed", "aborted"] as const)(
  "does not start renewal for an already %s lifecycle",
  async (state) => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const lifecycle = {
      admission: "exclusive" as const,
      abortSignal: abort.signal,
      onDeferredHeartbeat: vi.fn(),
      deferredHeartbeatIntervalMs: 100,
    };
    run.turnAdoptionLifecycle = lifecycle;
    if (state === "admitted") {
      await admit(run);
    } else if (state === "completed") {
      complete(run);
    } else {
      abort.abort();
    }
    markEnqueued(run);
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);
