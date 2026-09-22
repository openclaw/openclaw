import { afterEach, describe, expect, it } from "vitest";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./tooltip.ts";

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("tooltip pointer ownership", () => {
  async function openTooltip(rich: boolean) {
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
    await tooltip.updateComplete;
    const popup = tooltip.shadowRoot!.querySelector("wa-tooltip")!;
    const shown = new Promise<Event>((resolve) => {
      popup.addEventListener("wa-after-show", resolve, { once: true });
    });
    trigger.focus();
    await shown;
    const body = popup.shadowRoot!.querySelector<HTMLElement>('[part="body"]')!;
    await expect.poll(() => body.getBoundingClientRect().width).toBeGreaterThan(0);
    return { tooltip, trigger, popup, body, link };
  }

  it.each(["body", "bridge"] as const)(
    "lets a real pointer reach an action under a plain tooltip %s",
    async (surface) => {
      const { page } = await import("vitest/browser");
      const { body, trigger } = await openTooltip(false);
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
    const { link } = await openTooltip(true);
    let activated = false;
    link!.addEventListener("click", (event) => {
      event.preventDefault();
      activated = true;
    });
    await page.elementLocator(link!).click();
    expect(activated).toBe(true);
  });
});
