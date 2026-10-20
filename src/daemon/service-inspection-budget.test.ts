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

it("counts nested synchronous guards once, propagates refusal, and charges async work", async () => {
  const budget = makeBudget();
  const refusal = new Error("current custody revoked");
  await budget.run(async () => {
    expect(getServiceInspectionClock()).toBe(budget.now);
    runServiceInspectionGuard(() => {
      now += 2_000;
      withServiceInspectionBudget((nested) => {
        expect(nested).toBe(budget);
        guard(3_000);
      });
      now += 1_000;
    });
    expect(budget.now()).toBe(0);
    expect(() =>
      runServiceInspectionGuard(() => {
        now += 2_000;
        throw refusal;
      }),
    ).toThrow(refusal);
    expect(budget.now()).toBe(0);
    const gate = createDeferred();
    const work = gate.promise.then(() => advance(100));
    now += 200;
    gate.resolve();
    await work;
    expect(budget.now()).toBe(300);
  });
  expect(now).toBe(8_300);
});

it("keeps concurrent scopes and retained clocks independent", async () => {
  const a = makeBudget();
  const b = makeBudget();
  const entered = createDeferred();
  const release = createDeferred();
  const first = a.run(async () => {
    entered.resolve();
    await release.promise;
    guard(40);
    expect(getServiceInspectionClock()).toBe(a.now);
  });
  await entered.promise;
  await b.run(async () => {
    guard(60);
    release.resolve();
    await first;
    expect(getServiceInspectionClock()).toBe(b.now);
  });
  expect(a.now()).toBe(60);
  expect(b.now()).toBe(40);
  expect(getServiceInspectionClock()).not.toBe(a.now);
});

it("rechecks queued expiry in the shared clock while preserving FIFO and cleanup joining", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const budget = makeBudget();
  const queue = createSystemdPeerQueue();
  const entered = createDeferred();
  const release = createDeferred();
  const order: string[] = [];
  await budget.run(async () => {
    const first = queue.run(100, async () => {
      entered.resolve();
      await release.promise;
      order.push("first");
    });
    await entered.promise;
    const second = queue.run(50, async () => {
      order.push("second");
    });
    // The event loop resumes after a slow synchronous check; its old timer is due.
    guard(1_000);
    await vi.advanceTimersByTimeAsync(50);
    expect(order).toEqual([]);
    let joined = false;
    const drain = queue.drain().then(() => {
      joined = true;
    });
    expect(joined).toBe(false);
    release.resolve();
    await Promise.all([first, second, drain]);
    expect(order).toEqual(["first", "second"]);
    expect(joined).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("does not credit another scope's guard to a queued deadline", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const queue = createSystemdPeerQueue();
  const a = makeBudget();
  const b = makeBudget();
  const entered = createDeferred();
  const release = createDeferred();
  const first = a.run(() =>
    queue.run(100, async () => {
      entered.resolve();
      await release.promise;
    }),
  );
  await entered.promise;
  const execute = vi.fn(async () => {});
  const second = b.run(() => queue.run(50, execute));
  const expired = expect(second).rejects.toThrow("deadline expired");
  a.run(() => guard(100));
  await vi.advanceTimersByTimeAsync(50);
  await expired;
  expect(execute).not.toHaveBeenCalled();
  release.resolve();
  await first;
  await queue.drain();
  expect(vi.getTimerCount()).toBe(0);
});
