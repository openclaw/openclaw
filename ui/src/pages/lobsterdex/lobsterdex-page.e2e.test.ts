import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Lobsterdex E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("aligns card text when a name wraps and only one lobster has a shiny date", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, locale: "en-US" },
      async ({ page }) => {
        await installMockGateway(page);
        await page.addInitScript(() => {
          localStorage.setItem(
            "openclaw.control.lobsterdex.v1",
            JSON.stringify({
              crimson: { name: "Copper", firstSeenAt: 1780704000000, shinySeenAt: 1785715200000 },
              blue: { name: "Harbor Keeper of the Northern Sound", firstSeenAt: 1783123200000 },
            }),
          );
        });
        await page.goto(`${suite.server.baseUrl}settings/lobsterdex`);
        const firstLines = (palette: string) =>
          page.locator(`#lobsterdex-${palette}`).evaluate((card) =>
            ["h3", ".lobsterdex-page__lore", "time"].map((selector) => {
              const range = document.createRange();
              range.selectNodeContents(card.querySelector(selector)!);
              return range.getClientRects()[0]!.top;
            }),
          );
        await page.getByRole("heading", { name: "Copper" }).waitFor();
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const copper = await firstLines("crimson");
        const harbor = await firstLines("blue");
        for (const [index, top] of copper.entries()) {
          expect(Math.abs(harbor[index]! - top)).toBeLessThanOrEqual(1);
        }
      },
    );
  });

  it("opens a saved card link without a Copy link button on the cards", async () => {
    await suite.withPage(
      { viewport: { width: 390, height: 844 }, locale: "en-US" },
      async ({ page }) => {
        await installMockGateway(page);
        await page.goto(`${suite.server.baseUrl}settings/lobsterdex#lobsterdex-taylorpinch`, {
          waitUntil: "commit",
        });
        const card = page.locator("#lobsterdex-taylorpinch");
        await page.locator("#lobsterdex-taylorpinch.lobsterdex-page__card--highlight").waitFor();
        await expect
          .poll(() =>
            card.evaluate((element) => {
              const { top, bottom } = element.getBoundingClientRect();
              return top >= 0 && bottom <= window.innerHeight;
            }),
          )
          .toBe(true);
        const cards = page.locator("openclaw-lobsterdex-page article");
        expect(await cards.getByRole("button", { name: "Copy link", exact: true }).count()).toBe(0);
      },
    );
  });
});
