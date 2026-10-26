import { expect, it, vi } from "vitest";
import {
  admitFollowupRunLifecycle as admit,
  completeFollowupRunLifecycle as complete,
  markFollowupRunEnqueued as markEnqueued,
} from "./lifecycle.js";
import { observe, queueFixture } from "./lifecycle.test-support.js";
import { clearFollowupQueue } from "./state.js";

const queue = queueFixture("followup");

it.each(["abandonment", "publication failure", "adoption"] as const)(
  "retains source custody during pending %s",
  async (phase) => {
    const run = queue.source("lifecycle");
    const release = queue.gate();
    const failure = new Error("deferral publication failed");
    const onAbandoned = vi.fn();
    const onSettled = vi.fn(phase === "publication failure" ? release.wait : undefined);
    run.turnAdoptionLifecycle = {
      onAdopted: phase === "adoption" ? release.wait : () => {},
      onDeferred: vi.fn(),
      onAbandoned:
        phase === "abandonment" ? release.wait : phase === "adoption" ? onAbandoned : undefined,
      onSettled,
    };
    let admission: Promise<void> | undefined;
    if (phase === "adoption") {
      admission = admit(run);
      await release.entered;
      complete(run);
    } else if (phase === "publication failure") {
      run.turnAdoptionLifecycle.onDeferred = () => {
        throw failure;
      };
      expect(() => queue.enqueue(run)).toThrow(failure);
    } else {
      queue.enqueue(run);
      expect(run.turnAdoptionLifecycle.onDeferred).toHaveBeenCalledExactlyOnceWith();
      clearFollowupQueue(queue.key, run.controllerInput!.mailbox);
      await release.entered;
    }
    expect(onSettled).toHaveBeenCalledTimes(phase === "publication failure" ? 1 : 0);
    const completion = observe(queue.settle(run));
    expect(completion.called).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([admission, completion.promise]);
    expect(onSettled).toHaveBeenCalledOnce();
    if (phase === "adoption") {
      expect(onAbandoned).not.toHaveBeenCalled();
    }
  },
);

it.each(["admitted", "completed", "aborted"] as const)("skips %s renewal", async (state) => {
  const run = queue.source("lifecycle");
  vi.useFakeTimers();
  const abort = new AbortController();
  const lifecycle = {
    abortSignal: abort.signal,
    onAdopted: vi.fn(),
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
  expect(markEnqueued(run)).toBe(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
