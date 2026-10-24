// @vitest-environment jsdom
import { For } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElapsedTime } from "../../components/elapsed-time.tsx";
import { RelativeTime } from "../../components/relative-time.tsx";
import "../../components/working-phrase-solid.tsx";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { flush } from "../../test-helpers/solid-settle.ts";

const NOW = 2_000_000_000;
const ROWS = Array.from({ length: 100 }, (_, index) => index);

function ClockRows(props: { running: boolean }) {
  return (
    <For each={ROWS}>
      {(index) => (
        <div>
          <ElapsedTime startMs={NOW} endMs={props.running ? null : NOW} />
          <ElapsedTime startMs={NOW - 5_000} endMs={NOW} />
          <RelativeTime timestampMs={props.running ? NOW - 60_000 : undefined} />
          <openclaw-working-phrase
            prop:startMs={props.running ? NOW - 30_000 : null}
            prop:seed={`clock-row-${index}`}
            prop:phrases={["First", "Second", "Third"]}
          />
        </div>
      )}
    </For>
  );
}

describe("shared visible presentation clocks", () => {
  let visibility: DocumentVisibilityState;
  const cleanups: Array<() => void> = [];
  const mount = <Props extends object>(
    Component: Parameters<typeof mountSolid<Props>>[0],
    props: Props,
  ) => {
    const container = document.body.appendChild(document.createElement("div"));
    const view = mountSolid(Component, props, container);
    cleanups.push(() => {
      view.dispose();
      container.remove();
    });
    return view;
  };
  const setVisibility = (next: DocumentVisibilityState) => {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
  };
  const settle = async () => {
    await Promise.resolve();
    flush();
    await Promise.resolve();
  };

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    visibility = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
    await settle();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("bounds timers for hundreds of rows, parks while hidden, and releases the final readers", async () => {
    const addListener = vi.spyOn(document, "addEventListener");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const view = mount(ClockRows, { running: true });
    await settle();
    expect(view.container.querySelectorAll("openclaw-elapsed-time")).toHaveLength(200);
    expect(view.container.querySelectorAll("time")).toHaveLength(100);
    expect(vi.getTimerCount()).toBe(2);
    expect(addListener.mock.calls.filter(([name]) => name === "visibilitychange")).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(view.container.querySelector("openclaw-elapsed-time")?.textContent).toBe("2s");
    const beforeHidden = view.container.textContent;
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(view.container.textContent).toBe(beforeHidden);

    setVisibility("visible");
    await settle();
    expect(vi.getTimerCount()).toBe(2);
    expect(view.container.querySelector("openclaw-elapsed-time")?.textContent).toBe("1m 2s");
    expect(view.container.querySelector("time")?.textContent).toBe("2m ago");
    setVisibility("visible");
    expect(vi.getTimerCount()).toBe(2);

    view.update({ running: false });
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener.mock.calls.filter(([name]) => name === "visibilitychange")).toHaveLength(
      2,
    );
    expect(view.container.querySelector("openclaw-elapsed-time")?.textContent).toBe("1s");
    expect(view.container.querySelector("time")).toBeNull();
  });

  it("samples a newly mounted reader between shared ticks and keeps its surviving sibling live", async () => {
    const first = mount(ElapsedTime, { startMs: NOW - 1_000 });
    await vi.advanceTimersByTimeAsync(750);
    const second = mount(ElapsedTime, { startMs: NOW - 1_500 });
    expect(second.container.textContent).toBe("2s");
    expect(vi.getTimerCount()).toBe(1);
    first.dispose();
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(second.container.textContent).toBe("3s");
    second.dispose();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("mounts hidden without scheduling and catches up when shown", async () => {
    visibility = "hidden";
    const view = mount(ElapsedTime, { startMs: NOW - 5_000 });
    expect(view.container.textContent).toBe("5s");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(view.container.textContent).toBe("5s");
    setVisibility("visible");
    expect(view.container.textContent).toBe("10s");
    expect(vi.getTimerCount()).toBe(1);
  });
});
