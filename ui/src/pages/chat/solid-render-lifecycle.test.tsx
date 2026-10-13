import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ValueSignal } from "../../lib/board/provider-signals.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { createSolidRenderLifecycle, type SolidRenderLifecycle } from "./solid-render-lifecycle.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mountPane(
  initiallyPresented = true,
  onCreate?: (lifecycle: SolidRenderLifecycle<{ text: string }>) => void,
) {
  const source = new ValueSignal({ text: "initial" });
  const subscribe = vi.spyOn(source, "subscribe");
  const release = vi.fn();
  const read = vi.fn();
  let lifecycle!: SolidRenderLifecycle<{ text: string }>;
  let present!: (value: boolean) => void;
  const view = render(() => {
    const [presented, setPresented] = createSignal(initiallyPresented);
    present = setPresented;
    const projection = projectSource(source, {
      read: (owner) => owner.value,
      subscribe: (owner, notify) => {
        const stop = owner.subscribe(notify);
        return () => {
          release();
          stop();
        };
      },
      equality: "revision",
    });
    lifecycle = createSolidRenderLifecycle({
      host: source,
      presented,
      read: () => {
        read();
        // Presentation owns this immutable view; the domain object stays mutable.
        return { text: projection.read().text };
      },
    });
    onCreate?.(lifecycle);
    return <output>{lifecycle.snapshot().text}</output>;
  });
  flush();
  return { source, subscribe, release, read, lifecycle, present, view };
}

function frames() {
  let id = 0;
  const pending = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    pending.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => pending.delete(key));
  return {
    pending,
    run() {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const callback of callbacks) {
        callback(0);
      }
    },
  };
}

it.each(["afterCommit", "afterLayout"] as const)(
  "accepts %s registration during component setup",
  (method) => {
    const clock = frames();
    const observed: Array<string | null | undefined> = [];
    mountPane(true, (lifecycle) => {
      lifecycle[method](() => {
        observed.push(document.querySelector("output")?.textContent);
      });
    });
    clock.run();
    expect(observed).toEqual(["initial"]);
  },
);

it.each(["afterCommit", "afterLayout"] as const)(
  "releases %s resources when deferred work completes",
  (method) => {
    const clock = frames();
    const { lifecycle, view } = mountPane();
    const release = vi.fn();
    let complete!: () => void;
    const cancel = lifecycle[method]((done) => {
      complete = done;
      return release;
    });
    flush();
    clock.run();
    expect(release).not.toHaveBeenCalled();
    complete();
    complete();
    cancel();
    view.unmount();
    expect(release).toHaveBeenCalledOnce();
  },
);

it("runs batched callbacks after their DOM commit and fences reentrant requests", () => {
  const { source, view, lifecycle } = mountPane();
  const observed: Array<[string | null, number]> = [];
  const before = lifecycle.commitGeneration;
  source.set({ text: "committed" });
  lifecycle.afterCommit(() => {
    observed.push([view.container.textContent, lifecycle.commitGeneration]);
    source.set({ text: "next commit" });
    lifecycle.afterCommit(() => {
      observed.push([view.container.textContent, lifecycle.commitGeneration]);
    });
  });
  lifecycle.afterCommit(() => {
    observed.push([view.container.textContent, lifecycle.commitGeneration]);
  });
  expect(observed).toEqual([]);
  flush();
  expect(observed).toEqual([
    ["committed", before + 1],
    ["committed", before + 1],
    ["next commit", before + 2],
  ]);
});

it.each([true, false])(
  "parks source reads and preserves DOM (initially presented: %s)",
  (shown) => {
    const { source, subscribe, release, view, lifecycle, present, read } = mountPane(shown);
    const output = view.container.querySelector("output");
    expect(view.container.textContent).toBe("initial");
    if (!shown) {
      expect(subscribe).not.toHaveBeenCalled();
    }
    present(false);
    flush();
    expect(release).toHaveBeenCalledTimes(shown ? 1 : 0);
    const reads = read.mock.calls.length;
    const generation = lifecycle.commitGeneration;
    const committed = vi.fn();
    lifecycle.afterCommit(committed);
    for (let count = 0; count < 5; count += 1) {
      source.value.text = `hidden ${count}`;
      source.set(source.value);
      lifecycle.invalidate();
      flush();
    }
    expect(read).toHaveBeenCalledTimes(reads);
    expect(lifecycle.commitGeneration).toBe(generation);
    expect(committed).not.toHaveBeenCalled();
    expect(view.container.textContent).toBe("initial");
    present(true);
    flush();
    expect(read).toHaveBeenCalledTimes(reads + 1);
    expect(view.container.textContent).toBe("hidden 4");
    expect(view.container.querySelector("output")).toBe(output);
    expect(lifecycle.commitGeneration).toBe(generation + 1);
    expect(committed).toHaveBeenCalledOnce();
    view.unmount();
    const retiredReads = read.mock.calls.length;
    source.set({ text: "retired" });
    flush();
    expect(read).toHaveBeenCalledTimes(retiredReads);
  },
);

it("owns deferred cleanup until completion, cancellation, parking, or disposal", () => {
  const { lifecycle, present, view } = mountPane();
  const cancelled = vi.fn();
  const neverRun = vi.fn();
  const cancel = lifecycle.afterCommit(neverRun, cancelled);
  cancel();
  cancel();
  flush();
  expect(cancelled).toHaveBeenCalledOnce();
  expect(neverRun).not.toHaveBeenCalled();

  const finished = vi.fn();
  lifecycle.afterCommit((complete) => {
    complete();
    return finished;
  });
  const parked = vi.fn();
  lifecycle.afterCommit(() => parked);
  flush();
  expect(finished).toHaveBeenCalledOnce();
  expect(parked).not.toHaveBeenCalled();
  present(false);
  flush();
  expect(parked).toHaveBeenCalledOnce();

  lifecycle.afterCommit(neverRun, cancelled);
  view.unmount();
  lifecycle.invalidate();
  lifecycle.afterCommit(neverRun, cancelled);
  flush();
  expect(cancelled).toHaveBeenCalledTimes(3);
  expect(neverRun).not.toHaveBeenCalled();
  expect(finished).toHaveBeenCalledOnce();
  expect(parked).toHaveBeenCalledOnce();
});

it("separates layout from commit and resumes parked layout requests after reveal", () => {
  const clock = frames();
  const { source, lifecycle, present, view } = mountPane();
  const observed: string[] = [];
  source.set({ text: "layout" });
  lifecycle.afterCommit(() => {
    observed.push(`commit: ${view.container.textContent}`);
  });
  lifecycle.afterLayout(() => {
    observed.push(`layout: ${view.container.textContent}`);
  });
  flush();
  expect(observed).toEqual(["commit: layout"]);
  expect(clock.pending.size).toBe(1);
  present(false);
  flush();
  expect(clock.pending.size).toBe(0);
  clock.run();
  expect(observed).toEqual(["commit: layout"]);
  present(true);
  flush();
  clock.run();
  expect(observed).toEqual(["commit: layout", "layout: layout"]);

  const layoutCleanup = vi.fn();
  lifecycle.afterLayout(() => layoutCleanup);
  flush();
  clock.run();
  view.unmount();
  expect(layoutCleanup).toHaveBeenCalledOnce();
  expect(clock.pending.size).toBe(0);
});
