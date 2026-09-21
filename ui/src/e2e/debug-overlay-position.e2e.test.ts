import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { deviceSystemInfo } from "../test-helpers/devices-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "System busyness placement" });
const methodResponses = {
  "system.info": deviceSystemInfo,
  "diagnostics.lanes": { lanes: [], dynamic: null },
  "models.list": { models: [] },
};

async function settle(panel: Locator) {
  await panel.evaluate(async (element) => {
    await new Promise(requestAnimationFrame);
    await new Promise(requestAnimationFrame);
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

async function openCompact(page: Page) {
  await page.getByRole("button", { name: /^Open overlay/u }).click();
  const panel = page.getByRole("complementary", { name: "System busyness" });
  await panel.getByRole("button", { name: "Minimize system busyness" }).click();
  await panel.locator(".debug-overlay__widget").waitFor();
  await settle(panel);
  return panel;
}

suite.define(() => {
  it("remembers dragged placement through reload, resizing and quick size transitions", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" },
      async ({ page }) => {
        await installMockGateway(page, { methodResponses });
        const layoutRequests: string[] = [];
        page.on("request", (request) => {
          if (request.url().includes("debug-overlay-layout.runtime-")) {
            layoutRequests.push(request.url());
          }
        });
        await page.goto(suite.server.baseUrl + "debug");
        await page.getByRole("button", { name: /^Open overlay/u }).waitFor();
        expect(layoutRequests).toHaveLength(0);
        let panel = await openCompact(page);
        expect(layoutRequests).toHaveLength(1);
        const original = (await panel.boundingBox())!;
        const header = panel.locator(".debug-overlay__header");
        const handle = (await header.boundingBox())!;
        await page.mouse.move(handle.x + 50, handle.y + handle.height / 2);
        await page.mouse.down();
        await page.mouse.move(handle.x - 150, handle.y - 90, { steps: 4 });
        await page.mouse.up();
        const moved = (await panel.boundingBox())!;
        expect(moved.x).toBeCloseTo(original.x - 200, 0);
        expect(moved.y).toBeLessThan(original.y - 80);
        const saved = await page.evaluate(() =>
          localStorage.getItem("openclaw.debug-overlay.position"),
        );
        expect(JSON.parse(saved!)).toEqual({ x: moved.x, y: moved.y });

        // Inspect and sample the actual Web Animation without racing its short duration.
        const animation = await panel.evaluate(async (element) => {
          element.querySelector<HTMLButtonElement>("button")!.click();
          await new Promise(requestAnimationFrame);
          await new Promise(requestAnimationFrame);
          const active = element.getAnimations()[0];
          if (!active) {
            return null;
          }
          active.pause();
          active.currentTime = 80;
          const width = element.getBoundingClientRect().width;
          const duration = active.effect?.getTiming().duration;
          active.finish();
          return { width, duration };
        });
        expect(animation?.duration).toBe(160);
        expect(animation!.width).toBeGreaterThan(moved.width);
        expect(animation!.width).toBeLessThan(560);
        await settle(panel);
        const expanded = (await panel.boundingBox())!;
        expect(expanded.x + expanded.width).toBeLessThanOrEqual(1280);
        expect(expanded.y + expanded.height).toBeLessThanOrEqual(900);
        await panel.getByRole("button", { name: "Minimize system busyness" }).click();
        await settle(panel);
        expect((await panel.boundingBox())!.x).toBeCloseTo(moved.x, 0);
        expect((await panel.boundingBox())!.y).toBeCloseTo(moved.y, 0);

        await page.reload();
        panel = await openCompact(page);
        expect((await panel.boundingBox())!.x).toBeCloseTo(moved.x, 0);
        expect((await panel.boundingBox())!.y).toBeCloseTo(moved.y, 0);
        await page.setViewportSize({ width: 390, height: 650 });
        await settle(panel);
        const mobile = (await panel.boundingBox())!;
        expect(mobile.x).toBeGreaterThanOrEqual(8);
        expect(mobile.x + mobile.width).toBeLessThanOrEqual(390);
        expect(mobile.y + mobile.height).toBeLessThanOrEqual(650);
        await page.setViewportSize({ width: 1280, height: 900 });
        await settle(panel);
        expect((await panel.boundingBox())!.x).toBeCloseTo(moved.x, 0);
        expect(
          await page.evaluate(() => localStorage.getItem("openclaw.debug-overlay.position")),
        ).toBe(saved);

        await page.emulateMedia({ reducedMotion: "reduce" });
        await panel.getByRole("button", { name: "Expand system busyness" }).click();
        await settle(panel);
        expect(await panel.evaluate((element) => element.getAnimations().length)).toBe(0);
        const beforeKeyboard = (await panel.boundingBox())!;
        await panel.locator("header").focus();
        await page.keyboard.press("Shift+ArrowLeft");
        expect((await panel.boundingBox())!.x).toBeCloseTo(beforeKeyboard.x - 40, 0);
        await panel.getByRole("button", { name: "Close", exact: true }).click();
        expect(await panel.count()).toBe(0);
      },
    );
  });

  it("moves with a real touch gesture without scrolling the page", async () => {
    await suite.withPage(
      {
        viewport: { width: 390, height: 650 },
        hasTouch: true,
        isMobile: true,
        reducedMotion: "reduce",
      },
      async ({ page, context }) => {
        await installMockGateway(page, { methodResponses });
        await page.goto(suite.server.baseUrl + "debug");
        const panel = await openCompact(page);
        const box = (await panel.locator("header").boundingBox())!;
        const before = (await panel.boundingBox())!;
        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: box.x + 40, y: box.y + 12 }],
        });
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: box.x + 10, y: box.y - 108 }],
        });
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        expect((await panel.boundingBox())!.x).toBeCloseTo(before.x - 30, 0);
        expect((await panel.boundingBox())!.y).toBeCloseTo(before.y - 120, 0);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        await cdp.detach();
      },
    );
  });
});
