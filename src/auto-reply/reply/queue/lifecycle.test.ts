import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAdmittedRunOperatorAuthority } from "../../../agents/admitted-run-context.js";
import { captureSessionControllerSourceSettlement as settleSource } from "../../../sessions/session-controller.mailbox.js";
import {
  admitFollowupRunLifecycle as admit,
  completeFollowupRunLifecycle as complete,
  markFollowupRunEnqueued as markEnqueued,
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

it.each([false, true])(
  "checks queued=%s authority once per single-flight adoption",
  async (enqueued) => {
    const release = queue.gate();
    const failure = new Error("source adoption failed");
    const reauthorize = vi.fn();
    const persistInput = vi.fn(async () => {});
    const onAdopted = vi
      .fn(async () => {
        expect(persistInput).toHaveBeenCalledTimes(onAdopted.mock.calls.length);
        await release.wait();
      })
      .mockRejectedValueOnce(failure);
    run.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "operator",
      scopes: ["operator.write"],
      source: {},
      assertCurrent: () => {},
      reauthorize,
    });
    run.turnAdoptionLifecycle = { onAdopted };
    if (enqueued) {
      expect(markEnqueued(run)).toBe(true);
    }
    await expect(admit(run, persistInput)).rejects.toThrow(failure);
    expect(persistInput).toHaveBeenCalledOnce();
    expect(reauthorize).toHaveBeenCalledTimes(enqueued ? 1 : 0);
    const retry = admit(run, persistInput);
    const concurrent = admit(run);
    await release.entered;
    expect(reauthorize).toHaveBeenCalledTimes(enqueued ? 2 : 0);
    expect(onAdopted).toHaveBeenCalledTimes(2);
    release.resolve();
    await Promise.all([retry, concurrent]);
    await admit(run);
    expect(reauthorize).toHaveBeenCalledTimes(enqueued ? 2 : 0);
    expect(onAdopted).toHaveBeenCalledTimes(2);
  },
);

it("rejects queued authority before consuming input or acknowledging adoption", async () => {
  const rejected = queue.source("revoked");
  const failure = new Error("queued requester lost access");
  const persistInput = vi.fn(async () => {});
  const onAdopted = vi.fn();
  const reauthorize = vi.fn(() => {
    throw failure;
  });
  rejected.operatorAuthority = createAdmittedRunOperatorAuthority({
    profileId: "operator",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    reauthorize,
  });
  rejected.turnAdoptionLifecycle = { onAdopted };
  expect(markEnqueued(rejected)).toBe(true);
  await expect(admit(rejected, persistInput)).rejects.toThrow(failure);
  expect(reauthorize).toHaveBeenCalledOnce();
  expect(persistInput).not.toHaveBeenCalled();
  expect(onAdopted).not.toHaveBeenCalled();
  complete(rejected);
  await expect(settleSource(rejected.controllerInput!)).rejects.toThrow(failure);
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
