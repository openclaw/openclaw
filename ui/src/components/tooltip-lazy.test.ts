/* @vitest-environment jsdom */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeTooltipContent } from "./tooltip-mutations.ts";
import {
  createTooltip,
  element,
  dispatchMousePointer,
  hoverTrigger,
  settleTooltip,
  tooltipSurface,
  type TooltipElement,
} from "./tooltip.test-support.ts";

const content = (tooltip: TooltipElement) =>
  tooltipSurface(tooltip)?.querySelector(".tooltip-content");
const description = (trigger: HTMLElement) =>
  document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function trackContentObservers() {
  const NativeObserver = MutationObserver;
  const observers = new Set<{ targets: Map<Node, MutationObserverInit | undefined> }>();
  vi.stubGlobal(
    "MutationObserver",
    class extends NativeObserver {
      readonly targets = new Map<Node, MutationObserverInit | undefined>();
      constructor(callback: MutationCallback) {
        super(callback);
        observers.add(this);
      }
      override observe(target: Node, options?: MutationObserverInit) {
        super.observe(target, options);
        this.targets.set(target, options);
      }
      override disconnect() {
        super.disconnect();
        this.targets.clear();
      }
    },
  );
  return observers;
}

it("shares closed tooltip observation across light and shadow DOM and releases retired targets", async () => {
  const observers = trackContentObservers();
  const fixtures = Array.from({ length: 100 }, (_, index) => createTooltip(`Hint ${index}`));
  const shadowHost = document.createElement("div");
  const shadow = shadowHost.attachShadow({ mode: "open" });
  document.body.append(shadowHost, ...fixtures.slice(0, 50).map(({ tooltip }) => tooltip));
  shadow.append(...fixtures.slice(50).map(({ tooltip }) => tooltip));
  await Promise.all(fixtures.map(({ tooltip }) => settleTooltip(tooltip)));
  expect(observers.size).toBe(1);
  expect([...observers].filter((activeObserver) => activeObserver.targets.size > 0)).toHaveLength(
    1,
  );
  const observer = [...observers][0]!;
  for (const [index, { tooltip, trigger }] of fixtures.entries()) {
    expect(observer.targets.get(tooltip)).toEqual({
      childList: true,
      characterData: false,
      subtree: false,
    });
    expect(observer.targets.has(trigger)).toBe(false);
    const root = trigger.getRootNode();
    const id = trigger.getAttribute("aria-describedby")!;
    expect((root instanceof ShadowRoot ? root : document).getElementById(id)?.textContent).toBe(
      `Hint ${index}`,
    );
  }

  const first = fixtures[0]!;
  const replacement = element("button", { textContent: "Replacement" });
  first.tooltip.replaceChildren(replacement);
  first.trigger.textContent = "Retired trigger changed in the same commit";
  await settleTooltip(first.tooltip);
  expect(first.trigger.hasAttribute("aria-describedby")).toBe(false);
  expect(description(replacement)).toBe("Hint 0");
  first.tooltip.remove();
  await Promise.resolve();
  expect(replacement.hasAttribute("aria-describedby")).toBe(false);
  expect([...observers].filter((activeObserver) => activeObserver.targets.size > 0)).toHaveLength(
    1,
  );
  expect(observers.size).toBe(1);

  document.body.replaceChildren();
  await Promise.resolve();
  expect([...observers].every((activeObserver) => activeObserver.targets.size === 0)).toBe(true);
});

it("watches changing description resolvers only while they own a descendant", async () => {
  const observers = trackContentObservers();
  const original = element("button", { textContent: "Original" });
  original.setAttribute("aria-describedby", "original-description");
  const wrapper = element("span", {}, original);
  const tooltip = element("openclaw-tooltip", { content: "Details" }, wrapper);
  document.body.append(tooltip);
  const watchesWrapper = () => [...observers].some((observer) => observer.targets.has(wrapper));
  await settleTooltip(tooltip);
  expect(watchesWrapper()).toBe(false);
  expect(description(wrapper)).toBe("Details");
  expect(original.getAttribute("aria-describedby")).toBe("original-description");

  let target = original;
  tooltip.descriptionTarget = () => target;
  await settleTooltip(tooltip);
  expect(watchesWrapper()).toBe(true);
  expect(wrapper.hasAttribute("aria-describedby")).toBe(false);
  expect(original.getAttribute("aria-describedby")).toMatch(
    /^original-description openclaw-tooltip-/,
  );

  target = element("button", { textContent: "Replacement" });
  target.setAttribute("aria-describedby", "replacement-description");
  wrapper.replaceChildren(target);
  await settleTooltip(tooltip);
  expect(original.getAttribute("aria-describedby")).toBe("original-description");
  expect(target.getAttribute("aria-describedby")).toMatch(
    /^replacement-description openclaw-tooltip-/,
  );

  tooltip.descriptionTarget = undefined;
  await settleTooltip(tooltip);
  expect(watchesWrapper()).toBe(false);
  expect(target.getAttribute("aria-describedby")).toBe("replacement-description");
  expect(description(wrapper)).toBe("Details");
});

it("routes tooltip content through nested targets and fresh parents between batches", async () => {
  const first = element("section");
  const second = element("section");
  const gap = element("div");
  const inner = element("span");
  const text = document.createTextNode("Initial");
  inner.append(text);
  gap.append(inner);
  first.append(gap);
  document.body.append(first, second);
  const calls: string[] = [];
  const stops = [
    observeTooltipContent(document, [first], () => calls.push("first"), { characterData: true }),
    observeTooltipContent(document, [second], () => calls.push("second"), { characterData: true }),
    observeTooltipContent(document, [inner], () => calls.push("inner"), {
      subtree: false,
      characterData: true,
    }),
    observeTooltipContent(document, [text], () => calls.push("text"), { characterData: true }),
  ];
  try {
    text.data = "First parent";
    await Promise.resolve();
    expect(calls).toEqual(["text", "first"]);

    second.append(gap);
    await Promise.resolve();
    calls.length = 0;
    text.data = "Second parent";
    await Promise.resolve();
    expect(calls).toEqual(["text", "second"]);

    calls.length = 0;
    inner.append(document.createElement("b"));
    await Promise.resolve();
    expect(calls).toEqual(["inner", "second"]);
  } finally {
    stops.forEach((stop) => stop());
  }
});

it("materializes content on first hover intent and reuses the native surface", async () => {
  const { tooltip, trigger } = createTooltip("Hover details");
  const untouched = createTooltip("Untouched details");
  document.body.append(tooltip, untouched.tooltip);
  await Promise.all([settleTooltip(tooltip), settleTooltip(untouched.tooltip)]);
  const descriptionId = trigger.getAttribute("aria-describedby")!;
  expect(document.getElementById(descriptionId)?.textContent).toBe("Hover details");
  const popup = tooltipSurface(tooltip)!;
  expect(popup.querySelector(".tooltip-content")).toBeNull();
  hoverTrigger(trigger);
  vi.advanceTimersByTime(149);
  expect(popup.querySelector(".tooltip-content")).toBeNull();
  vi.advanceTimersByTime(1);
  await settleTooltip(tooltip);
  expect(tooltip.hasAttribute("open")).toBe(true);
  expect(popup.matches(":popover-open")).toBe(true);
  expect(popup.querySelector(".tooltip-content")?.textContent).toBe("Hover details");
  expect(content(untouched.tooltip)).toBeNull();
  expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
  dispatchMousePointer(trigger, "pointerleave");
  expect(popup.matches(":popover-open")).toBe(false);
  hoverTrigger(trigger);
  vi.advanceTimersByTime(150);
  await settleTooltip(tooltip);
  expect(tooltipSurface(tooltip)).toBe(popup);
  expect(popup.matches(":popover-open")).toBe(true);
  expect(trigger.getAttribute("aria-describedby")).toBe(descriptionId);
});

it("previews focus intent before the first commit", async () => {
  const tooltip = document.createElement("openclaw-tooltip");
  const anchor = element("button", { textContent: "Preview" });
  document.body.append(anchor, tooltip);
  tooltip.previewForAnchor(anchor, "Preview details", "focus");
  expect(tooltip.hasAttribute("open")).toBe(false);
  await settleTooltip(tooltip);
  expect(tooltipSurface(tooltip)?.matches(":popover-open")).toBe(true);
  expect(content(tooltip)?.textContent).toBe("Preview details");
  expect(description(anchor)).toBe("Preview details");
});

it.each(["open", "veto"] as const)(
  "preserves %s intent during first content materialization",
  async (outcome) => {
    const { tooltip, trigger } = createTooltip("Details");
    tooltip.openOnClick = true;
    document.body.append(tooltip);
    await settleTooltip(tooltip);
    if (outcome === "veto") {
      tooltip.addEventListener("overlay-show", (event) => event.preventDefault(), { once: true });
    }
    trigger.click();
    await settleTooltip(tooltip);
    expect(tooltip.hasAttribute("open")).toBe(outcome === "open");
    expect(tooltipSurface(tooltip)?.matches(":popover-open") ?? false).toBe(outcome === "open");
  },
);
