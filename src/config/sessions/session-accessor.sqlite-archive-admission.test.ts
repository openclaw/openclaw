import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { runExclusiveSqliteTranscriptArchiveWorker as enqueue } from "./session-accessor.sqlite-archive.js";

it.each(["before-enqueue", "queued"] as const)(
  "drops a revoked %s request while preserving surviving FIFO order",
  async (when) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const order: string[] = [];
    const holder = enqueue(async () => {
      entered.resolve();
      await release.promise;
      order.push("holder");
    });
    await entered.promise;
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
      release.resolve();
      await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
      expect(order).toEqual(["holder", "first", "second"]);
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([holder, first, canceled, second]);
    }
  },
);

it.each(["fulfills", "rejects"] as const)(
  "joins admitted work that %s even when its request is revoked",
  async (outcome) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const controller = new AbortController();
    const failure = new Error("operation failed");
    let settled = false;
    const active = enqueue(async () => {
      entered.resolve();
      await release.promise;
      if (outcome === "rejects") {
        throw failure;
      }
      return "finished";
    }, controller.signal).finally(() => {
      settled = true;
    });
    void active.catch(() => {});
    await entered.promise;
    const next = vi.fn(async () => "next");
    const following = enqueue(next);
    controller.abort(new Error("request retired"));
    try {
      await nextTurn();
      expect(settled).toBe(false);
      expect(next).not.toHaveBeenCalled();
      release.resolve();
      if (outcome === "rejects") {
        await expect(active).rejects.toBe(failure);
      } else {
        await expect(active).resolves.toBe("finished");
      }
      await expect(following).resolves.toBe("next");
      expect(next).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([active, following]);
    }
  },
);
