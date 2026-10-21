import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  pauseVirtualClock,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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
        const gateway = await installMockGateway(page, {
          historyMessages: [
            { role: "user", content: [{ type: "text", text: "Check the deployment checklist." }] },
            {
              role: "assistant",
              content: [{ type: "text", text: "The checklist is ready for review." }],
            },
          ],
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        await waitForControlUiGatewayReady(page);
        await page.getByText("The checklist is ready for review.", { exact: true }).waitFor();
        await page.clock.install();
        await pauseVirtualClock(page);
        await gateway.setOnline(false);
        await page.clock.runFor(2_001);
        await gateway.closeLatest(1006, "synthetic failed attempt");
        const status = page.locator(".sidebar-shell__footer .gateway-status");
        await status.getByText("Reconnecting…", { exact: true }).waitFor();
        const capture = async (name: string) => {
          const frame = await takeControlUiScreenshotFrame(page, status, [status], {
            elements: [page.locator(".sidebar-shell__footer")],
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
          await writeFile(
            path.join(suite.artifactDir, name + "-footer.png"),
            frame.elements[0]!.png,
          );
        };
        expect(await status.getByRole("button").count()).toBe(0);
        expect(await status.locator(".session-run-spinner").count()).toBe(1);
        const stateBounds = await status.locator(".gateway-status__state").boundingBox();
        expect(
          await status
            .locator(".session-run-spinner")
            .evaluate((element) => getComputedStyle(element).borderTopColor),
        ).toBe(
          await status
            .locator(".gateway-status__label")
            .evaluate((element) => getComputedStyle(element).color),
        );
        await capture("reconnecting-backoff");
        const spinner = await status.locator(".session-run-spinner").elementHandle();
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
          const label = await status.locator(".gateway-status__label").boundingBox();
          expect(Math.abs(icon!.y + icon!.height / 2 - label!.y - label!.height / 2)).toBeLessThan(
            1,
          );
          expect(icon!.width).toBeCloseTo((12 * textScale) / 100, 1);
        };
        await aligned();
        await capture("reconnecting-attempt");

        await animation.evaluate((current) => current.play());
        await page.clock.resume();
        const moving = async () => {
          const movement = await status
            .locator(".session-run-spinner")
            .evaluate(async (element) => {
              const current = element.getAnimations()[0]!;
              const before = Number(current.currentTime);
              const transform = getComputedStyle(element).transform;
              await new Promise<void>((resolve) => {
                element.addEventListener("animationiteration", () => resolve(), { once: true });
              });
              return {
                advanced: Number(current.currentTime) > before,
                running: current.playState === "running",
                changed: getComputedStyle(element).transform !== transform,
              };
            });
          expect(movement).toEqual({ advanced: true, running: true, changed: true });
        };
        await moving();
        await page.emulateMedia({ colorScheme: "light" });
        await aligned();
        expect(
          await status
            .locator(".session-run-spinner")
            .evaluate((element) => getComputedStyle(element).borderTopColor),
        ).toBe(
          await status
            .locator(".gateway-status__label")
            .evaluate((element) => getComputedStyle(element).color),
        );
        await capture("reconnecting-light");
        await moving();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
        await status.waitFor({ state: "visible" });
        await aligned();
        await capture("reconnecting-mobile");
        expect(await status.getByRole("button").count()).toBe(0);
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(
          await status
            .locator(".session-run-spinner")
            .evaluate((element) => getComputedStyle(element).animationName),
        ).toBe("none");
        await gateway.setOnline(true);
        await page.clock.resume();
        await waitForControlUiGatewayReady(page);
        await status.waitFor({ state: "detached" });
      },
    ),
  );
});
