import type { WorkboardBoardSummary, WorkboardCard } from "@openclaw/workboard-contract";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  WORKBOARD_CHANGED_EVENT,
  WORKBOARD_STATUSES,
} from "../../../../packages/workboard-contract/src/index.js";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiProofSurface } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, type MockGatewayControls } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { openPicker } from "../../test-helpers/select-picker-e2e.ts";
import {
  button,
  configSnapshot,
  makeBoard,
  makeCard as card,
} from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI Workboard mocked Gateway E2E" });

const viewport = { height: 1000, width: 2400 };
const withPage = (run: (page: Page) => Promise<void>) =>
  suite.withPage({ viewport, locale: "en-US", serviceWorkers: "block" }, ({ page }) => run(page));
async function openWorkboardFilters(page: Page): Promise<void> {
  const trigger = page.locator(".workboard-filter-trigger");
  const panel = page.locator(".workboard-filter-popover__panel");
  if (!(await panel.isVisible())) {
    await trigger.click();
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
  }
  await panel.waitFor();
}

async function chooseWorkboardDisplayOption(page: Page, option: string) {
  await openWorkboardFilters(page);
  await page
    .getByRole("group", { name: "Empty columns", exact: true })
    .getByRole("button", { name: option, exact: true })
    .click();
}

async function openWorkboardBoardPicker(page: Page) {
  await openWorkboardFilters(page);
  const picker = page.locator("openclaw-select-picker").filter({
    has: page.getByRole("button", { name: /^Filter by board:/u }),
  });
  await openPicker(picker);
  return picker;
}

async function chooseWorkboardBoard(page: Page, boardId: string) {
  const picker = await openWorkboardBoardPicker(page);
  await picker.locator(`[role="option"][data-value="${boardId}"]`).click();
}

async function closeWorkboardFilters(page: Page) {
  const popover = page.locator(".workboard-filter-popover");
  if (await page.locator(".workboard-filter-popover__panel").isVisible()) {
    await popover.evaluate((element) => {
      (element as HTMLElement).hidePopover();
    });
    await expect.poll(() => page.locator(".workboard-filter-popover__panel").isHidden()).toBe(true);
  }
}

async function requestCount(gateway: MockGatewayControls, method: string): Promise<number> {
  return (await gateway.getRequests(method)).length;
}

function cardsListResponse(
  cards: WorkboardCard[],
  boards: WorkboardBoardSummary[] = [
    makeBoard("default", { total: cards.length, active: cards.length }),
  ],
) {
  return { boards, cards, statuses: WORKBOARD_STATUSES };
}

function installWorkboard(
  page: Page,
  cards: WorkboardCard[],
  extra: Parameters<typeof installMockGateway>[1] = {},
) {
  return installMockGateway(page, {
    ...workboardUi,
    ...extra,
    methodResponses: {
      "config.get": configSnapshot("workboard-e2e-config", true, 2),
      "workboard.cards.list": cardsListResponse(cards),
      ...extra.methodResponses,
    },
  });
}

function statusColumn(page: Page, status: string) {
  const statusClass = status.trim().toLowerCase().replaceAll(/\s+/gu, "-");
  return page.locator(`.workboard-column--${statusClass}`).first();
}

function cardInColumn(page: Page, status: string, title: string) {
  return statusColumn(page, status).locator(".workboard-card", { hasText: title }).first();
}

const style = (locator: Locator, property: string) =>
  locator.evaluate((element, key) => getComputedStyle(element).getPropertyValue(key), property);
const opacity = (locator: Locator) => style(locator, "opacity");
const width = (locator: Locator) =>
  locator.evaluate((element) => element.getBoundingClientRect().width);

async function clickCardAction(cardLocator: Locator, name: string) {
  await cardLocator.hover();
  await cardLocator.locator(".workboard-card__menu-trigger").click();
  await cardLocator
    .page()
    .getByRole("dialog", { name: "Card actions", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
}

suite.define(() => {
  it("defers card refresh during edits while keeping catalog metadata live", async () => {
    const runningCard = card({
      id: "card-1",
      title: "Running task",
      status: "running",
    });
    const refreshed = {
      ...runningCard,
      title: "Refreshed task",
      updatedAt: runningCard.updatedAt + 1,
    };
    await withPage(async (page) => {
      await page.clock.install();
      const gateway = await installWorkboard(page, [runningCard]);
      await page.goto(suite.server.baseUrl + "workboard");
      const tile = cardInColumn(page, "Running", runningCard.title);
      await tile.waitFor();
      await clickCardAction(tile, "Edit card");
      const form = page.locator(".workboard-draft");
      await form.getByLabel("Notes").fill("Keep unfinished notes");
      const reads = await requestCount(gateway, "workboard.cards.list");
      const boardReads = await requestCount(gateway, "workboard.boards.list");
      const response = cardsListResponse([refreshed]);
      response.boards.push(makeBoard("live", { name: "Live metadata" }));
      await gateway.setMethodResponse("workboard.cards.list", response);
      await gateway.setMethodResponse("workboard.boards.list", { boards: response.boards });
      await gateway.deferNext("workboard.boards.list");
      await gateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
        epoch: "refresh-proof",
        revision: 1,
      });
      await gateway.waitForRequest("workboard.boards.list", { after: boardReads });
      await gateway.resolveDeferred("workboard.boards.list");
      expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(reads);
      expect(await form.getByLabel("Notes").inputValue()).toBe("Keep unfinished notes");
      expect(await tile.getByRole("heading", { includeHidden: true }).textContent()).toBe(
        runningCard.title,
      );
      expect(
        await page
          .getByRole("heading", { name: refreshed.title, exact: true, includeHidden: true })
          .count(),
      ).toBe(0);
      await gateway.deferNext("workboard.cards.list");
      await button(form.locator(":scope > .workboard-modal__actions"), "Cancel").click();
      await button(page.locator(".workboard-discard"), "Discard").click();
      await gateway.waitForRequest("workboard.cards.list", { after: reads });
      const picker = await openWorkboardBoardPicker(page);
      await expect
        .poll(() => picker.getByRole("option", { name: /Live metadata/u }).count())
        .toBe(1);
      await picker.locator(".picker-select__trigger").click();
      await picker.locator(".picker-select__menu").waitFor({ state: "hidden" });
      await closeWorkboardFilters(page);
      await gateway.resolveDeferred("workboard.cards.list");
      await cardInColumn(page, "Running", refreshed.title).waitFor();
      const finalReads = await requestCount(gateway, "workboard.cards.list");
      await page.clock.fastForward(1_250);
      expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(finalReads);
    });
  });

  it("keeps read-only cards inspectable without mutation controls", async () => {
    const runningCard = card({ id: "read-only", title: "Inspect only", status: "running" });
    await withPage(async (page) => {
      await installWorkboard(page, [runningCard], {
        operatorScopes: ["operator.read"],
      });
      await page.goto(`${suite.server.baseUrl}workboard`);
      await cardInColumn(page, "Running", runningCard.title).waitFor();
      await cardInColumn(page, "Running", runningCard.title).click();
      await page.locator(".workboard-detail").getByText(runningCard.title).waitFor();
      const readOnlyDetail = page.locator(".workboard-detail");
      for (const name of [/^Status:/u, "Edit card", "Archive card", "Delete card"]) {
        expect(await readOnlyDetail.getByRole("button", { name }).count()).toBe(0);
      }
      expect(await page.locator(".workboard-detail__note").count()).toBe(0);
      expect(await page.getByRole("button", { name: /Add note/u }).count()).toBe(0);
    });
  });

  it("keeps card titles visible when a column overflows its height", async () => {
    const overflowTitle = (index: number) =>
      `Overflowing backlog card ${index + 1} with a long title that wraps onto two lines`;
    const crowdedCards = Array.from({ length: 8 }, (_, index) =>
      card({ id: `overflow-${index}`, title: overflowTitle(index), position: 1000 + index }),
    );
    await withPage(async (page) => {
      await installWorkboard(page, crowdedCards);
      await page.setViewportSize({ height: 720, width: 1400 });
      await page.goto(`${suite.server.baseUrl}workboard`);
      const column = statusColumn(page, "Todo");
      await column.waitFor();
      await cardInColumn(page, "Todo", overflowTitle(0)).waitFor();

      const titleHeights = await column
        .locator(".workboard-card h3")
        .evaluateAll((titles) => titles.map((title) => title.getBoundingClientRect().height));
      expect(titleHeights).toHaveLength(crowdedCards.length);
      for (const height of titleHeights) {
        // Squeezed implicit grid rows previously collapsed the line-clamped title to 0px.
        expect(height).toBeGreaterThan(0);
      }

      const columnScrolls = await column
        .locator(".workboard-column__cards")
        .evaluate((cards) => cards.scrollHeight > cards.clientHeight + 1);
      expect(columnScrolls).toBe(true);
    });
  });

  it("collapses empty stages into rails without squeezing active columns", async () => {
    const reviewCard = card({ id: "review", status: "review", title: "Review work" });
    const doneCard = card({ id: "done", status: "done", title: "Completed work" });
    await withPage(async (page) => {
      const gateway = await installWorkboard(page, [reviewCard, doneCard], {
        methodResponses: {
          "workboard.cards.move": { card: { ...reviewCard, status: "ready" } },
        },
      });
      await page.setViewportSize({ height: 760, width: 1200 });
      await page.goto(`${suite.server.baseUrl}workboard`);
      await page.locator(".workboard-column--review .workboard-card").waitFor();

      const reviewColumn = statusColumn(page, "Review");
      const reviewHeader = reviewColumn.locator(".workboard-column__header");
      const collapseButton = reviewHeader.getByRole("button", { name: "Collapse Review column" });
      expect(await opacity(collapseButton)).toBe("0");
      for (const [action, expected] of [
        [() => collapseButton.focus(), "1"],
        [() => collapseButton.blur(), "0"],
        [() => reviewHeader.hover(), "1"],
      ] as const) {
        await action();
        await expect.poll(() => opacity(collapseButton)).toBe(expected);
      }

      await chooseWorkboardDisplayOption(page, "Collapse empty");
      const readyColumn = statusColumn(page, "ready");
      await readyColumn.getByRole("button", { name: "Expand Ready column" }).waitFor();
      const collapsedWidth = await width(readyColumn);
      const reviewWidth = await width(reviewColumn);
      expect(collapsedWidth).toBeGreaterThanOrEqual(44);
      expect(collapsedWidth).toBeLessThanOrEqual(52);
      expect(reviewWidth).toBeGreaterThanOrEqual(262);

      const readyRail = readyColumn.locator(".workboard-column__rail");
      expect(await style(readyRail, "box-shadow")).toBe("none");

      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(
        await Promise.all(
          ["collapse", "rail-icon"].map((part) =>
            style(page.locator(`.workboard-column__${part}`).first(), "transition-duration"),
          ),
        ),
      ).toEqual(["0s", "0s"]);
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await page.getByRole("button", { name: "Expand Ready column" }).click();
      await expect
        .poll(() => statusColumn(page, "ready").getAttribute("class"))
        .not.toContain("workboard-column--collapsed");
      const expandedWidth = await width(readyColumn);
      expect(expandedWidth).toBeGreaterThanOrEqual(262);
      await page.getByRole("button", { name: "Collapse Ready column" }).click();

      await closeWorkboardFilters(page);
      await page
        .locator(".workboard-status-tabs")
        .getByRole("button", { name: "Review", exact: true })
        .click();
      const singleColumnBoard = page.locator(
        ".workboard-board--page.workboard-board--single-column",
      );
      const singleColumnGeometry = await singleColumnBoard.evaluate((board) => {
        const column = board.querySelector(".workboard-column") as HTMLElement;
        return {
          leftOffset: column.getBoundingClientRect().left - board.getBoundingClientRect().left,
          columnWidth: column.getBoundingClientRect().width,
        };
      });
      expect(singleColumnGeometry.columnWidth).toBeCloseTo(reviewWidth, 0);
      expect(singleColumnGeometry.leftOffset).toBeCloseTo(0, 0);
      await page
        .locator(".workboard-status-tabs")
        .getByRole("button", { name: "All", exact: true })
        .click();
      await closeWorkboardFilters(page);
      // Clear the single-column view's retained scroll offset so both drag endpoints are visible.
      const board = page.locator(".workboard-board--page");
      await board.evaluate((element) => element.scrollTo({ left: 0, behavior: "instant" }));
      await expect.poll(() => board.evaluate((element) => element.scrollLeft)).toBe(0);

      const moveCount = await requestCount(gateway, "workboard.cards.move");
      const dragged = reviewColumn.locator(".workboard-card");
      await dragged.dispatchEvent("dragstart");
      await expect.poll(() => opacity(dragged)).toBe("0.45");
      await dragged.dispatchEvent("dragend");
      await dragged.dragTo(readyRail);
      const moveRequest = await gateway.waitForRequest("workboard.cards.move", {
        after: moveCount,
      });
      expect(moveRequest.params).toMatchObject({ id: reviewCard.id, status: "ready" });

      await page.setViewportSize({ height: 760, width: 700 });
      const backlogColumn = statusColumn(page, "backlog");
      const backlogRail = backlogColumn.getByRole("button", { name: "Expand Backlog column" });
      await backlogRail.scrollIntoViewIfNeeded();
      await backlogRail.focus();
      await page.keyboard.press("Enter");
      const collapseBacklog = backlogColumn.getByRole("button", {
        name: "Collapse Backlog column",
      });
      await expect.poll(() => collapseBacklog.isVisible()).toBe(true);
      await expect
        .poll(() =>
          backlogColumn.getByRole("button", { name: "New card in Backlog" }).last().isVisible(),
        )
        .toBe(true);
      await collapseBacklog.click();
      await expect.poll(() => backlogRail.isVisible()).toBe(true);
    });
  });

  it("keeps touch collapse controls visible and at least 44px", async () => {
    await suite.withPage({ hasTouch: true }, async ({ page }) => {
      await installWorkboard(page, [
        card({ id: "touch-review-card", status: "review", title: "Review on touch" }),
      ]);
      await page.setViewportSize({ height: 844, width: 390 });
      await page.goto(`${suite.server.baseUrl}workboard`);

      const collapseButton = page.getByRole("button", { name: "Collapse Review column" });
      await collapseButton.waitFor();
      await waitForControlUiProofSurface(collapseButton, []);
      const touchGeometry = await collapseButton.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          height: bounds.height,
          opacity: getComputedStyle(element).opacity,
          width: bounds.width,
        };
      });
      expect(touchGeometry.opacity).toBe("1");
      expect(touchGeometry.width).toBeGreaterThanOrEqual(44);
      expect(touchGeometry.height).toBeGreaterThanOrEqual(44);
    });
  });

  it("replaces the URL when selecting boards without adding history", async () => {
    const boards = [makeBoard("default"), makeBoard("ops", { name: "Operations" })];
    await withPage(async (page) => {
      await installWorkboard(page, [], {
        methodResponses: {
          "workboard.boards.list": { boards },
          "workboard.cards.list": cardsListResponse([], boards),
        },
      });
      await page.goto(suite.server.baseUrl + "workboard?board=ops&agent=main");
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard/ops");
      expect(new URL(page.url()).searchParams.has("board")).toBe(false);
      const historyLength = await page.evaluate(() => history.length);
      for (const [id, pathname] of [
        ["__all__", "/workboard"],
        ["ops", "/workboard/ops"],
      ] as const) {
        await chooseWorkboardBoard(page, id);
        await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
        expect(new URL(page.url()).search).toBe("?agent=main");
      }
      expect(await page.evaluate(() => history.length)).toBe(historyLength);
    });
  });
});
