import { chromium } from "playwright";
import { expect, inject, it } from "vitest";
import { renderPublicSessionDocument } from "../../../src/gateway/control-ui-public-session-render.js";

const { available, executablePath, wsEndpoint } = inject("controlUiE2eChromium");

it.skipIf(!available)(
  "keeps words readable in wide public transcript tables without widening the page",
  async () => {
    const browser = wsEndpoint
      ? await chromium.connect(wsEndpoint)
      : await chromium.launch({ executablePath });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const identifier = "north-coast_" + "fieldwork".repeat(24);
      const html = renderPublicSessionDocument({
        title: "Field guide",
        messages: [
          {
            role: "assistant",
            content: [
              "| Observation | Survey lead | Start | Tide window | Meet at | Backup stop | Equipment | Access notes |",
              "| --- | --- | --- | --- | --- | --- | --- | --- |",
              "| Reed inlet | Mira | 08:30 | Low tide | North gate | South ridge | Anemometer | Step-free access |",
              "",
              "| Identifier | Start |",
              "| --- | --- |",
              "| " + identifier + " | 08:30 |",
            ].join("\n"),
          },
        ],
        truncated: false,
        latestUrl: "/chat/main/guide",
        cardUrl: "/card.png",
        assetBasePath: "",
      });
      await page.setContent(html);
      const wide = page.getByRole("table").first();
      const equipment = wide.getByRole("columnheader", { name: "Equipment" });
      expect(
        await equipment.evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return range.getClientRects().length;
        }),
      ).toBe(1);
      await page.locator(".reader-actions .primary").focus();
      await page.keyboard.press("Tab");
      expect(await wide.evaluate((element) => element === document.activeElement)).toBe(true);
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => wide.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
      const identifiers = page.getByRole("table").last();
      expect(await identifiers.getByRole("cell", { name: identifier }).textContent()).toBe(
        identifier,
      );
      expect(
        await identifiers.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
    } finally {
      await browser.close();
    }
  },
);
