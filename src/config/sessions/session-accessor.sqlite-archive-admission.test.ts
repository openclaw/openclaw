import { setImmediate as nextTurn } from "node:timers/promises";
import { DEFAULT_WORKER_PENDING_TASKS } from "@openclaw/worker-runtime";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { runExclusiveSqliteTranscriptArchiveWorker as enqueue } from "./session-accessor.sqlite-archive.js";

async function holdArchive(onRelease: () => unknown = () => {}, signal?: AbortSignal) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const holder = enqueue(async () => {
    entered.resolve();
    await release.promise;
    return onRelease();
  }, signal);
  await entered.promise;
  return { holder, release: () => release.resolve() };
}

it("bounds outstanding archive claims until their FIFO slots physically settle", async () => {
  const { holder, release } = await holdArchive();
  const controller = new AbortController();
  const queued = Array.from({ length: DEFAULT_WORKER_PENDING_TASKS - 1 }, () =>
    enqueue(async () => undefined, controller.signal),
  );
  const settled = Promise.allSettled(queued);
  const overflow = vi.fn(async () => undefined);
  let overflowError: unknown;
  const rejected = enqueue(overflow).catch((error: unknown) => {
    overflowError = error;
  });
  let canceledOverflow: Promise<unknown> | undefined;
  try {
    await nextTurn();
    expect(overflowError).toMatchObject({ code: "overloaded" });
    expect(overflow).not.toHaveBeenCalled();
    controller.abort(new Error("request retired"));
    await settled;
    // Cancellation removes execution, not the linked FIFO slot behind a native owner.
    canceledOverflow = enqueue(overflow);
    await expect(canceledOverflow).rejects.toMatchObject({ code: "overloaded" });
  } finally {
    release();
    await Promise.allSettled([holder, ...queued, rejected, canceledOverflow]);
  }
  await expect(enqueue(async () => "recovered")).resolves.toBe("recovered");
});

it.each(["before-enqueue", "queued"] as const)(
  "drops a revoked %s request while preserving surviving FIFO order",
  async (when) => {
    const order: string[] = [];
    const { holder, release } = await holdArchive(() => order.push("holder"));
    const controller = new AbortController();
    const reason = new Error("request retired");
    const revoked = vi.fn(async () => "revoked");
    const first = enqueue(async () => {
      order.push("first");
      return 1;
    });
    if (when === "before-enqueue") {
      controller.abort(reason);
    }
    const canceled = enqueue(revoked, controller.signal);
    const refusal = expect(canceled).rejects.toBe(reason);
    const second = enqueue(async () => {
      order.push("second");
      return 2;
    });
    controller.abort(reason);
    try {
      await refusal;
      expect(order).toEqual([]);
      expect(revoked).not.toHaveBeenCalled();
      release();
      await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
      expect(order).toEqual(["holder", "first", "second"]);
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.allSettled([holder, first, canceled, second]);
    }
  },
);

it.each(["fulfills", "rejects"] as const)(
  "joins admitted work that %s even when its request is revoked",
  async (outcome) => {
    const controller = new AbortController();
    const failure = new Error("operation failed");
    let settled = false;
    const { holder, release } = await holdArchive(() => {
      if (outcome === "rejects") {
        throw failure;
      }
      return "finished";
    }, controller.signal);
    const active = holder.finally(() => {
      settled = true;
    });
    void active.catch(() => {});
    const next = vi.fn(async () => "next");
    const following = enqueue(next);
    controller.abort(new Error("request retired"));
    try {
      await nextTurn();
      expect(settled).toBe(false);
      expect(next).not.toHaveBeenCalled();
      release();
      if (outcome === "rejects") {
        await expect(active).rejects.toBe(failure);
      } else {
        await expect(active).resolves.toBe("finished");
      }
      await expect(following).resolves.toBe("next");
      expect(next).toHaveBeenCalledOnce();
    } finally {
      release();
      await Promise.allSettled([active, following]);
    }
  },
);
