import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI short desktop Logs" });
const lines = Array.from({ length: 255 }, (_, index) =>
  JSON.stringify({
    "0": JSON.stringify({ subsystem: "logs-height-e2e" }),
    "1": `Synthetic log entry ${index + 1}`,
    time: new Date(Date.UTC(2026, 8, 19, 12, 0, index)).toISOString(),
    _meta: { logLevelName: "info" },
  }),
);

suite.define(() => {
  it.each([
    { width: 933, height: 500, truncated: false },
    { width: 932, height: 501, truncated: true },
  ])("keeps both ends readable at $width × $height (truncated: $truncated)", async (size) => {
    await suite.withPage({ viewport: size, deviceScaleFactor: 1 }, async ({ page }) => {
      const config = { ui: { prefs: { theme: "phosphor", themeMode: "dark" } } };
      await installMockGateway(page, {
        methodResponses: {
          "config.get": { config, raw: JSON.stringify(config), hash: "logs-height", valid: true },
          "logs.tail": {
            file: `/tmp/openclaw/${"synthetic-long-directory/".repeat(4)}app-20260.log`,
            lines,
            cursor: lines.length,
            reset: true,
            truncated: size.truncated,
          },
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/general`);
      await page.locator('.settings-sidebar__item[href="/logs"]').click();
      await expect.poll(() => page.locator(".log-row").count()).toBe(lines.length);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
        .toBe("phosphor");
      await page.evaluate(() => document.fonts.ready);
      const follow = page.getByRole("switch", { name: "Auto-follow" });
      await follow.focus();
      await page.keyboard.press("Space");
      await expect.poll(() => follow.getAttribute("aria-checked")).toBe("false");

      const stream = page.locator(".log-stream");
      const first = page.locator(".log-row").first();
      const last = page.locator(".log-row").last();
      const rowHeight = await first.evaluate((row) => row.getBoundingClientRect().height);
      await expect
        .poll(() => stream.evaluate((element) => element.clientHeight))
        .toBeGreaterThan(rowHeight);
      expect(await stream.evaluate((element) => element.clientHeight)).toBeLessThan(size.height);

      const content = await page.locator("main.content").boundingBox();
      if (!content) {
        throw new Error("Logs content is not rendered");
      }
      // Scroll the outer gutter, then the bounded stream, just as a reader does.
      await page.mouse.move(content.x + 4, content.y + content.height / 2);
      await page.mouse.wheel(0, 100_000);
      await expect
        .poll(() => stream.evaluate((element) => element.getBoundingClientRect().bottom))
        .toBeLessThanOrEqual(content.y + content.height);
      await stream.hover();
      await page.mouse.wheel(0, -100_000);
      await expect.poll(() => stream.evaluate((element) => element.scrollTop)).toBe(0);
      await expect
        .poll(() => first.evaluate((row) => row.getBoundingClientRect().top))
        .toBeGreaterThanOrEqual(content.y);
      await page.mouse.wheel(0, 100_000);
      await expect
        .poll(() => last.evaluate((row) => row.getBoundingClientRect().bottom))
        .toBeLessThanOrEqual(content.y + content.height);
      expect(await follow.getAttribute("aria-checked")).toBe("false");
    });
  });
});
