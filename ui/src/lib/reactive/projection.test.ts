// @vitest-environment node
import { createEffect, createRoot, flush, isPending, latest, untrack } from "@solidjs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValueSignal } from "../board/provider-signals.ts";
import { projectSource } from "./projection.ts";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0).toReversed()) {
    dispose();
  }
  flush();
});

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

function source<T>(value: T, equality: "revision" | ((a: T, b: T) => boolean) = "revision") {
  const owner = new ValueSignal(value);
  const subscribe = vi.spyOn(owner, "subscribe");
  const stops = vi.fn();
  const projection = projectSource(owner, {
    read: (current) => current.value,
    subscribe: (current, notify) => {
      const stop = current.subscribe(notify);
      return () => {
        stops();
        stop();
      };
    },
    equality,
  });
  disposals.push(projection.dispose);
  return { owner, projection, subscribe, stops };
}

describe("owner projections", () => {
  it.each([
    { name: "pending", probe: isPending },
    { name: "latest", probe: latest },
  ])("releases an untracked $name probe after settlement", ({ probe }) => {
    const { owner, projection, subscribe, stops } = source(1);
    createRoot((stop) => {
      untrack(() => probe(projection.read));
      stop();
    });
    flush();
    expect(stops).toHaveBeenCalledTimes(subscribe.mock.calls.length);
    const view = observe(projection.read);
    const acquisitions = subscribe.mock.calls.length;
    owner.set(2);
    flush();
    expect(view.values).toEqual([1, 2]);
    expect(subscribe).toHaveBeenCalledTimes(acquisitions);
    view.dispose();
    flush();
    expect(stops).toHaveBeenCalledTimes(acquisitions);
  });

  it("reads current state without acquiring and shares first/last observer acquisition", () => {
    const { owner, projection, subscribe, stops } = source(1);
    expect(projection.read()).toBe(1);
    expect(subscribe).not.toHaveBeenCalled();
    owner.set(2);
    const first = observe(projection.read);
    const second = observe(projection.read);
    expect(first.values).toEqual([2]);
    expect(second.values).toEqual([2]);
    expect(subscribe).toHaveBeenCalledTimes(1);
    first.dispose();
    flush();
    expect(stops).not.toHaveBeenCalled();
    second.dispose();
    flush();
    expect(stops).toHaveBeenCalledTimes(1);
    owner.set(3);
    expect(observe(projection.read).values).toEqual([3]);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  it("publishes in-place mutations by revision, while owner reads remain synchronous", () => {
    const { owner, projection } = source({ count: 1 });
    const view = observe(() => projection.read().count);
    owner.value.count = 2;
    owner.set(owner.value);
    expect(projection.read().count).toBe(2);
    expect(view.values).toEqual([1]);
    flush();
    expect(view.values).toEqual([1, 2]);
    expect(projection.revision()).toBe(1);
  });

  it("honors value equality without suppressing revision-only snapshots", () => {
    const { owner, projection } = source<string>("same", Object.is);
    const listener = vi.fn();
    disposals.push(projection.subscribe(listener));
    owner.set("same");
    expect(listener).not.toHaveBeenCalled();
    owner.set("changed");
    expect(listener).toHaveBeenCalledOnce();
    expect(projection.read()).toBe("changed");
  });

  it("replaces sources immediately and detaches the old owner", () => {
    const { owner, projection, stops } = source(1);
    const view = observe(projection.read);
    const replacement = new ValueSignal(7);
    projection.replaceSource(replacement);
    expect(stops).toHaveBeenCalledOnce();
    owner.set(3);
    flush();
    expect(view.values).toEqual([1, 7]);
    replacement.set(8);
    flush();
    expect(view.values).toEqual([1, 7, 8]);
    projection.dispose();
    replacement.set(9);
    flush();
    expect(projection.read()).toBe(8);
    expect(view.values).toEqual([1, 7, 8]);
  });

  it("shares acquisition with explicit subscribers and counts duplicate callbacks separately", () => {
    const { owner, projection, subscribe, stops } = source(1);
    const listener = vi.fn();
    const stopFirst = projection.subscribe(listener);
    const stopSecond = projection.subscribe(listener);
    const view = observe(projection.read);
    expect(subscribe).toHaveBeenCalledOnce();
    stopFirst();
    owner.set(2);
    expect(listener).toHaveBeenCalledOnce();
    stopSecond();
    expect(stops).not.toHaveBeenCalled();
    view.dispose();
    flush();
    expect(stops).toHaveBeenCalledOnce();
  });
});
