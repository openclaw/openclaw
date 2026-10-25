/* @vitest-environment jsdom */
import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ValueSignal } from "../board/provider-signals.ts";
import { createSharedOwnerProjection } from "./shared-owner-projection.ts";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) {
    dispose();
  }
  flush();
  vi.restoreAllMocks();
});

function counter(value: number) {
  const owner = new ValueSignal({ count: value });
  const subscribe = owner.subscribe.bind(owner);
  const release = vi.fn();
  const subscriptions = vi.spyOn(owner, "subscribe").mockImplementation((notify) => {
    const stop = subscribe(notify);
    return () => {
      release();
      stop();
    };
  });
  return { owner, subscriptions, release };
}

function observe<T>(read: () => T) {
  const values: T[] = [];
  const dispose = createRoot((stop) => {
    createEffect(read, (value) => {
      values.push(value);
    });
    return stop;
  });
  disposals.push(dispose);
  flush();
  return { values, dispose };
}

it("shares the fixed projection across independent consumers, owners, and read contracts", () => {
  const first = counter(1);
  const second = counter(10);
  const shared = createSharedOwnerProjection(
    (owner: ValueSignal<{ count: number }>) => owner.value,
  );
  const countOnly = createSharedOwnerProjection(
    (owner: ValueSignal<{ count: number }>) => owner.value.count,
  );
  // The first caller can retire before the consumers that observe its shared projection.
  const creator = createRoot((dispose) => ({ projection: shared(first.owner), dispose }));
  disposals.push(creator.dispose);
  const firstProjection = creator.projection;
  const secondProjection = shared(second.owner);
  expect(shared(first.owner)).toBe(firstProjection);
  expect([firstProjection.read().count, secondProjection.read().count]).toEqual([1, 10]);
  expect(first.subscriptions).not.toHaveBeenCalled();
  expect(second.subscriptions).not.toHaveBeenCalled();

  const left = observe(() => firstProjection.read().count);
  const right = observe(() => shared(first.owner).read().count);
  const separateOwner = observe(() => secondProjection.read().count);
  const separateContract = observe(() => countOnly(first.owner).read());
  expect(first.subscriptions).toHaveBeenCalledTimes(2);
  expect(second.subscriptions).toHaveBeenCalledOnce();
  creator.dispose();
  first.owner.value.count = 2;
  first.owner.set(first.owner.value);
  second.owner.set({ count: 11 });
  expect([firstProjection.read().count, secondProjection.read().count]).toEqual([2, 11]);
  expect(left.values).toEqual([1]);
  flush();
  expect([left.values, right.values, separateContract.values, separateOwner.values]).toEqual([
    [1, 2],
    [1, 2],
    [1, 2],
    [10, 11],
  ]);

  left.dispose();
  flush();
  expect(first.release).not.toHaveBeenCalled();
  right.dispose();
  flush();
  expect(first.release).toHaveBeenCalledOnce();
  separateContract.dispose();
  separateOwner.dispose();
  flush();
  expect(first.release).toHaveBeenCalledTimes(2);
  expect(second.release).toHaveBeenCalledOnce();
  first.owner.set({ count: 3 });
  expect(firstProjection.read().count).toBe(3);
  expect(first.subscriptions).toHaveBeenCalledTimes(2);
  const reconnected = observe(() => shared(first.owner).read().count);
  expect(reconnected.values).toEqual([3]);
  expect(shared(first.owner)).toBe(firstProjection);
  expect(first.subscriptions).toHaveBeenCalledTimes(3);
});
