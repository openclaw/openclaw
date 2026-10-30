import type { Page } from "playwright";
import { expect, it } from "vitest";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "mobile sheet motion",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:mobile-sheet-motion";
const viewport = { width: 390, height: 844 };
const mobile = {
  viewport,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
  isMobile: true,
  hasTouch: true,
  colorScheme: "dark",
} as const;

async function openSession(page: Page) {
  await installMockGateway(page, {
    sessionKey,
    sessions: [{ key: sessionKey, label: "Mobile sheet motion", kind: "direct", updatedAt: 1 }],
    historyMessages: [
      { role: "assistant", content: [{ type: "text", text: "Sheet motion ready." }] },
    ],
  });
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
  await page.getByText("Sheet motion ready.").first().waitFor();
}

async function openPanels(page: Page) {
  await page.getByRole("button", { name: "Panels", exact: true }).first().click();
  await page.locator(".chat-mobile-host:not([hidden])").waitFor();
  await settle(page);
}

/** Waits for the real sheet motion and gesture-release override to finish. */
async function settle(page: Page) {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().endTime))
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
  await expect
    .poll(() =>
      page
        .locator(".sidebar-region")
        .evaluate((region) => region.style.getPropertyValue("--motion-sheet")),
    )
    .toBe("");
}

async function shellState(page: Page) {
  return page.locator(".chat-mobile-host").evaluate((shell) => {
    const style = getComputedStyle(shell);
    const region = shell.parentElement!.getBoundingClientRect();
    return {
      hidden: shell.hasAttribute("hidden"),
      display: style.display,
      mode: shell.getAttribute("data-mode"),
      height: shell.getBoundingClientRect().height,
      top: shell.getBoundingClientRect().top,
      regionHeight: region.height,
      regionBottom: region.bottom,
      easing: style.transitionTimingFunction,
    };
  });
}

/** Samples the actual spring timeline before browser round trips can outlast it. */
async function sampleSheetTransition(
  page: Page,
  time: number,
  action: () => Promise<void>,
  inspect: (state: Awaited<ReturnType<typeof shellState>>) => void | Promise<void>,
) {
  const sample = await page.locator(".chat-mobile-host").evaluateHandle(
    (shell, sampleTime) => ({
      started: new Promise<CSSTransition[]>((resolve, reject) => {
        const onTransition = (event: Event) => {
          if (
            !(event instanceof TransitionEvent) ||
            event.target !== shell ||
            event.propertyName !== "transform"
          ) {
            return;
          }
          shell.removeEventListener("transitionrun", onTransition);
          const animations = shell
            .getAnimations()
            .filter((entry): entry is CSSTransition => entry instanceof CSSTransition);
          if (!animations.some((entry) => entry.transitionProperty === "transform")) {
            reject(new Error("Missing sheet transform transition"));
            return;
          }
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = sampleTime;
          }
          resolve(animations);
        };
        shell.addEventListener("transitionrun", onTransition);
      }),
    }),
    time,
  );
  await action();
  await sample.evaluate(({ started }) => started.then(() => undefined));
  try {
    await inspect(await shellState(page));
  } finally {
    await sample.evaluate(async ({ started }) => {
      for (const animation of await started) {
        animation.play();
      }
    });
    await sample.dispose();
  }
}

/** Drags the grabber by dy with paced moves, then pauses before lifting. */
async function dragGrabber(page: Page, dy: number, options: { steps: number; stepMs: number }) {
  const box = await page.locator(".chat-mobile-host__grabber").boundingBox();
  if (!box) {
    throw new Error("grabber is not visible");
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= options.steps; step += 1) {
    await page.mouse.move(x, y + (dy * step) / options.steps);
    await page.waitForTimeout(options.stepMs);
  }
  // Hold still before lifting, like a deliberate placement: no momentum carries over.
  await page.waitForTimeout(150);
  await page.mouse.up();
}

/**
 * A 96 ms flick with explicit input timestamps, so release velocity (~1,500 px/s for
 * 150 px) does not depend on how quickly a loaded runner delivers the events.
 */
async function flick(page: Page, dy: number) {
  const box = await page.locator(".chat-mobile-host__grabber").boundingBox();
  if (!box) {
    throw new Error("grabber is not visible");
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const start = Date.now() / 1000;
  const send = (
    type: "mousePressed" | "mouseMoved" | "mouseReleased",
    at: number,
    offset: number,
  ) =>
    cdp.send("Input.dispatchMouseEvent", {
      type,
      x,
      y: y + offset,
      button: "left",
      buttons: type === "mouseReleased" ? 0 : 1,
      clickCount: type === "mouseMoved" ? 0 : 1,
      timestamp: start + at,
    });
  await send("mousePressed", 0, 0);
  for (let step = 1; step <= 6; step += 1) {
    await send("mouseMoved", step * 0.016, (dy * step) / 6);
  }
  await send("mouseReleased", 0.1, dy);
  await cdp.detach();
}

suite.define(() => {
  it("presents and dismisses the Panels sheet with the sheet spring", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      await openSession(page);
      // The sheet enters from below the viewport instead of fading in place.
      await sampleSheetTransition(
        page,
        40,
        () => page.getByRole("button", { name: "Panels", exact: true }).first().click(),
        (entering) => {
          expect(entering.top).toBeGreaterThan(entering.regionBottom - entering.height + 20);
          expect(entering.easing).toContain("linear(");
        },
      );
      await settle(page);
      const open = await shellState(page);
      expect(Math.abs(open.top + open.height - open.regionBottom)).toBeLessThan(1.5);

      await sampleSheetTransition(
        page,
        60,
        () => page.locator(".chat-mobile-host__header .chat-mobile-host__circle").first().click(),
        async (leaving) => {
          // Hidden immediately for focus and accessibility, but still sliding out on screen.
          expect(leaving.hidden).toBe(true);
          expect(leaving.display).not.toBe("none");
          expect(leaving.top).toBeGreaterThan(open.top + 10);
          // The page it showed slides away with it instead of blanking first.
          expect(await page.locator(".chat-panel-launcher-mobile").boundingBox()).not.toBeNull();
        },
      );
      await settle(page);
      expect((await shellState(page)).display).toBe("none");
    });
  });

  it("steps flicks through the dock and expanded detents and dismisses downward", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      await openSession(page);
      await openPanels(page);
      const dock = await shellState(page);
      expect(dock.mode).toBe("dock");

      await flick(page, -150);
      expect(
        await page
          .locator(".sidebar-region")
          .evaluate((region) => region.style.getPropertyValue("--motion-sheet")),
      ).toContain("linear(");
      await settle(page);
      const expanded = await shellState(page);
      expect(expanded.mode).toBe("expanded");
      const detent = Math.min(expanded.regionHeight * 0.85, expanded.regionHeight - 24);
      expect(Math.abs(expanded.height - detent)).toBeLessThan(2);
      // The velocity curve is released once the spring has settled.
      expect(
        await page
          .locator(".sidebar-region")
          .evaluate((region) => region.style.getPropertyValue("--motion-sheet")),
      ).toBe("");

      await flick(page, 150);
      await settle(page);
      const docked = await shellState(page);
      expect(docked.mode).toBe("dock");
      expect(Math.abs(docked.height - dock.height)).toBeLessThan(2);

      await flick(page, 150);
      await page.waitForTimeout(60);
      const dismissing = await shellState(page);
      expect(dismissing.hidden).toBe(true);
      expect(dismissing.display).not.toBe("none");
      await settle(page);
      expect((await shellState(page)).display).toBe("none");
    });
  });

  it("keeps slow releases where people leave them and only closes past half the minimum", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      await openSession(page);
      await openPanels(page);
      const dock = await shellState(page);

      // A slow drag with a pause before lifting carries no momentum.
      await dragGrabber(page, -120, { steps: 12, stepMs: 40 });
      await settle(page);
      const placed = await shellState(page);
      expect(Math.abs(placed.height - (dock.height + 120))).toBeLessThan(3);

      await dragGrabber(page, 120, { steps: 12, stepMs: 40 });
      await settle(page);
      const minimum = await page
        .locator(".chat-mobile-host")
        .evaluate((shell) =>
          getComputedStyle(shell.parentElement!).getPropertyValue("--mobile-min-height"),
        );
      expect(minimum).not.toBe("");

      // A short pull below the minimum springs back instead of closing.
      const before = await shellState(page);
      await dragGrabber(page, before.height - 150, { steps: 16, stepMs: 40 });
      await settle(page);
      const back = await shellState(page);
      expect(back.hidden).toBe(false);
      expect(Math.abs(back.top + back.height - back.regionBottom)).toBeLessThan(1.5);

      // Pulled most of the way out, the same slow release dismisses.
      await dragGrabber(page, back.height - 40, { steps: 20, stepMs: 40 });
      await settle(page);
      expect((await shellState(page)).display).toBe("none");
    });
  });

  it("drags from empty header space but leaves header controls tappable", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      await openSession(page);
      await openPanels(page);
      const header = await page.locator(".chat-mobile-host__header").boundingBox();
      const close = await page
        .locator(".chat-mobile-host__header .chat-mobile-host__circle")
        .first()
        .boundingBox();
      if (!header || !close) {
        throw new Error("header is not visible");
      }
      // Between the close button and the segmented control.
      const x = close.x + close.width + 10;
      const y = header.y + header.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      for (let step = 1; step <= 6; step += 1) {
        await page.mouse.move(x, y - step * 25);
        await page.waitForTimeout(16);
      }
      await page.mouse.up();
      await settle(page);
      expect((await shellState(page)).mode).toBe("expanded");

      // The segmented control's thumb slides to the pressed segment.
      const thumb = () =>
        page
          .locator(".chat-mobile-host__segments")
          .evaluate((segments) => getComputedStyle(segments, "::before").insetInlineStart);
      const panelsThumb = await thumb();
      await page.getByRole("button", { name: "Details", exact: true }).click();
      await expect
        .poll(() =>
          page.getByRole("button", { name: "Details", exact: true }).getAttribute("aria-pressed"),
        )
        .toBe("true");
      await settle(page);
      expect(await thumb()).not.toBe(panelsThumb);
    });
  });

  it("swipes the Filter & sort sheet down, springs back from short pulls, and slides out on outside taps", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      await openSession(page);
      await page.getByRole("button", { name: "Expand sidebar" }).first().click();
      const filter = page.getByRole("button", { name: /^Filter & sort/ }).first();
      const panel = page.locator(".sidebar-session-filter-panel");
      const grabber = page.locator(".sidebar-session-filter-panel__grabber");
      const swipe = async (dy: number) => {
        const box = await grabber.boundingBox();
        if (!box) {
          throw new Error("grabber is not visible");
        }
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        for (let step = 1; step <= 8; step += 1) {
          await page.mouse.move(x, y + (dy * step) / 8);
          await page.waitForTimeout(40);
        }
        await page.waitForTimeout(120);
        await page.mouse.up();
      };

      await filter.click();
      await panel.waitFor();
      await settle(page);
      const resting = await panel.boundingBox();
      await swipe(40);
      await settle(page);
      expect(await panel.isVisible()).toBe(true);
      expect((await panel.boundingBox())?.y).toBeCloseTo(resting?.y ?? 0, 0);

      await swipe(resting ? resting.height * 0.5 : 300);
      await expect.poll(() => panel.count()).toBe(0);

      await filter.click();
      await panel.waitFor();
      await settle(page);
      await page.mouse.click(195, 40);
      // The sheet is still leaving the screen right after the tap.
      await page.waitForTimeout(60);
      expect(await panel.count()).toBe(1);
      await expect.poll(() => panel.count()).toBe(0);
    });
  });

  it("pushes deeper sheet pages from the trailing edge and pops them back", async () => {
    await suite.withPage(mobile, async ({ page }) => {
      await openSession(page);
      await openPanels(page);
      const shell = page.locator(".chat-mobile-host");
      const push = () =>
        shell.evaluate((element) => element.style.getPropertyValue("--mobile-push"));
      expect(await push()).toBe("");
      await shell.getByRole("button", { name: "Details", exact: true }).click();
      await settle(page);
      expect(await push()).toBe("");
      await shell.getByRole("button", { name: /^Outputs/ }).click();
      await expect.poll(push).toBe("1");
      await settle(page);
      await page.locator(".chat-mobile-host").getByRole("button", { name: "Back" }).first().click();
      await expect.poll(push).toBe("-1");
    });
  });

  it("switches instantly when the person prefers reduced motion", async () => {
    await suite.withPage({ ...mobile, reducedMotion: "reduce" }, async ({ page }) => {
      await openSession(page);
      await page.getByRole("button", { name: "Panels", exact: true }).first().click();
      await page.locator(".chat-mobile-host:not([hidden])").waitFor();
      const open = await shellState(page);
      expect(Math.abs(open.top + open.height - open.regionBottom)).toBeLessThan(1.5);
      await page.locator(".chat-mobile-host__header .chat-mobile-host__circle").first().click();
      await expect.poll(async () => (await shellState(page)).display).toBe("none");
    });
  });
});
