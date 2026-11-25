import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Lobsterdex E2E",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([100, 140])(
    "keeps the phone badge and first card row in place at %i%% text when another tab records a tenth visit",
    async (scale) => {
      await suite.withPage(
        { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: "en-US" },
        async ({ page, context }) => {
          await installMockGateway(page);
          if (scale === 140) {
            await page.goto(suite.server.baseUrl + "settings/general");
            const typography = page.locator("#settings-appearance-typography");
            await typography.locator(".settings-segmented__btn").filter({ hasText: "140%" }).tap();
            await expect
              .poll(() => typography.locator(".settings-segmented__input:checked").inputValue())
              .toBe("140");
          }
          await page.goto(suite.server.baseUrl + "settings/lobsterdex");
          const grid = page.locator(".lobsterdex-page__grid");
          await grid.waitFor();
          const palettes = await grid
            .locator("article")
            .evaluateAll((cards) =>
              cards.slice(0, 10).map((card) => card.id.replace("lobsterdex-", "")),
            );
          const sibling = await context.newPage();
          await sibling.goto(suite.server.baseUrl + "favicon.ico");
          const record = (ids: string[]) =>
            sibling.evaluate(
              (entries) =>
                localStorage.setItem("openclaw.control.lobsterdex.v1", JSON.stringify(entries)),
              ids,
            );
          const count = page.locator(".lobsterdex-page__count");
          await record(palettes.slice(0, 9));
          await expect.poll(() => count.textContent()).toBe("9/52 visited");
          await page.evaluate(() => document.fonts.ready);
          const original = await grid.boundingBox();
          const trailingEdge = await count.evaluate((badge) => badge.getBoundingClientRect().right);
          await record(palettes);
          await expect.poll(() => count.textContent()).toBe("10/52 visited");
          expect(await count.evaluate((badge) => badge.getBoundingClientRect().right)).toBe(
            trailingEdge,
          );
          expect((await grid.boundingBox())!.y).toBe(original!.y);
          expect(
            await count.evaluate((badge) => {
              const range = document.createRange();
              range.selectNodeContents(badge);
              return range.getClientRects().length;
            }),
          ).toBe(1);
          await sibling.close();
        },
      );
    },
  );

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
