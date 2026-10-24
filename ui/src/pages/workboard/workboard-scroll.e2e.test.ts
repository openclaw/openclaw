import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import {
  cardFitsWithinWorkboardContent,
  createMobileScrollCards,
  expectedMobileScrollGeometry,
  readMobileScrollGeometry,
} from "./workboard-scroll.e2e.test-support.ts";
import { configSnapshot, makeBoard } from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard mobile scroll E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const baseTime = Date.parse("2026-06-01T18:00:00.000Z");

suite.define(() => {
  it("scrolls every mobile column card into view while keeping the toolbar available", async () => {
    await suite.withPage({}, async ({ page }) => {
      const cards = createMobileScrollCards(baseTime);
      await page.setViewportSize({ height: 700, width: 390 });
      await installMockGateway(page, {
        ...workboardUi,
        sessions: [],
        methodResponses: {
          "config.get": configSnapshot("workboard-mobile-scroll-e2e-config"),
          "workboard.cards.list": {
            boards: [makeBoard("default", { total: cards.length, active: cards.length })],
            cards,
            statuses: WORKBOARD_STATUSES,
          },
        },
      });

      expect((await page.goto(`${suite.server.baseUrl}workboard`))?.status()).toBe(200);
      const content = page.locator(".content--workboard");
      const board = page.locator(".workboard-board");
      const columnCards = page.locator(".workboard-column--todo .workboard-column__cards");
      const toolbar = page.locator(".workboard-toolbar");
      const lastCard = page
        .locator(".workboard-column--todo .workboard-card", {
          hasText: "Mobile workboard card 6",
        })
        .first();
      await lastCard.waitFor({ state: "attached" });

      expect(await readMobileScrollGeometry(columnCards, "Mobile workboard card 6")).toEqual(
        expectedMobileScrollGeometry,
      );
      const initialToolbarTop = await toolbar.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await columnCards.hover();
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (await cardFitsWithinWorkboardContent(lastCard)) {
          break;
        }
        const previousScrollTop = await columnCards.evaluate((element) => element.scrollTop);
        await page.mouse.wheel(0, 320);
        await expect
          .poll(() => columnCards.evaluate((element) => element.scrollTop))
          .toBeGreaterThan(previousScrollTop);
      }
      await expect
        .poll(() => columnCards.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      expect(await cardFitsWithinWorkboardContent(lastCard)).toBe(true);
      expect(await toolbar.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(
        initialToolbarTop,
        0,
      );
      expect(await board.evaluate((element) => element.scrollTop)).toBe(0);
      expect(await content.evaluate((element) => element.scrollTop)).toBe(0);
    });
  });
});
