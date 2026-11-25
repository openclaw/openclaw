import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  getServiceInspectionClock,
  runServiceInspectionGuard,
  withServiceInspectionBudget,
} from "./service-inspection-budget.js";
import { createSystemdPeerQueue } from "./systemd-peer-queue.js";

let now = 0;
const makeBudget = () => withServiceInspectionBudget((scope) => scope);
const advance = (ms: number) => {
  now += ms;
};
const guard = (ms: number) => runServiceInspectionGuard(() => advance(ms));
beforeEach(() => {
  now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("excludes nested guards and refusals, but charges async work", async () => {
  const budget = makeBudget();
  const refusal = new Error("current custody revoked");
  await budget.run(async () => {
    expect(getServiceInspectionClock()).toBe(budget.now);
    runServiceInspectionGuard(() => {
      advance(2_000);
      withServiceInspectionBudget((nested) => {
        expect(nested).toBe(budget);
        guard(3_000);
      });
      advance(1_000);
    });
    expect(budget.now()).toBe(0);
    expect(() =>
      runServiceInspectionGuard(() => {
        advance(2_000);
        throw refusal;
      }),
    ).toThrow(refusal);
    expect(budget.now()).toBe(0);
    const work = Promise.resolve().then(() => advance(100));
    advance(200);
    await work;
    expect(budget.now()).toBe(300);
  });
  expect(now).toBe(8_300);
});

it("keeps concurrent scopes and retained clocks independent", async () => {
  const a = makeBudget();
  const b = makeBudget();
  const release = createDeferred();
  const first = a.run(async () => {
    await release.promise;
    guard(40);
    expect(getServiceInspectionClock()).toBe(a.now);
  });
  await b.run(async () => {
    guard(60);
    release.resolve();
    await first;
    expect(getServiceInspectionClock()).toBe(b.now);
  });
  expect([a.now(), b.now()]).toEqual([60, 40]);
  expect(getServiceInspectionClock()).not.toBe(a.now);
});

it.each([true, false])("keeps queued budgets scope-local (shared=%s)", async (shared) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const a = makeBudget();
  const b = shared ? a : makeBudget();
  const queue = createSystemdPeerQueue();
  const entered = createDeferred();
  const release = createDeferred();
  const order: string[] = [];
  await a.run(async () => {
    const first = queue.run(100, async () => {
      entered.resolve();
      await release.promise;
      order.push("first");
    });
    await entered.promise;
    const execute = vi.fn(async () => {
      order.push("second");
    });
    const second = b.run(() => queue.run(50, execute));
    const settled = shared ? second : expect(second).rejects.toThrow("deadline expired");
    // The old timer is due after a slow guard; only its own scope discounts it.
    guard(shared ? 1_000 : 100);
    await vi.advanceTimersByTimeAsync(50);
    if (!shared) {
      await settled;
    }
    expect(order).toEqual([]);
    let joined = false;
    const drain = queue.drain().then(() => {
      joined = true;
    });
    expect(joined).toBe(false);
    release.resolve();
    await Promise.all([first, settled, drain]);
    expect(order).toEqual(shared ? ["first", "second"] : ["first"]);
    expect(execute).toHaveBeenCalledTimes(shared ? 1 : 0);
    expect(joined).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
