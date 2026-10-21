import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, pauseVirtualClock } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Gateway retry feedback" });

suite.define(() => {
  it("outlines Retry and tracks real attempts through failure, automatic retry, and success", () =>
    suite.withPage(
      {
        viewport: { width: 1280, height: 900 },
        colorScheme: "dark",
        reducedMotion: "no-preference",
      },
      async ({ page }) => {
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
        const retry = status.getByRole("button", {
          name: "Reconnecting… — Retry now",
          exact: true,
        });
        await retry.waitFor({ state: "visible" });
        const capture = async (name: string) => {
          const frame = await takeControlUiScreenshotFrame(page, status, [status], {
            elements: [page.locator(".sidebar-shell__footer")],
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, name + ".png"), frame.png);
        };
        await capture("retry-idle");
        expect(await retry.evaluate((button) => getComputedStyle(button).borderTopWidth)).toBe(
          "1px",
        );
        const background = await retry.evaluate(
          (button) => getComputedStyle(button).backgroundColor,
        );
        await retry.hover();
        expect(await retry.evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe(
          background,
        );
        await page.mouse.move(700, 400);
        await retry.focus();
        expect(await retry.evaluate((button) => getComputedStyle(button).boxShadow)).not.toBe(
          "none",
        );
        await capture("retry-focus");
        const count = await gateway.getSocketCount();
        // Two clicks in one task also exercise the synchronous owner guard before Solid flushes.
        await retry.evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
        await expect.poll(() => gateway.getSocketCount()).toBe(count + 1);
        await expect.poll(() => retry.getAttribute("aria-busy")).toBe("true");
        expect(await retry.isDisabled()).toBe(true);
        const spinner = retry.locator(".gateway-status__spinner");
        await spinner.waitFor({ state: "visible" });
        expect(
          await spinner.evaluate((element) => getComputedStyle(element).animationName),
        ).not.toBe("none");
        await capture("retry-pending");
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe(
          "none",
        );
        await gateway.closeLatest(1006, "synthetic failed retry");
        await expect.poll(() => retry.isDisabled()).toBe(false);
        expect(await retry.getAttribute("aria-busy")).toBe("false");
        expect(await spinner.count()).toBe(0);
        // The transport spreads its initial 800 ms backoff by up to 20%.
        await page.clock.runFor(1_000);
        await expect.poll(() => retry.getAttribute("aria-busy")).toBe("true");
        expect(await retry.isDisabled()).toBe(true);
        await gateway.setOnline(true);
        await page.clock.resume();
        await waitForControlUiGatewayReady(page);
        await status.waitFor({ state: "detached" });
      },
    ));
});
