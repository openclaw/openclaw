// @vitest-environment node
import {
  createEffect,
  createRoot,
  createSignal,
  flush,
  isPending,
  latest,
  untrack,
} from "@solidjs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValueSignal } from "../board/provider-signals.ts";
import { projectCallbackOwner } from "./callback-owner.ts";
import { projectMutableSource, projectSource } from "./projection.ts";

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
  return {
    values,
    dispose,
    check: (...expected: T[]) => {
      flush();
      expect(values).toEqual(expected);
    },
  };
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
  it.each(["mutable", "callback"])("adapts %s owners across reconnect and disposal", (kind) => {
    const state = { value: 1 };
    let notify = () => {};
    const mutable =
      kind === "mutable" ? projectMutableSource(state, (current) => current.value) : undefined;
    const view =
      mutable ??
      projectCallbackOwner(
        (publish) => {
          notify = publish;
          return state;
        },
        (current) => current.value,
      ).view;
    const set = (value: number) => {
      state.value = value;
      if (mutable) {
        mutable.publish();
      } else {
        notify();
      }
    };
    disposals.push(view.dispose);
    set(2);
    expect([view.read(), view.revision()]).toEqual([2, 0]);
    const first = observe(view.read);
    set(3);
    expect(view.read()).toBe(3);
    expect(first.values).toEqual([2]);
    first.check(2, 3);
    first.dispose();
    flush();
    set(4);
    const reconnected = observe(view.read);
    reconnected.check(4);
    view.dispose();
    set(5);
    reconnected.check(4);
    expect(view.read()).toBe(4);
  });

  it.each([
    { name: "pending", probe: isPending },
    { name: "latest", probe: latest },
  ])("releases an untracked $name probe after settlement", ({ probe }) => {
    const { projection, subscribe, stops } = source(1);
    createRoot((stop) => {
      untrack(() => probe(projection.read));
      stop();
    });
    flush();
    expect(stops).toHaveBeenCalledTimes(subscribe.mock.calls.length);
    observe(projection.read).dispose();
    flush();
    expect(stops).toHaveBeenCalledTimes(subscribe.mock.calls.length);
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

  it("samples reactive owner getters only when their owner publishes", () => {
    const [value, setValue] = createSignal(1);
    const owner = new ValueSignal(0);
    const projection = projectSource(owner, {
      read: value,
      subscribe: (current, notify) => current.subscribe(notify),
      equality: "revision",
    });
    disposals.push(projection.dispose);
    const view = observe(projection.read);
    setValue(2);
    view.check(1);
    owner.set(1);
    view.check(1, 2);
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
    view.check(1, 7);
    replacement.set(8);
    view.check(1, 7, 8);
    projection.dispose();
    replacement.set(9);
    flush();
    expect(projection.read()).toBe(8);
    expect(view.values).toEqual([1, 7, 8]);
  });

  it("cancels a pending revision increment when disposed before the next flush", () => {
    const { owner, projection, stops } = source(1);
    observe(projection.read);
    owner.set(2);
    projection.dispose();
    flush();
    expect(projection.revision()).toBe(0);
    expect(projection.read()).toBe(2);
    expect(stops).toHaveBeenCalledOnce();
  });
});
