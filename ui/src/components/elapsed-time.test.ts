// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/solid-render.tsx";
import { ElapsedTime } from "./elapsed-time.tsx";

type Props = Parameters<typeof ElapsedTime>[0];
const NOW = 2_000_000_000;
beforeEach(async () => {
  await i18n.setLocale("en");
  vi.useFakeTimers({ now: NOW });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function mount(initial: Props) {
  let props = initial;
  const view = mountSolid(
    ElapsedTime,
    props,
    document.body.appendChild(document.createElement("div")),
  );
  onTestFinished(() => {
    view.dispose();
    view.container.remove();
  });
  return {
    element: view.container,
    label: () => view.container.textContent?.trim(),
    update(changes: Partial<Props>) {
      props = { ...props, ...changes };
      view.update(props);
    },
  };
}

it("changes minute labels only at their boundary and applies timing changes with an unchanged label", async () => {
  const view = mount({ minimumUnit: "minute", startMs: NOW - 65_000 });
  expect(view.label()).toBe("1m");
  const changed = vi.fn();
  const observer = new MutationObserver(changed);
  observer.observe(view.element, { characterData: true, childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  await vi.advanceTimersByTimeAsync(54_000);
  expect(view.label()).toBe("1m");
  expect(changed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(view.label()).toBe("2m");
  expect(changed).toHaveBeenCalledOnce();

  view.update({ endMs: Date.now() });
  changed.mockClear();
  await vi.advanceTimersByTimeAsync(61_000);
  expect(changed).not.toHaveBeenCalled();
  expect(view.label()).toBe("2m");
  view.update({ endMs: null });
  expect(view.label()).toBe("3m");
  view.update({ minimumUnit: "second" });
  expect(view.label()).toBe("3m 1s");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(view.label()).toBe("3m 2s");
});

it.each([
  [{ startMs: NOW - 60_000 }, "1m", "1m 0s"],
  [{ startMs: NOW - 3_665_000 }, "1h 1m", "1h 1m 5s"],
  [{ startMs: NOW - 61_000, singleUnit: true }, "1m", "1m"],
] satisfies [Props, string, string][])(
  "reacts to seconds formatting with %j",
  (props, compact, seconds) => {
    const view = mount({ ...props, endMs: NOW });
    expect(view.label()).toBe(compact);
    view.update({ includeSeconds: true });
    expect(view.label()).toBe(seconds);
    view.update({ includeSeconds: false });
    expect(view.label()).toBe(compact);
  },
);
