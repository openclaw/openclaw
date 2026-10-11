import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { SessionCatalogListAdmission } from "./session-catalog-list-admission.js";

describe("SessionCatalogListAdmission", () => {
  it("starts at most the configured number of provider lists", async () => {
    const admission = new SessionCatalogListAdmission(2, 2);
    const gates = Array.from({ length: 4 }, () => createDeferredCore<number>());
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

  it("releases a slot after rejection and preserves queued FIFO order", async () => {
    const admission = new SessionCatalogListAdmission(1, 2);
    const active = createDeferredCore();
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

  it("rejects overflow of the bounded waiting queue", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const active = createDeferredCore();
    const first = admission.run(() => active.promise);
    const queued = admission.run(async () => undefined);
    const overflowTask = vi.fn(async () => undefined);

    await expect(admission.run(overflowTask)).rejects.toMatchObject({
      code: "catalog_busy",
      message: "session catalog is busy (1 active, 1 queued); retry shortly",
    });
    expect(overflowTask).not.toHaveBeenCalled();
    active.resolve();
    await Promise.all([first, queued]);
  });

  it("retires an active operation only after its page settles and never starts its next page", async () => {
    const admission = new SessionCatalogListAdmission(1, 1);
    const controller = new AbortController();
    const page = createDeferredCore();
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
});
