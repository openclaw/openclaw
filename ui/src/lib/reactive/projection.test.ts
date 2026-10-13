// @vitest-environment node
import { createEffect, createRoot, flush, isPending, latest, untrack } from "@solidjs/signals";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStream, ValueSignal } from "../board/provider-signals.ts";
import { projectAsyncEvents, projectEvents, projectSource } from "./projection.ts";

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

  it("replaces sources immediately and rejects stale callback deliveries", () => {
    const { owner, projection, subscribe, stops } = source(1);
    const view = observe(projection.read);
    const stale = subscribe.mock.calls[0]![0];
    const replacement = new ValueSignal(7);
    projection.replaceSource(replacement);
    expect(stops).toHaveBeenCalledOnce();
    owner.set(3);
    stale();
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

  it("releases subscriptions on parent disposal and handles disposal during acquisition", () => {
    const owner = new ValueSignal(1);
    const stop = vi.fn();
    const dispose = createRoot((disposeRoot) => {
      const projection = projectSource(owner, {
        read: (current) => current.value,
        subscribe: (_current, notify) => {
          notify();
          return stop;
        },
        equality: "revision",
      });
      projection.subscribe(() => projection.dispose());
      return disposeRoot;
    });
    expect(stop).toHaveBeenCalledOnce();
    dispose();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("event projections", () => {
  it("keeps incidental void-listener return values synchronous", async () => {
    let deliver: (() => void | Promise<void>) | undefined;
    const projection = projectEvents<undefined, void>(undefined, {
      subscribe: (_source, listener) => {
        deliver = () => listener();
        return () => {};
      },
    });
    disposals.push(projection.dispose);
    const events: string[] = [];
    projection.subscribe(() => events.push("delivered"));
    projection.subscribe(() => {
      throw new Error("synchronous consumer");
    });
    let result: void | Promise<void> = undefined;
    let failure: unknown;
    try {
      result = deliver!();
    } catch (error) {
      failure = error;
    }
    await Promise.resolve(result).catch(() => {});
    expect(events).toEqual(["delivered"]);
    expect(failure).toEqual(new Error("synchronous consumer"));
  });

  it("delivers equal events in order and fences replaced/disposed sources", () => {
    const owner = new EventStream<string>();
    const replacement = new EventStream<string>();
    const subscribe = vi.spyOn(owner, "subscribe");
    const projection = projectEvents(owner, {
      subscribe: (current, listener: (event: string) => void) => current.subscribe(listener),
    });
    disposals.push(projection.dispose);
    expect(subscribe).not.toHaveBeenCalled();
    const events: string[] = [];
    const stop = projection.subscribe((event) => {
      events.push(event);
    });
    owner.emit("same");
    owner.emit("same");
    const stale = subscribe.mock.calls[0]![0];
    projection.replaceSource(replacement);
    stale("old");
    replacement.emit("new");
    stop();
    replacement.emit("unobserved");
    const last = projection.subscribe((event) => {
      events.push(event);
    });
    expect(events).toEqual(["same", "same", "new"]);
    replacement.emit("resumed");
    projection.dispose();
    replacement.emit("disposed");
    last();
    expect(events).toEqual(["same", "same", "new", "resumed"]);
  });

  it.each(["sync", "async"])(
    "preserves awaited event completion after a %s rejection",
    async (kind) => {
      let deliver: ((event: string) => void | Promise<void>) | undefined;
      const projection = projectAsyncEvents(
        {},
        {
          subscribe: (_source, listener: (event: string) => void | Promise<void>) => {
            deliver = listener;
            return () => {};
          },
        },
      );
      disposals.push(projection.dispose);
      let complete: (() => void) | undefined;
      projection.subscribe(
        () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          }),
      );
      const settled = vi.fn();
      const pending = Promise.resolve(deliver!("event")).then(settled);
      await Promise.resolve();
      expect(settled).not.toHaveBeenCalled();
      complete!();
      await pending;
      expect(settled).toHaveBeenCalledOnce();
      projection.subscribe(() => {
        if (kind === "sync") {
          throw new Error("consumer failed");
        }
        return Promise.reject(new Error("consumer failed"));
      });
      const last = vi.fn();
      projection.subscribe(last);
      const failure = deliver!("event");
      expect(last).toHaveBeenCalledOnce();
      const rejected = vi.fn();
      const outcome = Promise.resolve(failure).catch((error: unknown) => {
        rejected();
        return error;
      });
      // Drain the rejected consumer's promise chain while its sibling stays pending.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(rejected).not.toHaveBeenCalled();
      complete!();
      expect(await outcome).toEqual(new Error("consumer failed"));
    },
  );
});
