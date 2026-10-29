import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { element, expectSharedTooltipSkin } from "./tooltip.test-support.ts";
import { focusWithoutTooltip, type TooltipElement } from "./tooltip.ts";
import "../styles/base.css";

afterEach(() => document.body.replaceChildren());

type TooltipOperation = "show" | "hide";
const tooltipEvents = {
  opening: "overlay-show",
  closing: "overlay-hide",
  opened: "overlay-after-show",
  closed: "overlay-after-hide",
} as const;

function requestPhase(operation: TooltipOperation) {
  return operation === "show" ? "opening" : "closing";
}

function completionPhase(operation: TooltipOperation) {
  return operation === "show" ? "opened" : "closed";
}

function recordLifecycle(tooltip: HTMLElement) {
  const events: string[] = [];
  for (const [phase, type] of Object.entries(tooltipEvents)) {
    tooltip.addEventListener(type, (event) => {
      if (event.target === tooltip) {
        events.push(phase);
      }
    });
  }
  return events;
}

function afterPhase(tooltip: HTMLElement, phase: keyof typeof tooltipEvents) {
  return new Promise<void>((resolve) => {
    tooltip.addEventListener(tooltipEvents[phase], () => resolve(), { once: true });
  });
}

async function commitTooltip(tooltip: TooltipElement) {
  await tooltip.updateComplete;
  await Promise.resolve();
  flush();
}

function tooltipBody(tooltip: TooltipElement) {
  const body = tooltip.shadowRoot?.querySelector<HTMLElement>(".tooltip-surface");
  if (!body) {
    throw new Error("Tooltip did not mount its native surface");
  }
  return body;
}

async function fixture(props: Partial<TooltipElement> = {}, rich?: HTMLElement) {
  const host = document.createElement("div");
  const tooltip = element("openclaw-tooltip", {
    content: "More information about this action",
    delay: 0,
    ...props,
  });
  const trigger = element("button", { textContent: "Details" });
  trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
  trigger.setAttribute("aria-describedby", "original-description");
  tooltip.append(trigger);
  if (rich) {
    tooltip.append(rich);
  }
  host.append(tooltip);
  document.body.append(host);
  await commitTooltip(tooltip);
  return { host, tooltip, trigger, events: recordLifecycle(tooltip) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function requestVisibility(f: Fixture, operation: TooltipOperation) {
  // Fresh focus also retries a vetoed request whose trigger stayed focused.
  f.trigger.blur();
  if (operation === "show") {
    f.trigger.focus();
  }
}

async function changeVisibility(
  f: Fixture,
  operation: TooltipOperation,
  action: () => void | Promise<void> = () => requestVisibility(f, operation),
) {
  const done = afterPhase(f.tooltip, completionPhase(operation));
  await action();
  await done;
}

const openTooltip = (f: Fixture) => changeVisibility(f, "show");

async function expectVisibility(f: Fixture, open: boolean, events?: string[]) {
  const body = tooltipBody(f.tooltip);
  expect(f.tooltip.hasAttribute("open")).toBe(open);
  expect(body.matches(":popover-open")).toBe(open);
  expect(body.dataset.phase).toBe(open ? "open" : "hidden");
  expect(body.inert).toBe(!open);
  if (open) {
    await expect.element(body).toBeVisible();
  } else {
    await expect.element(body).not.toBeVisible();
  }
  if (events) {
    expect(f.events).toEqual(events);
  }
}

function vetoNextTransition(f: Fixture, operation: TooltipOperation) {
  f.tooltip.addEventListener(
    tooltipEvents[requestPhase(operation)],
    (event) => event.preventDefault(),
    { once: true },
  );
}

function frame() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function withoutTooltipMotion(f: Fixture) {
  const body = tooltipBody(f.tooltip);
  body.style.setProperty("--openclaw-tooltip-popup-show-duration", "0ms");
  body.style.setProperty("--openclaw-tooltip-popup-hide-duration", "0ms");
}

function actionAt(bounds: Pick<DOMRect, "left" | "top" | "width" | "height">) {
  const action = element("button", { textContent: "Action" });
  action.style.cssText = `position: fixed; left: ${bounds.left}px; top: ${bounds.top}px; width: ${bounds.width}px; height: ${bounds.height}px`;
  document.body.append(action);
  return action;
}

function pointerDown(target: HTMLElement) {
  target.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
}

async function clickTarget(
  target: HTMLElement,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height"> = target.getBoundingClientRect(),
  preventDefault = false,
) {
  let activated = false;
  target.addEventListener(
    "click",
    (event) => {
      if (preventDefault) {
        event.preventDefault();
      }
      activated = true;
    },
    { once: true },
  );
  expect(
    document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2),
  ).toBe(target);
  const { page } = await import("vitest/browser");
  await page.elementLocator(target).click();
  expect(activated).toBe(true);
}

describe.runIf("__vitest_browser__" in globalThis)("tooltip browser ownership", () => {
  async function mountOpenTooltip(rich: boolean) {
    const link = rich
      ? element("a", { slot: "content", href: "#details", textContent: "Read documentation" })
      : undefined;
    const f = await fixture(rich ? { content: "" } : {}, link);
    await openTooltip(f);
    const body = tooltipBody(f.tooltip);
    await expect.poll(() => body.getBoundingClientRect().width).toBeGreaterThan(0);
    return { ...f, body, link };
  }

  it.each(["body", "bridge"] as const)("passes pointer input through %s", async (surface) => {
    const { body, trigger } = await mountOpenTooltip(false);
    const popupBounds = body.getBoundingClientRect();
    const triggerBounds = trigger.getBoundingClientRect();
    const bounds =
      surface === "body"
        ? popupBounds
        : {
            left: triggerBounds.left,
            top: popupBounds.bottom,
            width: triggerBounds.width,
            height: triggerBounds.top - popupBounds.bottom,
          };
    expect(bounds.height).toBeGreaterThan(0);
    await clickTarget(actionAt(bounds), bounds);
  });

  it("lets pointer input reach actions covered by a read-only rich tip", async () => {
    const card = element("div", {
      slot: "content",
      innerHTML: "<strong>CPU usage</strong><dl><dt>Main thread</dt><dd>12%</dd></dl>",
    });
    const f = await fixture({ pointerThrough: true }, card);
    await openTooltip(f);
    const body = tooltipBody(f.tooltip);
    const bounds = body.getBoundingClientRect();
    const action = actionAt(bounds);
    await changeVisibility(f, "hide", () => clickTarget(action, bounds));
    await expectVisibility(f, false);
  });

  it("keeps rich tooltip links pointer-accessible", async () => {
    const { link, tooltip } = await mountOpenTooltip(true);
    expect(getComputedStyle(tooltip).display).toBe("contents");
    expectSharedTooltipSkin(tooltip);
    await clickTarget(link!, undefined, true);
  });
  it("publishes completion only after the real opening transition, then hides on blur", async () => {
    const { page } = await import("vitest/browser");
    const f = await fixture();
    const body = tooltipBody(f.tooltip);
    body.style.setProperty("--control-ui-transition-fast", "200ms");
    const outside = element("button", { textContent: "Outside" });
    f.host.append(outside);
    await page.elementLocator(outside).hover();
    expect(f.trigger.matches(":hover")).toBe(false);
    await expect.element(body).not.toBeVisible();
    const shown = afterPhase(f.tooltip, "opened");
    requestVisibility(f, "show");
    let animation: Animation | undefined;
    let rate = 1;
    try {
      await expect
        .poll(() => {
          if (!animation) {
            animation = body
              .getAnimations()
              .find(
                (candidate) =>
                  candidate instanceof CSSTransition && candidate.playState === "running",
              );
            if (animation) {
              rate = animation.playbackRate;
              animation.playbackRate = 0;
            }
          }
          return animation;
        })
        .toBeDefined();
      const active = animation!;
      await active.ready;
      const { activeDuration } = active.effect!.getComputedTiming();
      expect(activeDuration).toBeGreaterThan(0);
      expect(Number.isFinite(activeDuration)).toBe(true);
      active.currentTime = Number(activeDuration) / 2;
      await frame();
      expect(active.playState).toBe("running");
      const { progress } = active.effect!.getComputedTiming();
      expect(progress).toBeGreaterThan(0);
      expect(progress).toBeLessThan(1);
      expect(body.dataset.phase).toBe("opening");
      expect(f.events).toEqual(["opening"]);
    } finally {
      if (animation) {
        animation.playbackRate = rate;
      }
    }
    await shown;
    expect(f.events).toEqual(["opening", "opened"]);
    expect(f.trigger.matches(":hover")).toBe(false);
    expect(body.matches(":hover")).toBe(false);
    expect(document.activeElement).toBe(f.trigger);
    const hidden = afterPhase(f.tooltip, "closed");
    f.trigger.blur();
    expect(document.activeElement).not.toBe(f.trigger);
    await hidden;
    await expectVisibility(f, false, ["opening", "opened", "closing", "closed"]);
  });

  it.each([false, true])("reopens during hide (zero duration=%s)", async (zeroDuration) => {
    const f = await fixture();
    if (zeroDuration) {
      withoutTooltipMotion(f);
    }
    await openTooltip(f);
    const duration = Number.parseFloat(getComputedStyle(tooltipBody(f.tooltip)).transitionDuration);
    if (zeroDuration) {
      expect(duration).toBe(0);
    } else {
      expect(duration).toBeGreaterThan(0);
    }
    await expectVisibility(f, true);
    f.events.length = 0;

    const reopened = afterPhase(f.tooltip, "opened");
    f.trigger.blur();
    await commitTooltip(f.tooltip);
    expect(f.events).toEqual(["closing"]);
    f.trigger.focus();
    await reopened;
    expect(document.activeElement).toBe(f.trigger);
    await expectVisibility(f, true, ["closing", "opening", "opened"]);
  });
  it.each([false, true])("preserves scroll on safe focus (wrapped=%s)", async (wrapped) => {
    const f = await fixture();
    f.trigger.style.cssText = "display: block";
    f.host.style.cssText = "height: 80px; overflow: auto";
    const spacer = document.createElement("div");
    spacer.style.height = "400px";
    f.host.append(spacer);
    if (!wrapped) {
      f.host.prepend(f.trigger);
      f.tooltip.remove();
    }
    f.host.scrollTop = 200;
    focusWithoutTooltip(f.trigger, { preventScroll: true });
    await commitTooltip(f.tooltip);
    expect(document.activeElement).toBe(f.trigger);
    expect(f.host.scrollTop).toBe(200);
    expect(f.tooltip.hasAttribute("open")).toBe(false);
    expect(f.events).toEqual([]);
  });

  it.each(["trigger", "ancestor"] as const)(
    "leaves duplicate labels and Escape unclaimed during %s fade",
    async (target) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture({ content: "Details" });
      const animation = (target === "trigger" ? f.trigger : f.host).animate(
        { opacity: [0, 1] },
        { duration: 140 },
      );
      animation.pause();
      animation.currentTime = 0;
      let escapes = 0;
      f.host.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          escapes += 1;
        }
      });
      try {
        expect(f.trigger.checkVisibility({ checkOpacity: true })).toBe(false);
        f.trigger.focus();
        await commitTooltip(f.tooltip);
        expect(f.tooltip.hasAttribute("open")).toBe(false);
        expect(tooltipBody(f.tooltip).matches(":popover-open")).toBe(false);
        await userEvent.keyboard("{Escape}");
        expect(escapes).toBe(1);
        expect(f.events).toEqual([]);
      } finally {
        animation.cancel();
      }
    },
  );

  it("yields to typing outside a hover tooltip before the next Escape", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture();
    const input: HTMLTextAreaElement = document.createElement("textarea");
    f.host.append(input);
    input.focus();
    let escapes = 0;
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        escapes += 1;
      }
    });
    // A growing textarea can move an attachment action under a stationary pointer.
    await changeVisibility(f, "show", () => {
      f.trigger.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    });
    await expectVisibility(f, true);
    await changeVisibility(f, "hide", () => userEvent.keyboard("Keep typing"));
    expect(input.value).toBe("Keep typing");
    await expectVisibility(f, false);
    await userEvent.keyboard("{Escape}");
    expect(escapes).toBe(1);
  });

  it("changes placement without reopening or moving focus", async () => {
    const f = await fixture();
    await openTooltip(f);
    const body = tooltipBody(f.tooltip);
    const triggerBounds = f.trigger.getBoundingClientRect();
    expect(body.getBoundingClientRect().bottom).toBeLessThanOrEqual(triggerBounds.top);
    f.events.length = 0;

    f.tooltip.placement = "bottom";
    await commitTooltip(f.tooltip);

    await expect
      .poll(() => body.getBoundingClientRect().top)
      .toBeGreaterThanOrEqual(triggerBounds.bottom);
    expect(body.getAttribute("placement")).toBe("bottom");
    expect(body.matches(":popover-open")).toBe(true);
    expect(body.dataset.phase).toBe("open");
    expect(document.activeElement).toBe(f.trigger);
    expect(f.events).toEqual([]);
  });

  it("does not reveal a disabled tooltip on focus", async () => {
    const f = await fixture({ disabled: true });
    f.trigger.focus();
    await frame();
    await expectVisibility(f, false);
  });

  it.each([
    { input: "click", dismissal: "trigger" },
    { input: "click", dismissal: "outside" },
    { input: "hover", dismissal: "outside" },
  ] as const)(
    "reveals from $input and dismisses on $dismissal click",
    async ({ input, dismissal }) => {
      const { page } = await import("vitest/browser");
      const f = await fixture({ openOnClick: input === "click" });
      const outside = element("button", { textContent: "Outside" });
      outside.style.cssText = "position: fixed; left: 20px; top: 20px";
      f.host.append(outside);
      pointerDown(f.trigger);
      expect(f.tooltip.hasAttribute("open")).toBe(false);
      expect(f.events).toEqual([]);
      await changeVisibility(f, "show", () => page.elementLocator(f.trigger)[input]());
      await expectVisibility(f, true);
      await changeVisibility(f, "hide", () =>
        page.elementLocator(dismissal === "trigger" ? f.trigger : outside).click(),
      );
      await expectVisibility(f, false, ["opening", "opened", "closing", "closed"]);
    },
  );

  it("keeps presses passive before reveal and rearms focus after dismissal blurs", async () => {
    const f = await fixture();
    pointerDown(f.trigger);
    expect(f.events).toEqual([]);
    await openTooltip(f);
    const hidden = afterPhase(f.tooltip, "closed");
    pointerDown(f.trigger);
    f.trigger.click();
    await hidden;
    f.events.length = 0;
    f.trigger.focus();
    await commitTooltip(f.tooltip);
    await expectVisibility(f, false, []);
    await openTooltip(f);
    await expectVisibility(f, true, ["opening", "opened"]);
  });

  it.each([false, true])("rebinds anchor input and descriptions (remount=%s)", async (remount) => {
    const f = await fixture();
    f.trigger.setAttribute("aria-labelledby", "original-label");
    const description = f.trigger
      .getAttribute("aria-describedby")!
      .split(" ")
      .find((id) => id !== "original-description")!;
    if (remount) {
      f.tooltip.remove();
      await Promise.resolve();
      expect(f.trigger.getAttribute("aria-describedby")).toBe("original-description");
    }
    const replacement = element("button", { textContent: "Replacement" });
    replacement.setAttribute("aria-labelledby", "replacement-label");
    replacement.setAttribute("aria-describedby", "replacement-description");
    f.host.append(replacement);
    f.tooltip.anchor = replacement;
    if (remount) {
      f.host.append(f.tooltip);
    }
    await commitTooltip(f.tooltip);
    expect(f.trigger.getAttribute("aria-labelledby")).toBe("original-label");
    expect(f.trigger.getAttribute("aria-describedby")).toBe("original-description");
    expect(replacement.getAttribute("aria-labelledby")).toBe("replacement-label");
    expect(replacement.getAttribute("aria-describedby")).toBe(
      `replacement-description ${description}`,
    );
    if (remount) {
      f.trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      f.trigger.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
      await frame();
      expect(f.events).toEqual([]);
    } else {
      f.trigger.focus();
    }
    expect(f.tooltip.hasAttribute("open")).toBe(false);
    await changeVisibility(f, "show", () => replacement.focus());
    await expectVisibility(f, true);
    if (remount) {
      const { userEvent } = await import("vitest/browser");
      await changeVisibility(f, "hide", () => userEvent.keyboard("{Escape}"));
      await expectVisibility(f, false);
    }
  });

  it.each([
    ["show", false, "hide"],
    ["hide", false, "show"],
    ["show", true, "show"],
    ["hide", true, "hide"],
    ["show", false, "disconnect"],
    ["hide", false, "disconnect"],
    ["show", false, "blur"],
    ["show", false, "disable"],
    ["show", false, "Escape"],
  ] as const)("fences pending %s (veto=%s) before %s", async (operation, veto, next) => {
    const f = await fixture();
    if (operation === "hide") {
      await openTooltip(f);
      f.events.length = 0;
    }
    if (veto) {
      vetoNextTransition(f, operation);
    }
    if (next === "disable") {
      f.tooltip.addEventListener("overlay-hide", (event) => event.preventDefault());
    }
    const body = tooltipBody(f.tooltip);
    // Freeze native presentation; later input must own the only completion.
    const animation = body.animate({ outlineOffset: ["0px", "1px"] }, { duration: 60_000 });
    animation.pause();
    try {
      requestVisibility(f, operation);
      if (next === "show" || next === "hide") {
        await commitTooltip(f.tooltip);
        expect(f.events).toEqual([requestPhase(operation)]);
        if (veto) {
          await expectVisibility(f, operation === "hide");
          if (operation === "hide") {
            f.trigger.focus();
          }
        }
        const done = afterPhase(f.tooltip, completionPhase(next));
        requestVisibility(f, next);
        animation.cancel();
        await done;
        await expectVisibility(f, next === "show", [
          requestPhase(operation),
          requestPhase(next),
          completionPhase(next),
        ]);
      } else {
        await frame();
        expect(body.dataset.phase).toBe(requestPhase(operation));
        if (next === "disconnect") {
          if (operation === "show") {
            expect(body.matches(":popover-open")).toBe(true);
          }
          expect(f.events).toEqual([requestPhase(operation)]);
          f.host.remove();
          expect(f.tooltip.hasAttribute("open")).toBe(false);
          animation.cancel();
          await frame();
          expect(f.events).toEqual([requestPhase(operation)]);
          document.body.append(f.host);
          await commitTooltip(f.tooltip);
          await expectVisibility(f, false);
          await openTooltip(f);
          await expectVisibility(f, true);
        }
        const hidden = afterPhase(f.tooltip, "closed");
        if (next === "blur") {
          expect(body.matches(":popover-open")).toBe(true);
          requestVisibility(f, "hide");
        } else if (next === "disable") {
          f.tooltip.disabled = true;
          await commitTooltip(f.tooltip);
          expect(f.tooltip.hasAttribute("open")).toBe(false);
        } else {
          const { userEvent } = await import("vitest/browser");
          await userEvent.keyboard("{Escape}");
          if (next === "Escape") {
            await commitTooltip(f.tooltip);
          }
        }
        animation.cancel();
        await hidden;
        await expectVisibility(
          f,
          false,
          next === "disconnect"
            ? [requestPhase(operation), "opening", "opened", "closing", "closed"]
            : ["opening", "closing", "closed"],
        );
        if (next === "Escape" || next === "disconnect") {
          expect(document.activeElement).toBe(f.trigger);
        }
      }
    } finally {
      animation.cancel();
    }
  });
});
