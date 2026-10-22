import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readStyleSheet } from "../../../test/helpers/ui-style-fixtures.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const describeSrOnly = canRunPlaywrightChromium(chromiumExecutablePath) ? describe : describe.skip;

let browser: Browser;

beforeAll(async () => {
  if (!canRunPlaywrightChromium(chromiumExecutablePath)) {
    return;
  }
  browser = await chromium.launch({ executablePath: chromiumExecutablePath, headless: true });
});

afterAll(async () => {
  await browser?.close().catch(() => {});
});

describeSrOnly("screen-reader-only utility", () => {
  it.each([
    ["sr-only", "inset(50%)"],
    ["settings-control__sr-label", "none"],
    ["cron-required-sr", "none"],
  ])("visually hides %s while preserving its accessible status", async (className, clipPath) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<!doctype html>
        <html>
          <head><style>${[
            "ui/src/styles/base.css",
            "ui/src/styles/settings-controls.css",
            "ui/src/styles/cron.css",
          ]
            .map(readStyleSheet)
            .join("\n")}</style></head>
          <body><span class="${className}" role="status">Background task active</span></body>
        </html>`);

      const status = page.getByRole("status");
      await expect
        .poll(async () => {
          return await status.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              borderWidth: style.borderWidth,
              clip: style.clip,
              clipPath: style.clipPath,
              height: style.height,
              margin: style.margin,
              overflow: style.overflow,
              padding: style.padding,
              position: style.position,
              whiteSpace: style.whiteSpace,
              width: style.width,
            };
          });
        })
        .toEqual({
          borderWidth: "0px",
          clip: "rect(0px, 0px, 0px, 0px)",
          clipPath,
          height: "1px",
          margin: "-1px",
          overflow: "hidden",
          padding: "0px",
          position: "absolute",
          whiteSpace: "nowrap",
          width: "1px",
        });
      expect(await status.ariaSnapshot()).toContain("Background task active");
    } finally {
      await page.close().catch(() => {});
    }
  });
});
