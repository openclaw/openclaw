/* @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import {
  createTooltip,
  dispatchMousePointer,
  focusTrigger,
  hoverTrigger,
  settleTooltip,
  tooltipSurface,
} from "./tooltip.test-support.ts";

const view = vi.hoisted(() => {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  return { ready, resolve, started: vi.fn() };
});

vi.mock("./solid/tooltip.tsx", async (importOriginal) => {
  view.started();
  await view.ready;
  return { ...(await importOriginal<typeof import("./solid/tooltip.tsx")>()) };
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

it("loads on reveal, keeps cold content hidden, and never replays canceled or superseded intent", async () => {
  vi.useFakeTimers();
  const escaped = createTooltip("Escape details");
  const left = createTooltip("Leave details");
  const removed = createTooltip("Removed details");
  const toggled = createTooltip("Toggle details");
  const superseded = createTooltip("Superseded details");
  const current = createTooltip("Current details");
  const fixtures = [escaped, left, removed, toggled, superseded, current];
  document.body.append(...fixtures.map(({ tooltip }) => tooltip));
  await Promise.all(fixtures.map(({ tooltip }) => settleTooltip(tooltip)));
  expect(view.started).not.toHaveBeenCalled();
  expect(escaped.trigger.getAttribute("aria-describedby")).toBeTruthy();

  focusTrigger(escaped.trigger);
  expect(escaped.tooltip.hasAttribute("open")).toBe(false);
  expect(tooltipSurface(escaped.tooltip)?.querySelector(".tooltip-content")).toBeNull();
  const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  escaped.trigger.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);

  hoverTrigger(left.trigger);
  vi.advanceTimersByTime(150);
  dispatchMousePointer(left.trigger, "pointerleave");
  focusTrigger(removed.trigger);
  removed.tooltip.remove();
  toggled.tooltip.openOnClick = true;
  toggled.trigger.click();
  toggled.trigger.click();
  focusTrigger(superseded.trigger);
  focusTrigger(current.trigger);
  view.resolve();
  await vi.dynamicImportSettled();
  await Promise.all(fixtures.map(({ tooltip }) => settleTooltip(tooltip)));

  expect(view.started).toHaveBeenCalledOnce();
  for (const { tooltip } of fixtures.slice(0, -1)) {
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(tooltipSurface(tooltip)?.matches(":popover-open")).toBe(false);
  }
  expect(current.tooltip.hasAttribute("open")).toBe(true);
  expect(tooltipSurface(current.tooltip)?.querySelector(".tooltip-content")?.textContent).toBe(
    "Current details",
  );
});
