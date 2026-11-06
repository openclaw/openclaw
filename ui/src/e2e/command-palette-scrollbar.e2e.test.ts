import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiElementScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Command palette scrollbar",
  // Chromium otherwise hides native scrollbars in headless mode.
  browserLaunchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] },
});

suite.define(() => {
  it("keeps only a draggable thumb on the overflowing palette input", async () => {
    await suite.withPage({ viewport: { width: 1200, height: 700 } }, async ({ page }) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".agent-chat__composer-combobox > textarea").waitFor();
      await page.keyboard.press("ControlOrMeta+K");
      const input = page.locator(".cmd-palette__input");
      await input.fill("a".repeat(1000));
      await input.press("Control+Home");
      await expect.poll(() => input.evaluate((element) => element.clientHeight)).toBe(66);
      await expect
        .poll(() => input.evaluate((element) => element.scrollHeight > element.clientHeight))
        .toBe(true);
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await writeFile(
          path.join(suite.artifactDir, "palette.png"),
          await takeControlUiElementScreenshot(page, page.locator(".cmd-palette"), [input]),
        );
      }
      // A non-auto standard width makes Chromium render native scrollbar chrome
      // instead of the custom thumb, even with ::-webkit-scrollbar rules present.
      expect(await input.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe(
        "auto",
      );
      const scrollbar = await input.evaluate((element) => ({
        track: getComputedStyle(element, "::-webkit-scrollbar-track").backgroundColor,
        thumb: getComputedStyle(element, "::-webkit-scrollbar-thumb").backgroundColor,
        inset: getComputedStyle(element, "::-webkit-scrollbar-thumb").borderLeftWidth,
        defaultInset: getComputedStyle(document.body, "::-webkit-scrollbar-thumb").borderLeftWidth,
      }));
      expect(scrollbar.track).toBe("rgba(0, 0, 0, 0)");
      expect(scrollbar.thumb).not.toBe("rgba(0, 0, 0, 0)");
      expect(scrollbar.inset).toBe("2px");
      expect(scrollbar.defaultInset).toBe("3px");
      await input.evaluate((element) =>
        element.style.setProperty("--scrollbar-thumb-inset", "1px"),
      );
      expect(
        await input.evaluate(
          (element) => getComputedStyle(element, "::-webkit-scrollbar-thumb").borderLeftWidth,
        ),
      ).toBe("1px");
      await input.evaluate((element) => element.style.removeProperty("--scrollbar-thumb-inset"));
      const box = await input.boundingBox();
      if (!box) {
        throw new Error("The palette input must be visible to drag its thumb");
      }
      const x = box.x + box.width - 4;
      await page.mouse.move(x, box.y + 9);
      await page.mouse.down();
      await page.mouse.move(x, box.y + box.height - 9, { steps: 6 });
      await page.mouse.up();
      await expect.poll(() => input.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    });
  });
});
