import { afterEach, describe, expect, it } from "vitest";
import { duringElementAnimation } from "../test-helpers/web-awesome-animation.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./tooltip.ts";

afterEach(() => document.body.replaceChildren());

type TooltipSurface = HTMLElementTagNameMap["wa-tooltip"];
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

function afterTransition(tooltip: HTMLElement, operation: TooltipOperation) {
  return afterPhase(tooltip, completionPhase(operation));
}

function commitTooltip(tooltip: { updateComplete: Promise<unknown> }) {
  return tooltip.updateComplete;
}

function positionTooltip(tooltip: TooltipSurface) {
  return tooltip.popup.updateComplete;
}

function wrappedTooltipSurface(tooltip: HTMLElement) {
  return tooltip.shadowRoot!.querySelector("wa-tooltip")!;
}

function tooltipBody(tooltip: TooltipSurface) {
  return tooltip.shadowRoot!.querySelector<HTMLElement>('[part="body"]')!;
}

function tooltipIsOpen(tooltip: TooltipSurface) {
  return tooltip.open;
}

function tooltipIsHidden(tooltip: TooltipSurface) {
  return tooltip.body.hidden;
}

function tooltipIsActive(tooltip: TooltipSurface) {
  return tooltip.popup.active;
}

function openTooltip(tooltip: TooltipSurface) {
  return tooltip.show();
}

function closeTooltip(tooltip: TooltipSurface) {
  return tooltip.hide();
}

function transitionTooltip(tooltip: TooltipSurface, operation: TooltipOperation) {
  return operation === "show" ? openTooltip(tooltip) : closeTooltip(tooltip);
}

function vetoNextTransition(tooltip: TooltipSurface, operation: TooltipOperation) {
  tooltip.addEventListener(
    tooltipEvents[requestPhase(operation)],
    (event) => event.preventDefault(),
    {
      once: true,
    },
  );
}

function vetoTooltipClosing(tooltip: TooltipSurface) {
  tooltip.addEventListener(tooltipEvents.closing, (event) => event.preventDefault());
}

function duringTooltipOpening(
  tooltip: TooltipSurface,
  request: () => unknown,
  action: () => void | Promise<void>,
) {
  return duringElementAnimation(tooltip.popup.popup, "show-with-scale", request, action);
}

function tooltipOpeningDuration(tooltip: TooltipSurface) {
  return Number.parseFloat(getComputedStyle(tooltip.popup.popup).animationDuration);
}

function withoutTooltipMotion(tooltip: TooltipSurface) {
  tooltip.popup.style.setProperty("--show-duration", "0ms");
  tooltip.popup.style.setProperty("--hide-duration", "0ms");
}

function onPositionedAfterOpening(tooltip: TooltipSurface, action: () => void) {
  let handled = false;
  tooltip.addEventListener("wa-reposition", () => {
    if (handled || tooltip.popup.popup.classList.contains("show-with-scale")) {
      return;
    }
    handled = true;
    action();
  });
}

function anchorListenerSignal(tooltip: TooltipSurface) {
  // The retirement reason must not retain a detached anchor through an Error stack.
  return (tooltip as unknown as { eventController: AbortController }).eventController.signal;
}

async function expectVisibility(tooltip: TooltipSurface, open: boolean) {
  await positionTooltip(tooltip);
  expect(tooltipIsOpen(tooltip)).toBe(open);
  expect(tooltipIsActive(tooltip)).toBe(open);
  expect(tooltipIsHidden(tooltip)).toBe(!open);
  if (open) {
    await expect.element(tooltipBody(tooltip)).toBeVisible();
  } else {
    await expect.element(tooltipBody(tooltip)).not.toBeVisible();
  }
}

describe.runIf("__vitest_browser__" in globalThis)("tooltip pointer ownership", () => {
  async function mountOpenTooltip(rich: boolean) {
    const tooltip = document.createElement("openclaw-tooltip");
    const trigger = document.createElement("button");
    trigger.textContent = "Details";
    trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
    tooltip.append(trigger);
    let link: HTMLAnchorElement | undefined;
    if (rich) {
      link = document.createElement("a");
      link.slot = "content";
      link.href = "#details";
      link.textContent = "Read documentation";
      tooltip.append(link);
    } else {
      tooltip.content = "More information about this action";
    }
    document.body.append(tooltip);
    await commitTooltip(tooltip);
    const shown = afterPhase(tooltip, "opened");
    trigger.focus();
    await shown;
    const popup = wrappedTooltipSurface(tooltip);
    const body = tooltipBody(popup);
    await expect.poll(() => body.getBoundingClientRect().width).toBeGreaterThan(0);
    return { tooltip, trigger, popup, body, link };
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
  async function fixture(zeroDuration = false) {
    const tooltip = document.createElement("openclaw-tooltip");
    tooltip.content = "More information about this action";
    const trigger = document.createElement("button");
    trigger.textContent = "Details";
    trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
    tooltip.append(trigger);
    document.body.append(tooltip);
    await commitTooltip(tooltip);
    // Materialize with canceled intent so each transition test starts closed.
    trigger.focus();
    trigger.blur();
    await commitTooltip(tooltip);
    await customElements.whenDefined("wa-tooltip");
    const native = wrappedTooltipSurface(tooltip);
    await commitTooltip(native);
    await positionTooltip(native);
    if (zeroDuration) {
      withoutTooltipMotion(native);
    }
    return { tooltip, trigger, native, events: recordLifecycle(native) };
  }

  it.each([false, true])(
    "keeps a keyboard-reopened tooltip visible after an interrupted hide (zero duration=%s)",
    async (zeroDuration) => {
      const { tooltip, trigger, native, events } = await fixture(zeroDuration);
      const shown = afterTransition(native, "show");
      const opening = afterPhase(native, "opening");
      trigger.focus();
      await opening;
      await commitTooltip(native);
      const duration = tooltipOpeningDuration(native);
      if (zeroDuration) {
        expect(duration).toBe(0);
      } else {
        expect(duration).toBeGreaterThan(0);
      }
      await shown;
      await expect.element(tooltipBody(native)).toBeVisible();
      events.length = 0;

      trigger.blur();
      // Join the reactive close, not its animation. Native focus then admits
      // the next opening before even a zero-duration hide's frame boundary.
      await commitTooltip(native);
      expect(events).toEqual(["closing"]);
      const reopened = afterTransition(native, "show");
      trigger.focus();
      await reopened;
      await positionTooltip(native);

      expect(document.activeElement).toBe(trigger);
      expect(tooltip.hasAttribute("open")).toBe(true);
      expect(tooltipIsOpen(native)).toBe(true);
      expect(tooltipIsHidden(native)).toBe(false);
      expect(tooltipIsActive(native)).toBe(true);
      await expect.element(tooltipBody(native)).toBeVisible();
      expect(events).toEqual(["closing", "opening", "opened"]);
    },
  );

  it("keeps a tooltip dismissed when Escape interrupts its opening animation", async () => {
    const { userEvent } = await import("vitest/browser");
    const { tooltip, trigger, native, events } = await fixture();
    const hidden = afterTransition(native, "hide");
    await duringTooltipOpening(
      native,
      () => trigger.focus(),
      async () => {
        await userEvent.keyboard("{Escape}");
        await commitTooltip(native);
      },
    );
    await hidden;
    await positionTooltip(native);

    expect(document.activeElement).toBe(trigger);
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(tooltipIsOpen(native)).toBe(false);
    expect(tooltipIsHidden(native)).toBe(true);
    expect(tooltipIsActive(native)).toBe(false);
    await expect.element(tooltipBody(native)).not.toBeVisible();
    expect(events).toEqual(["opening", "closing", "closed"]);
  });
});

describe.runIf("__vitest_browser__" in globalThis)("tooltip public lifecycle", () => {
  async function fixture(initial?: { open: boolean; disabled: boolean }) {
    const host = document.createElement("div");
    const trigger = document.createElement("button");
    trigger.id = "tooltip-lifecycle-trigger";
    trigger.textContent = "Details";
    trigger.style.cssText = "position: fixed; left: 200px; top: 200px";
    const tooltip = document.createElement("wa-tooltip");
    tooltip.for = trigger.id;
    tooltip.trigger = "manual";
    tooltip.open = initial?.open ?? false;
    tooltip.disabled = initial?.disabled ?? false;
    tooltip.textContent = "More information about this action";
    host.append(trigger, tooltip);
    document.body.append(host);
    await commitTooltip(tooltip);
    await positionTooltip(tooltip);
    return { host, trigger, tooltip, events: recordLifecycle(tooltip) };
  }

  it.each([false, true])("honors initial open intent when disabled=%s", async (disabled) => {
    const { tooltip } = await fixture({ open: true, disabled });
    if (!disabled) {
      await openTooltip(tooltip);
    }
    await expectVisibility(tooltip, !disabled);
  });

  it.each([
    { mode: "click", dismissal: "trigger" },
    { mode: "click manual", dismissal: "trigger" },
    { mode: "click", dismissal: "outside" },
    { mode: "hover", dismissal: "outside" },
  ])("reveals from $mode and dismisses on $dismissal click", async ({ mode, dismissal }) => {
    const { page } = await import("vitest/browser");
    const { host, trigger, tooltip, events } = await fixture();
    const outside = document.createElement("button");
    outside.textContent = "Outside";
    outside.style.cssText = "position: fixed; left: 20px; top: 20px";
    host.append(outside);
    tooltip.trigger = mode;
    tooltip.showDelay = 0;
    tooltip.hideDelay = 0;
    await commitTooltip(tooltip);
    if (dismissal === "trigger") {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      expect(tooltipIsOpen(tooltip)).toBe(false);
      expect(events).toEqual([]);
    }
    const shown = afterTransition(tooltip, "show");
    if (mode === "hover") {
      await page.elementLocator(trigger).hover();
    } else {
      await page.elementLocator(trigger).click();
    }
    await shown;
    await expectVisibility(tooltip, true);
    const hidden = afterTransition(tooltip, "hide");
    await page.elementLocator(dismissal === "trigger" ? trigger : outside).click();
    await hidden;
    await expectVisibility(tooltip, false);
    expect(events).toEqual(["opening", "opened", "closing", "closed"]);
  });

  it("keeps manual press passive and rearms focus after a press dismissal blurs", async () => {
    const { trigger, tooltip, events } = await fixture();
    await openTooltip(tooltip);
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    trigger.click();
    expect(tooltipIsOpen(tooltip)).toBe(true);
    await closeTooltip(tooltip);
    tooltip.trigger = "focus";
    await commitTooltip(tooltip);
    const shown = afterTransition(tooltip, "show");
    trigger.focus();
    await shown;
    const hidden = afterTransition(tooltip, "hide");
    trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    await hidden;
    events.length = 0;
    trigger.dispatchEvent(new FocusEvent("focus"));
    expect(tooltipIsOpen(tooltip)).toBe(false);
    expect(events).toEqual([]);
    trigger.blur();
    const reopened = afterTransition(tooltip, "show");
    trigger.focus();
    await reopened;
    await expectVisibility(tooltip, true);
    expect(events).toEqual(["opening", "opened"]);
  });

  it.each(["hide", "disconnect"] as const)(
    "does not complete an opening revoked by a reposition listener (%s)",
    async (action) => {
      const { host, tooltip, events } = await fixture();
      let opening: Promise<void> | undefined;
      let interrupted = false;
      await duringTooltipOpening(
        tooltip,
        () => {
          opening = openTooltip(tooltip);
        },
        () => {
          onPositionedAfterOpening(tooltip, () => {
            interrupted = true;
            if (action === "disconnect") {
              host.remove();
            } else {
              void closeTooltip(tooltip);
            }
          });
        },
      );
      await opening;
      expect(interrupted).toBe(true);
      if (action === "hide") {
        await closeTooltip(tooltip);
        await expectVisibility(tooltip, false);
        expect(events).toEqual(["opening", "closing", "closed"]);
      } else {
        expect(tooltipIsHidden(tooltip)).toBe(true);
        expect(tooltipIsActive(tooltip)).toBe(false);
        expect(events).toEqual(["opening"]);
      }
    },
  );

  it("disabling during an opening retires it even when a hide listener vetoes", async () => {
    const { tooltip, events } = await fixture();
    vetoTooltipClosing(tooltip);
    const opening = openTooltip(tooltip);
    await commitTooltip(tooltip);
    expect(events).toEqual(["opening"]);
    tooltip.disabled = true;
    await commitTooltip(tooltip);
    await Promise.all([opening, closeTooltip(tooltip)]);
    await expectVisibility(tooltip, false);
    expect(events).toEqual(["opening", "closing", "closed"]);
  });

  it("honors a hide requested immediately after reconnecting an open tooltip", async () => {
    const { host, tooltip, events } = await fixture();
    await openTooltip(tooltip);
    host.remove();
    events.length = 0;
    document.body.append(host);
    await closeTooltip(tooltip);
    await expectVisibility(tooltip, false);
    expect(events).toEqual([]);
  });

  it("moves focus listeners and preserves other labels when replacing the anchor", async () => {
    const { host, trigger, tooltip } = await fixture();
    trigger.setAttribute("aria-labelledby", "original-label " + tooltip.id);
    const replacement = document.createElement("button");
    replacement.id = "replacement-tooltip-trigger";
    replacement.textContent = "Replacement";
    replacement.setAttribute("aria-labelledby", "replacement-label");
    host.append(replacement);
    tooltip.trigger = "focus";
    tooltip.for = replacement.id;
    await commitTooltip(tooltip);
    expect(trigger.getAttribute("aria-labelledby")).toBe("original-label");
    expect(replacement.getAttribute("aria-labelledby")).toBe("replacement-label " + tooltip.id);
    trigger.focus();
    expect(tooltipIsOpen(tooltip)).toBe(false);
    const shown = afterTransition(tooltip, "show");
    replacement.focus();
    await shown;
    await expectVisibility(tooltip, true);
  });

  it("retires anchor listeners without retaining a disconnect exception", async () => {
    const { userEvent } = await import("vitest/browser");
    const { host, trigger, tooltip, events } = await fixture();
    tooltip.trigger = "focus";
    await commitTooltip(tooltip);
    // Observe the native signal: a default abort exception can retain detached
    // anchors through its stack while this tooltip waits in the title cache.
    const retired = anchorListenerSignal(tooltip);
    expect(retired.aborted).toBe(false);

    tooltip.remove();
    expect(retired.aborted).toBe(true);
    expect(retired.reason).toBeNull();

    const replacement = document.createElement("button");
    replacement.id = "reconnected-tooltip-trigger";
    replacement.textContent = "Replacement";
    host.append(replacement);
    tooltip.for = replacement.id;
    host.append(tooltip);
    await commitTooltip(tooltip);
    expect(anchorListenerSignal(tooltip)).not.toBe(retired);
    expect(anchorListenerSignal(tooltip).aborted).toBe(false);

    trigger.dispatchEvent(new FocusEvent("focus"));
    await commitTooltip(tooltip);
    expect(tooltipIsOpen(tooltip)).toBe(false);
    expect(events).toEqual([]);
    const shown = afterTransition(tooltip, "show");
    replacement.focus();
    await shown;
    await expectVisibility(tooltip, true);
    const hidden = afterTransition(tooltip, "hide");
    await userEvent.keyboard("{Escape}");
    await hidden;
    await expectVisibility(tooltip, false);
  });

  it.each([
    { operation: "show", veto: false },
    { operation: "hide", veto: false },
    { operation: "show", veto: true },
    { operation: "hide", veto: true },
  ] as const)(
    "settles an interrupted public $operation without stale completion (veto=$veto)",
    async ({ operation, veto }) => {
      const { tooltip, events } = await fixture();
      if (operation === "hide") {
        await openTooltip(tooltip);
        events.length = 0;
      }
      if (veto) {
        vetoNextTransition(tooltip, operation);
      }
      let settled = false;
      const pending = transitionTooltip(tooltip, operation).then(() => {
        settled = true;
      });
      await commitTooltip(tooltip);
      expect(events).toEqual([requestPhase(operation)]);
      if (veto) {
        await expect.poll(() => settled).toBe(true);
        await pending;
        await expectVisibility(tooltip, operation === "hide");
        expect(events).toEqual([requestPhase(operation)]);
      }
      const replacement = veto ? operation : operation === "show" ? "hide" : "show";
      await Promise.all([pending, transitionTooltip(tooltip, replacement)]);
      await expectVisibility(tooltip, replacement === "show");
      expect(events).toEqual([
        requestPhase(operation),
        requestPhase(replacement),
        completionPhase(replacement),
      ]);
    },
  );

  it.each(["show", "hide"] as const)(
    "retires a public %s on disconnect before a fresh keyboard reveal",
    async (operation) => {
      const { userEvent } = await import("vitest/browser");
      const { host, trigger, tooltip, events } = await fixture();
      if (operation === "hide") {
        await openTooltip(tooltip);
        events.length = 0;
      }
      const pending = transitionTooltip(tooltip, operation);
      await commitTooltip(tooltip);
      expect(events).toEqual([requestPhase(operation)]);
      host.remove();
      expect(tooltipIsActive(tooltip)).toBe(false);
      expect(tooltipIsHidden(tooltip)).toBe(true);
      expect(events).toEqual([requestPhase(operation)]);

      // Reconnect before the retired promise settles. Explicit closed intent
      // and the next focus must survive the previous connection's cleanup.
      tooltip.open = false;
      tooltip.trigger = "focus";
      document.body.append(host);
      await commitTooltip(tooltip);
      expect(tooltipIsOpen(tooltip)).toBe(false);
      expect(tooltipIsActive(tooltip)).toBe(false);
      expect(tooltipIsHidden(tooltip)).toBe(true);
      const shown = afterTransition(tooltip, "show");
      trigger.focus();
      await Promise.all([pending, shown]);
      await expectVisibility(tooltip, true);
      const hidden = afterTransition(tooltip, "hide");
      await userEvent.keyboard("{Escape}");
      await hidden;
      await expectVisibility(tooltip, false);
      expect(document.activeElement).toBe(trigger);
      expect(events).toEqual([requestPhase(operation), "opening", "opened", "closing", "closed"]);
    },
  );
});
