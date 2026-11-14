import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { computedStyles } from "./config-composer-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectStyles } from "./style-contract.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Gateway retry feedback" });

suite.define(() => {
  it.each([100, 140])("keeps automatic recovery stable at %i percent text scale", (textScale) =>
    suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        colorScheme: "dark",
        reducedMotion: "no-preference",
      },
      async ({ page }) => {
        await page.addInitScript(
          ({ settingsKey, textScale: scale }) => {
            localStorage.setItem(settingsKey, JSON.stringify({ textScale: scale }));
          },
          { settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl), textScale },
        );
        const gateway = await installMockGateway(page, {});
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        await page.clock.install();
        await pauseVirtualClock(page);
        await gateway.setOnline(false);
        await page.clock.runFor(2_001);
        await gateway.closeLatest(1006, "synthetic failed attempt");
        const status = page.locator(".sidebar-shell__connection .gateway-status");
        const spinnerLocator = status.locator(".session-run-spinner");
        const labelLocator = status.locator(".gateway-status__label");
        await status.getByText("Reconnecting…", { exact: true }).waitFor();

        expect(await status.getByRole("button").count()).toBe(0);
        expect(await spinnerLocator.count()).toBe(1);
        const stateBounds = await status.locator(".gateway-status__state").boundingBox();
        await expectStyles(spinnerLocator, {
          "border-top-color": (await computedStyles(labelLocator, ["color"])).color,
        });
        const spinner = await spinnerLocator.elementHandle();
        expect(await spinner!.evaluate((element) => getComputedStyle(element).animationName)).toBe(
          "btn-spinner-spin",
        );
        const animation = await spinner!.evaluateHandle((element) => element.getAnimations()[0]!);
        await animation.evaluate((current) => {
          current.pause();
          current.currentTime = 500;
        });
        const count = await gateway.getSocketCount();
        // This is the second attempt: 1,600 ms backoff with up to 20% jitter.
        await page.clock.runFor(2_000);
        expect(await gateway.getSocketCount()).toBe(count + 1);
        expect(await status.getByRole("button").count()).toBe(0);
        expect(await status.locator(".gateway-status__state").boundingBox()).toEqual(stateBounds);
        expect(await spinner!.evaluate((element) => element.isConnected)).toBe(true);
        expect(await animation.evaluate((current) => current.currentTime)).toBe(500);
        const aligned = async () => {
          const icon = await status.locator(".gateway-status__icon").boundingBox();
          const label = await labelLocator.boundingBox();
          expect(Math.abs(icon!.y + icon!.height / 2 - label!.y - label!.height / 2)).toBeLessThan(
            1,
          );
          expect(icon!.width).toBeCloseTo((12 * textScale) / 100, 1);
        };
        await aligned();

        await animation.evaluate((current) => current.play());
        await page.clock.resume();
        const moving = async () => {
          const before = await spinnerLocator.evaluate((element) => ({
            time: Number(element.getAnimations()[0]!.currentTime),
            transform: getComputedStyle(element).transform,
          }));
          // A full iteration can return to the same rotation; observe a distinct painted phase.
          await expect
            .poll(() =>
              spinnerLocator.evaluate(async (element, previous) => {
                await new Promise<void>((resolve) => {
                  requestAnimationFrame(() => resolve());
                });
                const current = element.getAnimations()[0]!;
                return {
                  advanced: Number(current.currentTime) > previous.time,
                  running: current.playState === "running",
                  changed: getComputedStyle(element).transform !== previous.transform,
                };
              }, before),
            )
            .toEqual({ advanced: true, running: true, changed: true });
        };
        await moving();
        await page.emulateMedia({ colorScheme: "light" });
        await aligned();
        // Read both colors in one frame after the asynchronous system-theme update.
        await expect
          .poll(() =>
            status.evaluate((element) => ({
              spinner: getComputedStyle(element.querySelector(".session-run-spinner")!)
                .borderTopColor,
              label: getComputedStyle(element.querySelector(".gateway-status__label")!).color,
            })),
          )
          .toEqual({ spinner: "rgb(146, 64, 14)", label: "rgb(146, 64, 14)" });
        await moving();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        await status.waitFor({ state: "visible" });
        await aligned();
        expect(await status.getByRole("button").count()).toBe(0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        await expectStyles(spinnerLocator, { "animation-name": "none" });
        await gateway.setOnline(true);
        await page.clock.resume();
        await waitForControlUiGatewayReady(page);
        await status.waitFor({ state: "detached" });
        await spinnerLocator.waitFor({ state: "detached" });
      },
    ),
  );
});
