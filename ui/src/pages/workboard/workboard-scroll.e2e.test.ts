import { WORKBOARD_STATUSES } from "@openclaw/workboard-contract";
import type { Locator } from "playwright";
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
  it("updates scroll fades after growth, column expansion, and detail tab changes", async () => {
    await suite.withPage({ viewport: { height: 700, width: 390 } }, async ({ page }) => {
      const cards = createMobileScrollCards(baseTime);
      cards[0]!.notes = "Synthetic detail paragraph.\n\n".repeat(40);
      const response = (rows: typeof cards) => ({
        boards: [makeBoard("default", { total: rows.length, active: rows.length })],
        cards: rows,
        statuses: WORKBOARD_STATUSES,
      });
      const initial = response(cards.slice(0, 1));
      const gateway = await installMockGateway(page, {
        ...workboardUi,
        sessions: [],
        methodResponses: {
          "config.get": configSnapshot("workboard-scroll-fades-e2e-config"),
          "workboard.boards.list": { boards: initial.boards },
          "workboard.cards.list": initial,
        },
      });
      const fades = (viewport: Locator) =>
        viewport.evaluate((element) => ({
          scrollable: element.hasAttribute("data-scrollable"),
          top: element.style.getPropertyValue("--workboard-fade-top"),
          bottom: element.style.getPropertyValue("--workboard-fade-bottom"),
        }));
      const noFade = { scrollable: false, top: "0px", bottom: "0px" };
      const bottomFade = { scrollable: true, top: "0px", bottom: "24px" };

      await page.goto(`${suite.server.baseUrl}workboard`);
      const column = page.locator(".workboard-column--todo");
      const viewport = column.locator(".workboard-column__cards");
      await column.locator(".workboard-card").waitFor();
      await expect.poll(() => fades(viewport)).toEqual(noFade);

      const grown = response(cards);
      await gateway.setMethodResponse("workboard.boards.list", { boards: grown.boards });
      await gateway.setMethodResponse("workboard.cards.list", grown);
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "scroll-fade-growth",
        revision: 1,
      });
      await expect.poll(() => column.locator(".workboard-card").count()).toBe(cards.length);
      await expect.poll(() => fades(viewport)).toEqual(bottomFade);
      expect(await viewport.evaluate((element) => getComputedStyle(element).maskImage)).not.toBe(
        "none",
      );

      // A scroll must update the fade during the event, without waiting for another frame.
      expect(
        await viewport.evaluate((element) => {
          element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
          element.dispatchEvent(new Event("scroll"));
          return {
            top: element.style.getPropertyValue("--workboard-fade-top"),
            bottom: element.style.getPropertyValue("--workboard-fade-bottom"),
          };
        }),
      ).toEqual({ top: "24px", bottom: "24px" });

      await column.locator(".workboard-column__collapse").click();
      await column.locator(".workboard-column__rail").click();
      await expect.poll(() => fades(viewport)).toEqual(bottomFade);

      await column.locator(".workboard-card").first().click();
      const detail = page.locator(".workboard-detail__body");
      await expect.poll(() => fades(detail)).toEqual(bottomFade);
      await page.locator("#workboard-detail-tab-activity").click();
      await expect.poll(() => fades(detail)).toEqual(noFade);
      await page.locator("#workboard-detail-tab-overview").click();
      await expect.poll(() => fades(detail)).toEqual(bottomFade);
      await page.locator(".workboard-detail__close").click();

      const boundaryCards = Array.from({ length: 25 }, (_, index) => ({
        ...cards[index % cards.length]!,
        id: `boundary-card-${index}`,
        title: `Boundary card ${index + 1}`,
        position: (index + 1) * 1000,
      }));
      // Cross both directions between normal flow and the virtual spacer.
      for (const [revision, count] of [24, 25, 24].entries()) {
        const next = response(boundaryCards.slice(0, count));
        await gateway.setMethodResponse("workboard.boards.list", { boards: next.boards });
        await gateway.setMethodResponse("workboard.cards.list", next);
        await gateway.emitGatewayEvent("plugin.workboard.changed", {
          epoch: "scroll-fade-window-boundary",
          revision: revision + 1,
        });
        await expect.poll(() => column.getAttribute("aria-label")).toBe(`Todo, ${count}`);
        if (count === 25) {
          await expect.poll(() => column.locator(".workboard-card").count()).toBeLessThan(count);
        } else {
          await expect.poll(() => column.locator(".workboard-card").count()).toBe(count);
        }
        await viewport.evaluate((element) => {
          element.scrollTop = element.scrollHeight;
        });
        const last = column.locator(
          `.workboard-column__item[data-card-id="boundary-card-${count - 1}"] .workboard-card`,
        );
        await expect.poll(() => cardFitsWithinWorkboardContent(last)).toBe(true);
        await expect
          .poll(() => fades(viewport))
          .toEqual({
            scrollable: true,
            top: "24px",
            bottom: "0px",
          });
      }

      await page.locator(".workboard-filter-trigger").click();
      await page
        .getByRole("group", { name: "Layout", exact: true })
        .getByRole("button", { name: "List", exact: true })
        .click();
      await page.keyboard.press("Escape");
      const list = page.locator(".workboard-board--list");
      await list.waitFor();
      await expect.poll(() => column.locator(".workboard-card").count()).toBe(24);
      expect(
        await viewport.evaluate((element) => {
          const viewportBounds = element.getBoundingClientRect();
          const rows = [...element.querySelectorAll(".workboard-card")].map((row) =>
            row.getBoundingClientRect(),
          );
          return {
            fitsWidth: rows.every(
              (row) => row.left >= viewportBounds.left - 1 && row.right <= viewportBounds.right + 1,
            ),
            rowGap: rows[1]!.top - rows[0]!.bottom,
            scrollTop: element.scrollTop,
          };
        }),
      ).toEqual({ fitsWidth: true, rowGap: 0, scrollTop: 0 });
      const lastListCard = column.locator(".workboard-card").last();
      await lastListCard.scrollIntoViewIfNeeded();
      expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      expect(await viewport.evaluate((element) => element.scrollTop)).toBe(0);
    });
  });

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
