import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSessionControllerSourceSettlement as settleSource } from "../../../sessions/session-controller.mailbox.js";
import {
  admitFollowupRunLifecycle as admit,
  completeFollowupRunLifecycle as complete,
  markFollowupRunEnqueued as markEnqueued,
  releaseBeforeTurnAdoptionRetry,
} from "./lifecycle.js";
import { queueFixture } from "./lifecycle.test-support.js";
import { clearFollowupQueue } from "./state.js";
import type { FollowupRun } from "./types.js";

let run: FollowupRun;
const queue = queueFixture("followup");
beforeEach(() => {
  run = queue.source("lifecycle");
});
afterEach(async () => {
  queue.release();
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
    const release = queue.gate();
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
    } else if (phase === "publication failure") {
      run.turnAdoptionLifecycle.onDeferred = () => {
        throw failure;
      };
      expect(() => queue.enqueue(run)).toThrow(failure);
    } else {
      run.messageId = "source-1";
      queue.enqueue(run);
      clearFollowupQueue(queue.key, run.controllerInput!.mailbox);
      await release.entered;
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
    markEnqueued(run);
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.onDeferredHeartbeat).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

describe("followup lifecycle terminal disposition", () => {
  const createLifecycle = (abortSignal?: AbortSignal) => ({
    admission: "exclusive" as const,
    abortSignal,
    onAdopted: vi.fn(),
    onDeferred: vi.fn(),
    onCancelled: vi.fn(async () => {}),
    onAbandoned: vi.fn(),
    onSettled: vi.fn(),
  });
  const settle = async () => {
    await settleSource(expectDefined(run.controllerInput, "lifecycle source"));
  };

  it("settles an unadmitted run through onCancelled when it is cancelled", async () => {
    const lifecycle = createLifecycle();
    run.turnAdoptionLifecycle = lifecycle;
    complete(run, "cancelled");
    await settle();
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
    expect(lifecycle.onSettled).toHaveBeenCalledOnce();
  });

  it("treats an already-aborted lifecycle as cancelled", async () => {
    const abort = new AbortController();
    abort.abort();
    const lifecycle = createLifecycle(abort.signal);
    run.turnAdoptionLifecycle = lifecycle;
    complete(run);
    await settle();
    expect(lifecycle.onCancelled).toHaveBeenCalledOnce();
    expect(lifecycle.onAbandoned).not.toHaveBeenCalled();
  });

  it("abandons an unadmitted run that merely finished without the lane", async () => {
    const lifecycle = createLifecycle(new AbortController().signal);
    run.turnAdoptionLifecycle = lifecycle;
    complete(run);
    await settle();
    expect(lifecycle.onAbandoned).toHaveBeenCalledOnce();
    expect(lifecycle.onCancelled).not.toHaveBeenCalled();
  });

  it("falls back to onAbandoned for a cancelled lifecycle that predates onCancelled", async () => {
    const { onCancelled: _onCancelled, ...legacy } = createLifecycle();
    run.turnAdoptionLifecycle = legacy;
    complete(run, "cancelled");
    await settle();
    expect(legacy.onAbandoned).toHaveBeenCalledOnce();
  });

  it("settles a cleared queue's waiting source through onCancelled", async () => {
    const lifecycle = createLifecycle();
    // The message-id dedupe owner wraps both terminal callbacks on enqueue.
    const { onCancelled, onAbandoned, onSettled } = lifecycle;
    run.turnAdoptionLifecycle = lifecycle;
    run.messageId = "cleared-source";
    queue.enqueue(run);
    clearFollowupQueue(queue.key, run.controllerInput!.mailbox);
    await settle();
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(onAbandoned).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it.each([
    { disposition: "cancelled" as const, callback: "onCancelled" as const, wrapped: false },
    { disposition: undefined, callback: "onAbandoned" as const, wrapped: false },
    { disposition: "cancelled" as const, callback: "onCancelled" as const, wrapped: true },
    { disposition: undefined, callback: "onAbandoned" as const, wrapped: true },
  ])(
    "retains a rejecting async $callback (dedupe wrapper: $wrapped) as source custody, then settles",
    async ({ disposition, callback, wrapped }) => {
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const calls: string[] = [];
        const failure = new Error(`${callback} settlement failed`);
        const lifecycle = {
          ...createLifecycle(new AbortController().signal),
          // A plain async function: a vi.fn would observe the rejection itself.
          [callback]: async () => {
            calls.push(callback);
            throw failure;
          },
          onSettled: vi.fn(() => {
            calls.push("onSettled");
          }),
        };
        if (wrapped) {
          // The dedupe owner wraps both callbacks; the wrapper must hand the
          // callback's promise back so core retains custody until it settles.
          releaseBeforeTurnAdoptionRetry(lifecycle, () => calls.push("release"));
        }
        // A separate source: its settlement carries the rejection to its awaiter.
        const rejecting = queue.source("rejecting");
        rejecting.turnAdoptionLifecycle = lifecycle;
        complete(rejecting, disposition);
        await expect(
          settleSource(expectDefined(rejecting.controllerInput, "rejecting source")),
        ).rejects.toBe(failure);
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(calls).toEqual([...(wrapped ? ["release"] : []), callback, "onSettled"]);
        expect(unhandled).not.toHaveBeenCalled();
        expect(lifecycle.onSettled).toHaveBeenCalledOnce();
      } finally {
        process.off("unhandledRejection", unhandled);
      }
    },
  );

  it("never fires a terminal callback for an admitted or consumed run", async () => {
    const admitted = createLifecycle();
    run.turnAdoptionLifecycle = admitted;
    await admit(run);
    complete(run, "cancelled");
    await settle();
    expect(admitted.onCancelled).not.toHaveBeenCalled();
    expect(admitted.onAbandoned).not.toHaveBeenCalled();

    const consumed = createLifecycle();
    const other = queue.source("consumed");
    other.turnAdoptionLifecycle = consumed;
    complete(other, "consumed");
    await settleSource(expectDefined(other.controllerInput, "consumed source"));
    expect(consumed.onCancelled).not.toHaveBeenCalled();
    expect(consumed.onAbandoned).not.toHaveBeenCalled();
  });
});
