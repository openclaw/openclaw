import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import {
  SessionCatalogListAdmission,
  type SessionCatalogListTiming,
} from "./session-catalog-list-admission.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("SessionCatalogListAdmission", () => {
  it("starts at most the configured number of provider lists", async () => {
    const admission = new SessionCatalogListAdmission(2, 2);
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    const tasks = gates.map((gate) => vi.fn(() => gate.promise));
    const pending = tasks.map((task) => admission.run(task));

    expect(tasks.map((task) => task.mock.calls.length)).toEqual([1, 1, 0, 0]);
    gates[0]?.resolve(0);
    await expect(pending[0]).resolves.toBe(0);
    expect(tasks.map((task) => task.mock.calls.length)).toEqual([1, 1, 1, 0]);

    gates[1]?.resolve(1);
    gates[2]?.resolve(2);
    gates[3]?.resolve(3);
    await expect(Promise.all(pending)).resolves.toEqual([0, 1, 2, 3]);
  });

  it("releases a slot after rejection and preserves FIFO order", async () => {
    const admission = new SessionCatalogListAdmission(1, 2);
    const active = deferred<void>();
    const order: string[] = [];
    const first = admission.run(() => active.promise);
    const second = admission.run(async () => {
      order.push("second");
      return 2;
    });
    const third = admission.run(async () => {
      order.push("third");
      return 3;
    });

    active.reject(new Error("provider failed"));
    await expect(first).rejects.toThrow("provider failed");
    await expect(Promise.all([second, third])).resolves.toEqual([2, 3]);
    expect(order).toEqual(["second", "third"]);
  });

  it("rejects overflow without starting the provider", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const active = deferred<void>();
    const first = admission.run(() => active.promise);
    const queued = admission.run(async () => undefined);
    const overflowTask = vi.fn(async () => undefined);

    await expect(admission.run(overflowTask)).rejects.toMatchObject({ code: "catalog_busy" });
    expect(overflowTask).not.toHaveBeenCalled();

    active.resolve();
    await Promise.all([first, queued]);
  });

  it("reserves a continuing operation behind all 32 waiters before admitting new arrivals", async () => {
    const admission = new SessionCatalogListAdmission(4, 32);
    const firstPage = deferred<void>();
    const otherActive = Array.from({ length: 3 }, () => deferred<void>());
    const oldestStarted = deferred<void>();
    const oldestPage = deferred<void>();
    const order: string[] = [];
    let page = 0;
    let lateArrival: Promise<unknown> | undefined;
    const continuing = admission.runSteps(async () => {
      page += 1;
      order.push(`page-${page}`);
      if (page === 1) {
        await firstPage.promise;
        return { done: false };
      }
      return { done: true, value: "filled" };
    });
    const active = otherActive.map((gate) => admission.run(() => gate.promise));
    const queued = Array.from({ length: 32 }, (_, index) =>
      admission.run(async () => {
        order.push(`queued-${index}`);
        if (index === 0) {
          lateArrival = admission.run(async () => order.push("late"));
          void lateArrival.catch(() => undefined);
          oldestStarted.resolve();
          await oldestPage.promise;
        }
      }),
    );

    firstPage.resolve();
    await oldestStarted.promise;
    expect(order).toEqual(["page-1", "queued-0"]);
    await expect(lateArrival).rejects.toMatchObject({ code: "catalog_busy" });
    oldestPage.resolve();
    await expect(continuing).resolves.toBe("filled");
    expect(order).toEqual([
      "page-1",
      ...Array.from({ length: 32 }, (_, index) => `queued-${index}`),
      "page-2",
    ]);
    for (const gate of otherActive) {
      gate.resolve();
    }
    await Promise.all([...active, ...queued]);
  });

  it("retires an active operation only after its page settles and never starts its next page", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const controller = new AbortController();
    const page = deferred<void>();
    const step = vi.fn(async () => {
      await page.promise;
      return { done: false as const };
    });
    const pending = admission.runSteps(step, controller.signal);
    const rejected = expect(pending).rejects.toThrow("retired");
    const healthy = vi.fn(async () => "healthy");
    const next = admission.run(healthy);

    controller.abort(new Error("retired"));
    expect(healthy).not.toHaveBeenCalled();
    page.resolve();
    await rejected;
    await expect(next).resolves.toBe("healthy");
    expect(step).toHaveBeenCalledTimes(1);
  });

  it.each(["during-start", "while-active"])(
    "removes only a continuation cancelled %s by its successor",
    async (mode) => {
      const admission = new SessionCatalogListAdmission(1, 2);
      const controller = new AbortController();
      const page = deferred<void>();
      const successorStarted = deferred<void>();
      const successorPage = deferred<void>();
      const step = vi.fn(async () => {
        await page.promise;
        return { done: false as const };
      });
      const pending = admission.runSteps(step, controller.signal);
      const rejected = expect(pending).rejects.toThrow("retired");
      const successor = admission.run(async () => {
        successorStarted.resolve();
        if (mode === "during-start") {
          controller.abort(new Error("retired"));
        }
        await successorPage.promise;
      });

      page.resolve();
      await successorStarted.promise;
      if (mode === "while-active") {
        controller.abort(new Error("retired"));
      }
      await rejected;
      const later = vi.fn(async () => "later");
      const laterResult = admission.run(later);
      expect(later).not.toHaveBeenCalled();
      successorPage.resolve();
      await successor;
      await expect(laterResult).resolves.toBe("later");
      expect(step).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves FIFO over repeated handoffs and releases a failed resumed step", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const firstPage = deferred<void>();
    const order: string[] = [];
    let firstPages = 0;
    let secondPages = 0;
    const first = admission.runSteps(async () => {
      firstPages += 1;
      order.push(`first-${firstPages}`);
      if (firstPages === 1) {
        await firstPage.promise;
      }
      return firstPages === 4 ? { done: true, value: "filled" } : { done: false };
    });
    const second = admission.runSteps(async () => {
      secondPages += 1;
      order.push(`second-${secondPages}`);
      if (secondPages === 2) {
        throw new Error("resumed page failed");
      }
      return { done: false };
    });
    const failure = expect(second).rejects.toThrow("resumed page failed");
    firstPage.resolve();
    await expect(first).resolves.toBe("filled");
    await failure;
    expect(order).toEqual(["first-1", "second-1", "first-2", "second-2", "first-3", "first-4"]);
    await expect(admission.run(async () => "healthy")).resolves.toBe("healthy");
  });

  it("restores the initial caller context and records waiting separately from admitted steps", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const context = new AsyncLocalStorage<string>();
    const firstPage = deferred<void>();
    const secondPage = deferred<void>();
    const otherStarted = deferred<void>();
    const otherPage = deferred<void>();
    const secondStarted = deferred<void>();
    const timing: SessionCatalogListTiming = {};
    const seen: Array<string | undefined> = [];
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    try {
      let page = 0;
      const pending = context.run("original", () =>
        admission.runSteps(
          async () => {
            seen.push(context.getStore());
            page += 1;
            if (page === 1) {
              await firstPage.promise;
              return { done: false };
            }
            secondStarted.resolve();
            await secondPage.promise;
            return { done: true, value: "filled" };
          },
          undefined,
          timing,
        ),
      );
      const other = context.run("other", () =>
        admission.run(async () => {
          seen.push(context.getStore());
          otherStarted.resolve();
          await otherPage.promise;
        }),
      );
      clock = 10;
      firstPage.resolve();
      await otherStarted.promise;
      clock = 30;
      otherPage.resolve();
      await secondStarted.promise;
      clock = 35;
      secondPage.resolve();
      await expect(pending).resolves.toBe("filled");
      await other;
      expect(seen).toEqual(["original", "other", "original"]);
      expect(timing).toEqual({
        admittedAt: 0,
        settledAt: 35,
        continuationWaitMs: 20,
        admittedStepMs: 15,
        stepCount: 2,
      });
    } finally {
      now.mockRestore();
    }
  });
});
