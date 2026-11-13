import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ValueSignal } from "../../lib/board/provider-signals.ts";
import { projectSource } from "../../lib/reactive/projection.ts";
import { createSolidRenderLifecycle, type SolidRenderLifecycle } from "./solid-render-lifecycle.ts";

afterEach(cleanup);

const calls = (...spies: { mock: { calls: unknown[][] } }[]) =>
  spies.map((spy) => spy.mock.calls.length);

function mountPane(
  initiallyPresented = true,
  onCreate?: (lifecycle: SolidRenderLifecycle<{ text: string }>) => void,
) {
  const source = new ValueSignal({ text: "initial" });
  const subscribe = vi.spyOn(source, "subscribe");
  const release = vi.fn((stop: () => void) => stop());
  const read = vi.fn((value: { text: string }) => ({ text: value.text }));
  let lifecycle!: SolidRenderLifecycle<{ text: string }>;
  let present!: (value: boolean) => void;
  const view = render(() => {
    const [presented, setPresented] = createSignal(initiallyPresented);
    present = setPresented;
    const projection = projectSource(source, {
      read: (owner) => owner.value,
      subscribe: (owner, notify) => {
        const stop = owner.subscribe(notify);
        return () => release(stop);
      },
      equality: "revision",
    });
    lifecycle = createSolidRenderLifecycle({
      host: source,
      presented,
      read: () => read(projection.read()),
    });
    onCreate?.(lifecycle);
    return <output>{lifecycle.snapshot().text}</output>;
  });
  flush();
  return { source, subscribe, release, read, lifecycle, present, view };
}

it("accepts after-commit registration during component setup", () => {
  const observed: Array<string | null | undefined> = [];
  mountPane(true, (lifecycle) => {
    lifecycle.afterCommit(() => void observed.push(document.querySelector("output")?.textContent));
  });
  expect(observed).toEqual(["initial"]);
});

it("releases after-commit resources when deferred work completes", () => {
  const { lifecycle, view } = mountPane();
  const release = vi.fn();
  let complete!: () => void;
  const cancel = lifecycle.afterCommit((done) => {
    complete = done;
    return release;
  });
  flush();
  expect(release).not.toHaveBeenCalled();
  complete();
  complete();
  cancel();
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});

it("runs batched callbacks after their DOM commit and fences reentrant requests", () => {
  const { source, view, lifecycle } = mountPane();
  const observed: Array<string | null> = [];
  source.set({ text: "committed" });
  lifecycle.afterCommit(() => {
    observed.push(view.container.textContent);
    source.set({ text: "next commit" });
    lifecycle.afterCommit(() => void observed.push(view.container.textContent));
  });
  lifecycle.afterCommit(() => void observed.push(view.container.textContent));
  expect(observed).toEqual([]);
  flush();
  expect(observed).toEqual(["committed", "committed", "next commit"]);
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
    const committed = vi.fn();
    lifecycle.afterCommit(committed);
    for (let count = 0; count < 5; count += 1) {
      source.value.text = `hidden ${count}`;
      source.set(source.value);
      lifecycle.invalidate();
      flush();
    }
    expect(calls(read, committed)).toEqual([reads, 0]);
    expect(view.container.textContent).toBe("initial");
    present(true);
    flush();
    expect(calls(read, committed)).toEqual([reads + 1, 1]);
    expect(view.container.textContent).toBe("hidden 4");
    expect(view.container.querySelector("output")).toBe(output);
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
  expect(calls(cancelled, neverRun)).toEqual([1, 0]);

  const finished = vi.fn();
  lifecycle.afterCommit((complete) => {
    complete();
    return finished;
  });
  const parked = vi.fn();
  lifecycle.afterCommit(() => parked);
  flush();
  expect(calls(finished, parked)).toEqual([1, 0]);
  present(false);
  flush();
  expect(parked).toHaveBeenCalledOnce();

  lifecycle.afterCommit(neverRun, cancelled);
  view.unmount();
  lifecycle.invalidate();
  lifecycle.afterCommit(neverRun, cancelled);
  flush();
  expect(calls(cancelled, neverRun, finished, parked)).toEqual([3, 0, 1, 1]);
});
