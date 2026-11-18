import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  takeControlUiScreenshotFrame,
  waitForControlUiFrameLayout,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "iPad keyboard accessory clearance",
});

suite.define(() => {
  it.each([
    {
      label: "desktop-mode-ipad",
      platform: "MacIntel",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15",
      touch: 5,
      ipad: true,
    },
    {
      label: "mobile-ipad",
      platform: "iPad",
      userAgent: "Mozilla/5.0 (iPad; CPU OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148",
      touch: 5,
      ipad: true,
    },
    { label: "mac", platform: "MacIntel", userAgent: "Macintosh", touch: 0, ipad: false },
    { label: "touch-windows", platform: "Win32", userAgent: "Windows", touch: 10, ipad: false },
    { label: "iphone", platform: "iPhone", userAgent: "iPhone", touch: 5, ipad: false },
  ])(
    "keeps the action row stable on $label",
    async ({ label, platform, userAgent, touch, ipad }) => {
      await suite.withPage(
        {
          viewport: { width: 1200, height: 750 },
          hasTouch: touch > 0,
          userAgent,
          colorScheme: "dark",
        },
        async ({ page }) => {
          await page.addInitScript(
            (identity) => {
              Object.defineProperty(navigator, "platform", { value: identity.platform });
              Object.defineProperty(navigator, "maxTouchPoints", { value: identity.touch });
            },
            { platform, touch },
          );
          const gateway = await installMockGateway(page, { assistantName: "OpenClaw" });
          await page.goto(`${suite.server.baseUrl}chat`);
          await gateway.waitForRequest("sessions.messages.subscribe");
          const composer = page.locator(".agent-chat__input--chat");
          const textarea = composer.locator("textarea");
          const rightControlGap = () =>
            composer.evaluate((element) => {
              const controls = [...element.querySelectorAll("button, summary")].filter((control) =>
                control.checkVisibility(),
              );
              return (
                element.getBoundingClientRect().right -
                Math.max(...controls.map((control) => control.getBoundingClientRect().right))
              );
            });
          const expectButtonClearance = async () => {
            await waitForControlUiFrameLayout([composer]);
            const buttonWidth = await composer
              .locator(".agent-chat__composer-actions .chat-send-btn:visible")
              .last()
              .evaluate((button) => button.getBoundingClientRect().width);
            await expect.poll(rightControlGap).toBeGreaterThanOrEqual(buttonWidth);
            await expect.poll(rightControlGap).toBeLessThan(buttonWidth + 16);
            console.info("iPad clearance geometry", { buttonWidth, gap: await rightControlGap() });
          };
          if (ipad) {
            await page.setViewportSize({ width: 600, height: 1000 });
            await textarea.blur();
            await expect
              .poll(() => composer.getAttribute("data-composer-layout"))
              .toBe("single-line");
            for (const direction of ["ltr", "rtl"]) {
              await page.evaluate((value) => {
                document.documentElement.dir = value;
              }, direction);
              await expectButtonClearance();
            }
            await page.evaluate(() => {
              document.documentElement.dir = "ltr";
            });
            await page.setViewportSize({ width: 1200, height: 750 });
          }
          await textarea.fill("Please summarize the planning notes.");
          const send = composer.getByRole("button", { name: "Send message", exact: true });
          await send.waitFor();
          const gap = () =>
            send.evaluate((action) => {
              const element = action.closest(".agent-chat__input")!;
              return element.getBoundingClientRect().right - action.getBoundingClientRect().right;
            });
          if (label === "desktop-mode-ipad") {
            const frame = await takeControlUiScreenshotFrame(page, composer, [textarea, send], {
              animations: "disabled",
            });
            await writeFile(path.join(suite.artifactDir, "ipad-composer.png"), frame.png);
          }
          if (ipad) {
            await expectButtonClearance();
          } else {
            expect(await gap()).toBeGreaterThanOrEqual(6);
            expect(await gap()).toBeLessThan(16);
          }
          if (ipad) {
            await page.evaluate(() => {
              document.documentElement.dir = "rtl";
            });
            await expectButtonClearance();
            await page.evaluate(() => {
              document.documentElement.dir = "ltr";
            });
          }
          const focusedGap = await gap();
          await send.focus();
          expect(await gap()).toBe(focusedGap);
          if (ipad) {
            for (const width of [820, 600]) {
              await page.setViewportSize({ width, height: 1000 });
              await expectButtonClearance();
              await send.click({ trial: true });
            }
          }
          if (touch > 0) {
            await send.tap();
          } else {
            await send.click();
          }
          await gateway.waitForRequest("chat.send");
          expect(await gateway.getRequests("chat.send")).toHaveLength(1);
        },
      );
    },
  );
});
