import { flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { expectSharedTooltipSkin } from "./tooltip.test-support.ts";
import type { TooltipElement } from "./tooltip.ts";
import "./tooltip.ts";
import "../styles/base.css";

afterEach(() => document.body.replaceChildren());

type TooltipOperation = "show" | "hide";
const tooltipEvents = {
  opening: "wa-show",
  closing: "wa-hide",
  opened: "wa-after-show",
  closed: "wa-after-hide",
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

async function fixture(disabled = false) {
  const host = document.createElement("div");
  const tooltip = document.createElement("openclaw-tooltip");
  tooltip.content = "More information about this action";
  tooltip.disabled = disabled;
  tooltip.delay = 0;
  const trigger = document.createElement("button");
  trigger.textContent = "Details";
  trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
  trigger.setAttribute("aria-describedby", "original-description");
  tooltip.append(trigger);
  host.append(tooltip);
  document.body.append(host);
  await commitTooltip(tooltip);
  return { host, tooltip, trigger, events: recordLifecycle(tooltip) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function requestVisibility(f: Fixture, operation: TooltipOperation) {
  if (operation === "show") {
    // A rejected focus request leaves the trigger focused; a fresh focus entry retries it.
    f.trigger.blur();
    f.trigger.focus();
  } else {
    f.trigger.blur();
  }
}

async function openTooltip(f: Fixture) {
  const done = afterPhase(f.tooltip, "opened");
  requestVisibility(f, "show");
  await done;
}

async function expectVisibility(f: Fixture, open: boolean) {
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

async function duringTransition(
  f: Fixture,
  operation: TooltipOperation,
  action: () => void | Promise<void>,
) {
  const body = tooltipBody(f.tooltip);
  // Hold real native presentation work without spending its wall-clock duration.
  // The lifecycle must fence completion when user input supersedes this animation.
  const animation = body.animate({ outlineOffset: ["0px", "1px"] }, { duration: 60_000 });
  animation.pause();
  try {
    requestVisibility(f, operation);
    await frame();
    expect(body.dataset.phase).toBe(operation === "show" ? "opening" : "closing");
    await action();
  } finally {
    animation.cancel();
  }
}

function withoutTooltipMotion(f: Fixture) {
  const body = tooltipBody(f.tooltip);
  body.style.setProperty("--openclaw-tooltip-popup-show-duration", "0ms");
  body.style.setProperty("--openclaw-tooltip-popup-hide-duration", "0ms");
}

describe.runIf("__vitest_browser__" in globalThis)("tooltip pointer ownership", () => {
  it("skins the body and removes the arrow through shared overlay tokens", async () => {
    const f = await fixture();
    expect(getComputedStyle(f.tooltip).display).toBe("contents");
    await openTooltip(f);
    expectSharedTooltipSkin(f.tooltip);
  });

  async function mountOpenTooltip(rich: boolean) {
    const f = await fixture();
    let link: HTMLAnchorElement | undefined;
    if (rich) {
      f.tooltip.content = "";
      link = document.createElement("a");
      link.slot = "content";
      link.href = "#details";
      link.textContent = "Read documentation";
      f.tooltip.append(link);
      await commitTooltip(f.tooltip);
    }
    await openTooltip(f);
    const body = tooltipBody(f.tooltip);
    await expect.poll(() => body.getBoundingClientRect().width).toBeGreaterThan(0);
    return { ...f, body, link };
  }

  it.each(["body", "bridge"] as const)(
    "lets a real pointer reach an action under a plain tooltip %s",
    async (surface) => {
      const { page } = await import("vitest/browser");
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
      const action = document.createElement("button");
      action.textContent = "Tool access";
      action.style.cssText = `position: fixed; left: ${bounds.left}px; top: ${bounds.top}px; width: ${bounds.width}px; height: ${bounds.height}px`;
      document.body.append(action);
      let activated = false;
      action.addEventListener("click", () => {
        activated = true;
      });
      expect(
        document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2),
      ).toBe(action);
      await page.elementLocator(action).click();
      expect(activated).toBe(true);
    },
  );

  it("keeps rich tooltip links pointer-accessible", async () => {
    const { page } = await import("vitest/browser");
    const { link } = await mountOpenTooltip(true);
    const bounds = link!.getBoundingClientRect();
    expect(
      document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2),
    ).toBe(link);
    let activated = false;
    link!.addEventListener("click", (event) => {
      event.preventDefault();
      activated = true;
    });
    await page.elementLocator(link!).click();
    expect(activated).toBe(true);
  });
});

describe.runIf("__vitest_browser__" in globalThis)("tooltip transition ownership", () => {
  it.each([false, true])(
    "keeps a keyboard-reopened tooltip visible after an interrupted hide (zero duration=%s)",
    async (zeroDuration) => {
      const f = await fixture();
      if (zeroDuration) {
        withoutTooltipMotion(f);
      }
      await openTooltip(f);
      const duration = Number.parseFloat(
        getComputedStyle(tooltipBody(f.tooltip)).transitionDuration,
      );
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
      await expectVisibility(f, true);
      expect(f.events).toEqual(["closing", "opening", "opened"]);
    },
  );

  it("keeps a tooltip dismissed when Escape interrupts its opening animation", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture();
    const hidden = afterPhase(f.tooltip, "closed");
    await duringTransition(f, "show", async () => {
      await userEvent.keyboard("{Escape}");
      await commitTooltip(f.tooltip);
    });
    await hidden;
    expect(document.activeElement).toBe(f.trigger);
    await expectVisibility(f, false);
    expect(f.events).toEqual(["opening", "closing", "closed"]);
  });
});

describe.runIf("__vitest_browser__" in globalThis)("tooltip public lifecycle", () => {
  it("repositions an open tooltip after placement changes without reopening or moving focus", async () => {
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

  it.each([false, true])("honors immediate focus input when disabled=%s", async (disabled) => {
    const f = await fixture(disabled);
    if (disabled) {
      f.trigger.focus();
      await frame();
    } else {
      await openTooltip(f);
    }
    await expectVisibility(f, !disabled);
  });

  it.each([
    { input: "click", dismissal: "trigger" },
    { input: "focus", dismissal: "trigger" },
    { input: "click", dismissal: "outside" },
    { input: "hover", dismissal: "outside" },
  ] as const)(
    "reveals from $input and dismisses on $dismissal click",
    async ({ input, dismissal }) => {
      const { page } = await import("vitest/browser");
      const f = await fixture();
      const outside = document.createElement("button");
      outside.textContent = "Outside";
      outside.style.cssText = "position: fixed; left: 20px; top: 20px";
      f.host.append(outside);
      f.tooltip.openOnClick = input === "click";
      await commitTooltip(f.tooltip);
      f.trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }),
      );
      expect(f.tooltip.hasAttribute("open")).toBe(false);
      expect(f.events).toEqual([]);
      const shown = afterPhase(f.tooltip, "opened");
      if (input === "hover") {
        await page.elementLocator(f.trigger).hover();
      } else if (input === "click") {
        await page.elementLocator(f.trigger).click();
      } else {
        f.trigger.focus();
      }
      await shown;
      await expectVisibility(f, true);
      const hidden = afterPhase(f.tooltip, "closed");
      await page.elementLocator(dismissal === "trigger" ? f.trigger : outside).click();
      await hidden;
      await expectVisibility(f, false);
      expect(f.events).toEqual(["opening", "opened", "closing", "closed"]);
    },
  );

  it("keeps pointer press passive before reveal and rearms focus after a press dismissal blurs", async () => {
    const f = await fixture();
    f.trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(f.events).toEqual([]);
    await openTooltip(f);
    const hidden = afterPhase(f.tooltip, "closed");
    f.trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    f.trigger.click();
    await hidden;
    f.events.length = 0;
    f.trigger.focus();
    await commitTooltip(f.tooltip);
    await expectVisibility(f, false);
    expect(f.events).toEqual([]);
    await openTooltip(f);
    await expectVisibility(f, true);
    expect(f.events).toEqual(["opening", "opened"]);
  });

  it.each(["hide", "disconnect"] as const)(
    "does not complete an opening revoked after its first usable frame (%s)",
    async (action) => {
      const f = await fixture();
      const hidden = action === "hide" ? afterPhase(f.tooltip, "closed") : undefined;
      await duringTransition(f, "show", () => {
        expect(tooltipBody(f.tooltip).matches(":popover-open")).toBe(true);
        if (action === "disconnect") {
          f.host.remove();
        } else {
          requestVisibility(f, "hide");
        }
      });
      if (hidden) {
        await hidden;
        await expectVisibility(f, false);
        expect(f.events).toEqual(["opening", "closing", "closed"]);
      } else {
        await frame();
        expect(f.tooltip.hasAttribute("open")).toBe(false);
        expect(f.events).toEqual(["opening"]);
      }
    },
  );

  it("disabling during an opening retires it even when a hide listener vetoes", async () => {
    const f = await fixture();
    f.tooltip.addEventListener("wa-hide", (event) => event.preventDefault());
    const hidden = afterPhase(f.tooltip, "closed");
    await duringTransition(f, "show", async () => {
      f.tooltip.disabled = true;
      await commitTooltip(f.tooltip);
      expect(f.tooltip.hasAttribute("open")).toBe(false);
    });
    await hidden;
    await expectVisibility(f, false);
    expect(f.events).toEqual(["opening", "closing", "closed"]);
  });

  it("keeps a reconnected tooltip closed until fresh focus input", async () => {
    const f = await fixture();
    await openTooltip(f);
    f.host.remove();
    f.events.length = 0;
    document.body.append(f.host);
    await commitTooltip(f.tooltip);
    await expectVisibility(f, false);
    expect(f.events).toEqual([]);
    await openTooltip(f);
    await expectVisibility(f, true);
  });

  it("moves focus listeners and preserves other descriptions when replacing the anchor", async () => {
    const f = await fixture();
    f.trigger.setAttribute("aria-labelledby", "original-label");
    const description = f.trigger
      .getAttribute("aria-describedby")!
      .split(" ")
      .find((id) => id !== "original-description")!;
    const replacement = document.createElement("button");
    replacement.textContent = "Replacement";
    replacement.setAttribute("aria-labelledby", "replacement-label");
    replacement.setAttribute("aria-describedby", "replacement-description");
    f.host.append(replacement);
    f.tooltip.anchor = replacement;
    await commitTooltip(f.tooltip);
    expect(f.trigger.getAttribute("aria-labelledby")).toBe("original-label");
    expect(f.trigger.getAttribute("aria-describedby")).toBe("original-description");
    expect(replacement.getAttribute("aria-labelledby")).toBe("replacement-label");
    expect(replacement.getAttribute("aria-describedby")).toBe(
      `replacement-description ${description}`,
    );
    f.trigger.focus();
    expect(f.tooltip.hasAttribute("open")).toBe(false);
    const shown = afterPhase(f.tooltip, "opened");
    replacement.focus();
    await shown;
    await expectVisibility(f, true);
  });

  it("retires old-anchor input and descriptions across disconnect and remount", async () => {
    const { userEvent } = await import("vitest/browser");
    const f = await fixture();
    f.tooltip.remove();
    await Promise.resolve();
    expect(f.trigger.getAttribute("aria-describedby")).toBe("original-description");
    const replacement = document.createElement("button");
    replacement.textContent = "Replacement";
    f.host.append(replacement);
    f.tooltip.anchor = replacement;
    f.host.append(f.tooltip);
    await commitTooltip(f.tooltip);
    f.trigger.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    f.trigger.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
    await frame();
    expect(f.tooltip.hasAttribute("open")).toBe(false);
    expect(f.events).toEqual([]);
    const shown = afterPhase(f.tooltip, "opened");
    replacement.focus();
    await shown;
    await expectVisibility(f, true);
    const hidden = afterPhase(f.tooltip, "closed");
    await userEvent.keyboard("{Escape}");
    await hidden;
    await expectVisibility(f, false);
  });

  it.each([
    { operation: "show", veto: false },
    { operation: "hide", veto: false },
    { operation: "show", veto: true },
    { operation: "hide", veto: true },
  ] as const)(
    "fences superseded $operation input without stale completion (veto=$veto)",
    async ({ operation, veto }) => {
      const f = await fixture();
      if (operation === "hide") {
        await openTooltip(f);
        f.events.length = 0;
      }
      if (veto) {
        vetoNextTransition(f, operation);
      }
      const body = tooltipBody(f.tooltip);
      const animation = body.animate({ outlineOffset: ["0px", "1px"] }, { duration: 60_000 });
      animation.pause();
      try {
        requestVisibility(f, operation);
        await commitTooltip(f.tooltip);
        expect(f.events).toEqual([requestPhase(operation)]);
        if (veto) {
          await expectVisibility(f, operation === "hide");
          if (operation === "hide") {
            f.trigger.focus();
          }
        }
        const replacement = veto ? operation : operation === "show" ? "hide" : "show";
        const done = afterPhase(f.tooltip, completionPhase(replacement));
        requestVisibility(f, replacement);
        animation.cancel();
        await done;
        await expectVisibility(f, replacement === "show");
        expect(f.events).toEqual([
          requestPhase(operation),
          requestPhase(replacement),
          completionPhase(replacement),
        ]);
      } finally {
        animation.cancel();
      }
    },
  );

  it.each(["show", "hide"] as const)(
    "retires a pending %s on disconnect before a fresh keyboard reveal",
    async (operation) => {
      const { userEvent } = await import("vitest/browser");
      const f = await fixture();
      if (operation === "hide") {
        await openTooltip(f);
        f.events.length = 0;
      }
      await duringTransition(f, operation, () => {
        expect(f.events).toEqual([requestPhase(operation)]);
        f.host.remove();
        expect(f.tooltip.hasAttribute("open")).toBe(false);
      });
      document.body.append(f.host);
      await commitTooltip(f.tooltip);
      await expectVisibility(f, false);
      await openTooltip(f);
      await expectVisibility(f, true);
      const hidden = afterPhase(f.tooltip, "closed");
      await userEvent.keyboard("{Escape}");
      await hidden;
      await expectVisibility(f, false);
      expect(document.activeElement).toBe(f.trigger);
      expect(f.events).toEqual([requestPhase(operation), "opening", "opened", "closing", "closed"]);
    },
  );
});
