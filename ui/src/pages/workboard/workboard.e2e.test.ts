import type { WorkboardBoardSummary, WorkboardCard } from "@openclaw/workboard-contract";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  WORKBOARD_CHANGED_EVENT,
  WORKBOARD_STATUSES,
} from "../../../../packages/workboard-contract/src/index.js";
import { createRequireRecord } from "../../../../test/helpers/record.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiProofSurface } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import { openPicker } from "../../test-helpers/select-picker-e2e.ts";
import {
  configSnapshot,
  createWorkboardProof,
  makeBoard,
  makeCard,
  moved,
} from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard mocked Gateway E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const viewport = { height: 1000, width: 2400 };
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const linkedSessionKey = "agent:main:workboard-proof";
const linkedSessionName = "Implementation session";

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

async function setWorkboardDraftField(
  scope: Page | Locator,
  label: string,
  value: string,
): Promise<void> {
  const input = scope.getByLabel(label);
  await input.fill(value);
  await expect.poll(() => input.inputValue()).toBe(value);
}

async function requestCount(gateway: MockGatewayControls, method: string): Promise<number> {
  return (await gateway.getRequests(method)).length;
}

function sessionsListResponse(sessions: GatewaySessionRow[]) {
  return {
    count: sessions.length,
    defaults: {
      contextTokens: null,
      model: "gpt-5.5",
      modelProvider: "openai",
    },
    path: "",
    sessions,
    ts: baseTime,
  };
}

function sessionRow(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    displayName: linkedSessionName,
    hasActiveRun: false,
    key: linkedSessionKey,
    kind: "direct",
    label: linkedSessionName,
    updatedAt: baseTime,
    ...overrides,
  };
}

function card(
  overrides: Partial<WorkboardCard> & Pick<WorkboardCard, "id" | "title">,
): WorkboardCard {
  return makeCard({ notes: "", ...overrides }, baseTime);
}

function cardsListResponse(
  cards: WorkboardCard[],
  boards: WorkboardBoardSummary[] = [
    makeBoard("default", { total: cards.length, active: cards.length }),
  ],
) {
  return {
    boards,
    cards,
    statuses: WORKBOARD_STATUSES,
  };
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
      "sessions.list": sessionsListResponse([]),
      "workboard.cards.list": cardsListResponse(cards),
      ...extra.methodResponses,
    },
  });
}

function setCards(gateway: MockGatewayControls, cards: WorkboardCard[]) {
  return gateway.setMethodResponse("workboard.cards.list", cardsListResponse(cards));
}

function statusColumn(page: Page, status: string) {
  const statusClass = status.trim().toLowerCase().replaceAll(/\s+/gu, "-");
  return page.locator(`.workboard-column--${statusClass}`).first();
}

function cardInColumn(page: Page, status: string, title: string) {
  return statusColumn(page, status).locator(".workboard-card", { hasText: title }).first();
}

const opacity = (locator: Locator) =>
  locator.evaluate((element) => getComputedStyle(element).opacity);
const width = (locator: Locator) =>
  locator.evaluate((element) => element.getBoundingClientRect().width);

async function clickCardAction(cardLocator: Locator, name: string) {
  await cardLocator.hover();
  await cardLocator.locator(".workboard-card__menu-trigger").click();
  await cardLocator.getByRole("button", { name, exact: true }).click();
}

suite.define(() => {
  it("persists Workboard create, edit, running move, lifecycle sync, reload, and read-only state", async () => {
    const proof = createWorkboardProof(suite, "workboard-lifecycle", viewport);
    const createdCard = card({
      id: "card-1",
      labels: ["ui", "proof"],
      notes: "Acceptance: browser proof",
      sessionKey: linkedSessionKey,
      title: "Draft Workboard browser proof",
      updatedAt: baseTime + 1,
    });
    const editedCard = card({
      ...createdCard,
      labels: ["ui", "proof", "e2e"],
      notes: "Acceptance: mocked Gateway browser proof\nProof: pending",
      priority: "high",
      title: "Workboard browser proof",
      updatedAt: baseTime + 2,
    });
    const runningCard = card({
      ...editedCard,
      status: "running",
      updatedAt: baseTime + 3,
    });
    const reviewedCard = card({
      ...runningCard,
      events: [moved("event-review", baseTime + 4, "running", "review")],
      status: "review",
      updatedAt: baseTime + 4,
    });
    const liveRefreshedCard = card({
      ...reviewedCard,
      notes: "Acceptance: live Gateway invalidation refreshed this card",
      title: "Workboard browser proof refreshed",
      updatedAt: baseTime + 5,
    });

    const writable = await proof.open("workboard-writable");
    const { page } = writable;
    await page.clock.install();
    try {
      const gateway = await installWorkboard(page, [], {
        methodResponses: {
          "sessions.list": sessionsListResponse([sessionRow()]),
        },
      });
      const response = await page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await page
        .locator(".workboard-heading__actions")
        .getByRole("button", { name: /New card/u })
        .waitFor();
      await gateway.waitForRequest("workboard.cards.list");
      await expect.poll(() => page.locator(".workboard-refresh").isEnabled()).toBe(true);
      expect(await page.locator(".workboard-card").count()).toBe(0);
      await proof.capture(page, "01-empty-board");

      await openWorkboardFilters(page);
      const highPriority = page
        .getByRole("group", { name: "Priority", exact: true })
        .getByRole("checkbox", { name: /High/u, disabled: false });
      await highPriority.press("Space");
      await expect.poll(() => highPriority.isChecked()).toBe(true);
      await highPriority.uncheck();
      await expect.poll(() => highPriority.isChecked()).toBe(false);
      await closeWorkboardFilters(page);

      await gateway.deferNext("workboard.cards.create");
      await page
        .locator(".workboard-heading__actions")
        .getByRole("button", { name: /New card/u })
        .click();
      const createDialog = page.getByRole("dialog", { name: "New card" });
      const createForm = page.locator(".workboard-draft");
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await setWorkboardDraftField(createForm, "Title", createdCard.title);
      await setWorkboardDraftField(createForm, "Notes", createdCard.notes ?? "");
      await createForm.getByRole("button", { name: /^Session:/u }).click();
      await createForm
        .getByRole("option", { name: new RegExp(`^${escapeRegExp(linkedSessionName)}`, "u") })
        .click();
      await setWorkboardDraftField(createForm, "Labels", "ui, proof");
      await proof.capture(page, "02-create-dialog", createDialog, [
        createForm.getByLabel("Title"),
        createForm.getByLabel("Notes"),
      ]);
      const createBefore = await requestCount(gateway, "workboard.cards.create");
      await createForm.getByRole("button", { name: /^Create$/u }).click();
      const createRequest = await gateway.waitForRequest("workboard.cards.create", {
        after: createBefore,
      });
      expect(requestParams(createRequest)).toMatchObject({
        labels: ["ui", "proof"],
        notes: createdCard.notes,
        sessionKey: linkedSessionKey,
        status: "todo",
        title: createdCard.title,
      });
      for (const control of [
        ...["Title", "Notes", "Labels"].map((label) => createForm.getByLabel(label)),
        createForm.getByRole("button", { name: /^Session:/u }),
        createForm
          .getByRole("group", { name: "Status", exact: true })
          .getByRole("radio", { name: "Todo", exact: true }),
        createForm
          .getByRole("group", { name: "Priority", exact: true })
          .getByRole("radio", { name: "Normal", exact: true }),
        createForm.locator(".workboard-agent-select .agent-select__trigger"),
      ]) {
        expect(await control.isDisabled()).toBe(true);
      }
      const pendingCancelButtons = createForm.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      expect(await pendingCancelButtons.count()).toBe(2);
      expect(await pendingCancelButtons.first().isDisabled()).toBe(true);
      expect(await pendingCancelButtons.last().isDisabled()).toBe(true);
      expect(await createForm.locator(".workboard-template-strip button:disabled").count()).toBe(5);
      await page.keyboard.press("Escape");
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await createDialog.click({ position: { x: 4, y: 4 } });
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await setCards(gateway, [createdCard]);
      await gateway.resolveDeferred("workboard.cards.create", { card: createdCard });
      await cardInColumn(page, "Todo", createdCard.title).waitFor();
      await proof.capture(page, "03-created-card");

      await gateway.deferNext("workboard.cards.update");
      await clickCardAction(cardInColumn(page, "Todo", createdCard.title), "Edit card");
      const editDialog = page.getByRole("dialog", { name: "Edit card" });
      const editForm = page.locator(".workboard-draft");
      await expect.poll(() => editDialog.isVisible()).toBe(true);
      await setWorkboardDraftField(editForm, "Title", editedCard.title);
      await setWorkboardDraftField(editForm, "Notes", editedCard.notes ?? "");
      const priority = editForm.getByRole("radio", { name: "High", exact: true, disabled: false });
      await priority.press("Space");
      expect(await priority.isChecked()).toBe(true);
      await setWorkboardDraftField(editForm, "Labels", "ui, proof, e2e");
      const updateBeforeEdit = await requestCount(gateway, "workboard.cards.update");
      await editForm.getByRole("button", { name: /^Save$/u }).click();
      const editRequest = await gateway.waitForRequest("workboard.cards.update", {
        after: updateBeforeEdit,
      });
      expect(requestParams(editRequest)).toEqual({
        id: createdCard.id,
        expectedUpdatedAt: createdCard.updatedAt,
        patch: {
          labels: ["ui", "proof", "e2e"],
          notes: editedCard.notes,
          priority: "high",
          title: editedCard.title,
        },
      });
      await setCards(gateway, [editedCard]);
      await gateway.resolveDeferred("workboard.cards.update", { card: editedCard });
      await cardInColumn(page, "Todo", editedCard.title).waitFor();
      await proof.capture(page, "04-edited-card");

      await cardInColumn(page, "Todo", editedCard.title).click();
      const details = page.locator(".workboard-detail");
      await details.getByText(editedCard.title).waitFor();
      await details.getByText("Acceptance: mocked Gateway browser proof").waitFor();
      await details.getByRole("button", { name: /^Status:/u }).waitFor();
      await details.locator("button[popovertarget=workboard-detail-actions]").click();
      for (const name of ["Open session", "Edit card", "Archive card", "Delete card"]) {
        expect(await details.getByRole("button", { name }).count()).toBe(1);
      }
      expect(await details.getByRole("button", { name: "Stop session" }).count()).toBe(0);
      await proof.capture(
        page,
        "05-detail-actions",
        page.getByRole("dialog", { name: editedCard.title, exact: true }),
        [details.getByRole("button", { name: "Open session" })],
      );
      await details.locator('button[aria-label="Close"]').click();

      await gateway.deferNext("workboard.cards.move");
      const dragSource = cardInColumn(page, "Todo", editedCard.title);
      await dragSource.dispatchEvent("dragstart");
      await expect
        .poll(() => dragSource.getAttribute("class"))
        .toContain("workboard-card--dragging");
      await expect
        .poll(() => dragSource.evaluate((element) => window.getComputedStyle(element).opacity))
        .toBe("0.45");
      expect(await page.locator(".workboard-column--drop-target").count()).toBe(0);
      await statusColumn(page, "Running").dispatchEvent("dragover");
      await expect.poll(() => page.locator(".workboard-column--drop-target").count()).toBe(1);
      expect(await statusColumn(page, "Running").getAttribute("class")).toContain(
        "workboard-column--drop-target",
      );
      await proof.capture(page, "06-drag-feedback");
      await dragSource.dispatchEvent("dragend");
      await expect
        .poll(() => dragSource.getAttribute("class"))
        .not.toContain("workboard-card--dragging");

      const moveBefore = await requestCount(gateway, "workboard.cards.move");
      await dragSource.dragTo(statusColumn(page, "Running"));
      const moveRequest = await gateway.waitForRequest("workboard.cards.move", {
        after: moveBefore,
      });
      expect(requestParams(moveRequest)).toMatchObject({
        id: editedCard.id,
        status: "running",
      });
      await setCards(gateway, [runningCard]);
      await gateway.resolveDeferred("workboard.cards.move", { card: runningCard });
      await cardInColumn(page, "Running", editedCard.title).waitFor();
      await proof.capture(page, "07-moved-running");

      const updateBeforeLifecycle = await requestCount(gateway, "workboard.cards.update");
      const sessionListBeforeSync = await requestCount(gateway, "sessions.list");
      const completedSession = sessionRow({
        hasActiveRun: false,
        status: "done",
        updatedAt: baseTime + 4,
      });
      await gateway.setMethodResponse("sessions.list", sessionsListResponse([completedSession]));
      await gateway.deferNext("sessions.list");
      await gateway.emitGatewayEvent("sessions.changed", {
        ...completedSession,
        reason: "lifecycle",
        sessionKey: linkedSessionKey,
        ts: baseTime + 4,
      });
      await gateway.waitForRequest("sessions.list", { after: sessionListBeforeSync });
      await gateway.resolveDeferred("sessions.list");
      await page.waitForTimeout(250);
      expect(await gateway.getRequests("workboard.cards.update")).toHaveLength(
        updateBeforeLifecycle,
      );

      const listBeforeLifecycle = await requestCount(gateway, "workboard.cards.list");
      // The catalog reads summaries while the page reads full cards after the event.
      await setCards(gateway, [reviewedCard]);
      await gateway.deferNext("workboard.cards.list");
      await gateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
        epoch: "workboard-e2e",
        revision: 1,
      });
      await gateway.waitForRequest("workboard.cards.list", { after: listBeforeLifecycle });
      await gateway.resolveDeferred("workboard.cards.list");
      const reviewedCardSurface = cardInColumn(page, "Review", editedCard.title);
      await reviewedCardSurface.waitFor();
      await clickCardAction(reviewedCardSurface, "View details");
      await page.getByRole("tab", { name: "Activity", exact: true }).click();
      await page.locator(".workboard-detail").getByText("Moved to Review").waitFor();
      await proof.capture(
        page,
        "08-lifecycle-review",
        page.getByRole("dialog", { name: editedCard.title, exact: true }),
        [details.getByText("Moved to Review")],
      );
      await details.locator('button[aria-label="Close"]').click();
      await details.waitFor({ state: "hidden" });

      await clickCardAction(cardInColumn(page, "Review", editedCard.title), "Edit card");
      await expect.poll(() => editDialog.isVisible()).toBe(true);
      const unsavedNotes = "Keep these unfinished Workboard notes";
      await setWorkboardDraftField(editForm, "Notes", unsavedNotes);
      const listBeforeLiveRefresh = await requestCount(gateway, "workboard.cards.list");
      const boardsBeforeLiveRefresh = await requestCount(gateway, "workboard.boards.list");
      const liveRefreshResponse = cardsListResponse([liveRefreshedCard]);
      liveRefreshResponse.boards.push(makeBoard("live", { name: "Live metadata" }));
      await gateway.setMethodResponse("workboard.cards.list", liveRefreshResponse);
      await gateway.setMethodResponse("workboard.boards.list", {
        boards: liveRefreshResponse.boards,
      });
      await gateway.deferNext("workboard.boards.list");
      await gateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
        epoch: "workboard-e2e",
        revision: 2,
      });
      await gateway.waitForRequest("workboard.boards.list", {
        after: boardsBeforeLiveRefresh,
      });
      await gateway.resolveDeferred("workboard.boards.list");
      expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(listBeforeLiveRefresh);
      expect(await editForm.getByLabel("Notes").inputValue()).toBe(unsavedNotes);
      expect(
        await reviewedCardSurface.getByRole("heading", { includeHidden: true }).textContent(),
      ).toBe(reviewedCard.title);
      expect(
        await page
          .getByRole("heading", { name: liveRefreshedCard.title, exact: true, includeHidden: true })
          .count(),
      ).toBe(0);
      await gateway.deferNext("workboard.cards.list");
      await editForm
        .locator(":scope > .workboard-modal__actions")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await page
        .locator(".workboard-discard")
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await gateway.waitForRequest("workboard.cards.list", {
        after: listBeforeLiveRefresh,
      });
      const liveBoardPicker = await openWorkboardBoardPicker(page);
      await expect
        .poll(() => liveBoardPicker.getByRole("option", { name: /Live metadata/u }).count())
        .toBe(1);
      await liveBoardPicker.locator(".picker-select__trigger").click();
      await liveBoardPicker.locator(".picker-select__menu").waitFor({ state: "hidden" });
      await closeWorkboardFilters(page);
      await gateway.resolveDeferred("workboard.cards.list");
      await cardInColumn(page, "Review", liveRefreshedCard.title).waitFor();
      const listAfterLiveRefresh = await requestCount(gateway, "workboard.cards.list");
      await page.clock.fastForward(1_250);
      expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(listAfterLiveRefresh);

      await gateway.deferNext("workboard.cards.list");
      const listBeforeReload = await requestCount(gateway, "workboard.cards.list");
      await page
        .locator(".workboard-heading__actions")
        .getByRole("button", { name: /^Refresh$/u })
        .click();
      await gateway.waitForRequest("workboard.cards.list", { after: listBeforeReload });
      await gateway.resolveDeferred("workboard.cards.list");
      await cardInColumn(page, "Review", liveRefreshedCard.title).waitFor();
      await proof.capture(page, "09-reloaded-review");
    } finally {
      await writable.close();
    }

    const readOnly = await proof.open("workboard-read-only");
    try {
      const gateway = await installWorkboard(readOnly.page, [runningCard], {
        operatorScopes: ["operator.read"],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow({ hasActiveRun: false, status: "done", updatedAt: baseTime + 4 }),
          ]),
        },
      });
      const response = await readOnly.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await cardInColumn(readOnly.page, "Running", editedCard.title).waitFor();
      await proof.capture(readOnly.page, "09-read-only-board");
      expect(await readOnly.page.getByRole("button", { name: /New card/u }).count()).toBe(0);
      for (const name of ["Edit card", "Delete card", "Run default agent"]) {
        expect(await readOnly.page.locator(`button[aria-label="${name}"]`).count()).toBe(0);
      }
      expect(
        await cardInColumn(readOnly.page, "Running", editedCard.title).getAttribute("draggable"),
      ).toBe("false");

      await cardInColumn(readOnly.page, "Running", editedCard.title).click();
      await readOnly.page.locator(".workboard-detail").getByText(editedCard.title).waitFor();
      const readOnlyDetail = readOnly.page.locator(".workboard-detail");
      for (const name of [/^Status:/u, "Edit card", "Archive card", "Delete card"]) {
        expect(await readOnlyDetail.getByRole("button", { name }).count()).toBe(0);
      }
      expect(await readOnly.page.locator(".workboard-detail__note").count()).toBe(0);
      expect(await readOnly.page.getByRole("button", { name: /Add note/u }).count()).toBe(0);
      for (const action of ["update", "move", "create"]) {
        expect(await gateway.getRequests(`workboard.cards.${action}`)).toHaveLength(0);
      }
    } finally {
      await readOnly.close();
    }

    await proof.writeManifest();
  });

  it("keeps card titles visible when a column overflows its height", async () => {
    const proof = createWorkboardProof(suite, "workboard-overflow", viewport);
    const crowdedColumnCardCount = 8;
    const overflowTitle = (index: number) =>
      `Overflowing backlog card ${index + 1} with a long title that wraps onto two lines`;
    const crowdedCards = Array.from({ length: crowdedColumnCardCount }, (_, index) =>
      card({
        id: `overflow-card-${index + 1}`,
        notes: "Acceptance: title stays visible while the column scrolls.",
        position: 1000 + index,
        status: "todo",
        title: overflowTitle(index),
        updatedAt: baseTime + index,
      }),
    );

    const { page, close } = await proof.open("workboard-overflow");
    try {
      await installWorkboard(page, crowdedCards, {
        methodResponses: {
          "sessions.list": sessionsListResponse([sessionRow()]),
        },
      });
      // Constrain the height so the Todo column must overflow its visible area.
      await page.setViewportSize({ height: 720, width: 1400 });
      const response = await page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      const column = statusColumn(page, "Todo");
      await column.waitFor();
      await cardInColumn(page, "Todo", overflowTitle(0)).waitFor();
      await proof.capture(page, "09-overflow-column");

      const titleHeights = await column
        .locator(".workboard-card h3")
        .evaluateAll((titles) => titles.map((title) => title.getBoundingClientRect().height));
      expect(titleHeights).toHaveLength(crowdedColumnCardCount);
      for (const height of titleHeights) {
        // Squeezed implicit grid rows previously collapsed the line-clamped title to 0px.
        expect(height).toBeGreaterThan(0);
      }

      const columnScrolls = await column
        .locator(".workboard-column__cards")
        .evaluate((cards) => cards.scrollHeight > cards.clientHeight + 1);
      expect(columnScrolls).toBe(true);
    } finally {
      await close();
    }
  });

  it("collapses empty stages into rails without squeezing active columns", async () => {
    const proof = createWorkboardProof(suite, "workboard-collapsed-columns", viewport);
    const reviewCard = card({
      id: "review-card",
      status: "review",
      title: "Review the completed implementation",
    });
    const doneCard = card({
      id: "done-card",
      status: "done",
      title: "Previously completed work",
    });
    const { page, close } = await proof.open("workboard-collapsed-columns");
    try {
      const gateway = await installWorkboard(page, [reviewCard, doneCard], {
        methodResponses: {
          "workboard.cards.move": { card: { ...reviewCard, status: "ready" } },
        },
      });
      await page.setViewportSize({ height: 760, width: 1200 });
      const response = await page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await page.locator(".workboard-column--review .workboard-card").waitFor();

      const reviewHeader = page.locator(".workboard-column--review .workboard-column__header");
      const collapseButton = reviewHeader.getByRole("button", { name: "Collapse Review column" });
      expect(await collapseButton.evaluate((button) => getComputedStyle(button).opacity)).toBe("0");
      for (const [action, expected] of [
        [() => collapseButton.focus(), "1"],
        [() => collapseButton.blur(), "0"],
        [() => reviewHeader.hover(), "1"],
      ] as const) {
        await action();
        await expect.poll(() => opacity(collapseButton)).toBe(expected);
      }

      const collapsedColumns = page.locator(".workboard-column--collapsed");
      await expect.poll(() => collapsedColumns.count()).toBe(0);
      const emptyColumns = page.getByRole("group", { name: "Empty columns", exact: true });
      for (const [option, count] of [
        ["Hide empty", 2],
        ["Show all", 9],
      ] as const) {
        await chooseWorkboardDisplayOption(page, option);
        await expect.poll(() => page.locator(".workboard-column").count()).toBe(count);
      }
      await chooseWorkboardDisplayOption(page, "Collapse empty");
      await expect.poll(() => collapsedColumns.count()).toBe(7);
      const readyColumn = page.locator(".workboard-column--ready");
      const collapsedWidth = await width(readyColumn);
      const reviewWidth = await width(page.locator(".workboard-column--review"));
      expect(collapsedWidth).toBeGreaterThanOrEqual(44);
      expect(collapsedWidth).toBeLessThanOrEqual(52);
      expect(reviewWidth).toBeGreaterThanOrEqual(262);

      const readyRail = page.locator(".workboard-column--ready .workboard-column__rail");
      const collapsedRailStyle = await readyRail.evaluate((rail) => ({
        boxShadow: getComputedStyle(rail).boxShadow,
      }));
      expect(collapsedRailStyle.boxShadow).toBe("none");

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reducedMotionTransitions = await page.evaluate(() => ({
        collapse: getComputedStyle(
          document.querySelector(".workboard-column__collapse") as HTMLElement,
        ).transitionDuration,
        rail: getComputedStyle(
          document.querySelector(".workboard-column__rail-icon") as HTMLElement,
        ).transitionDuration,
      }));
      expect(reducedMotionTransitions).toEqual({ collapse: "0s", rail: "0s" });
      await page.emulateMedia({ reducedMotion: "no-preference" });

      await proof.capture(page, "10-collapsed-columns-desktop");

      await page.getByRole("button", { name: "Expand Ready column" }).click();
      await expect
        .poll(() => page.locator(".workboard-column--ready").getAttribute("class"))
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
      await page
        .locator(".workboard-column--review .workboard-card")
        .dragTo(page.locator(".workboard-column--ready .workboard-column__rail"));
      const moveRequest = await gateway.waitForRequest("workboard.cards.move", {
        after: moveCount,
      });
      expect(requestParams(moveRequest)).toMatchObject({ id: reviewCard.id, status: "ready" });

      await page.setViewportSize({ height: 760, width: 700 });
      await openWorkboardFilters(page);
      await expect.poll(() => emptyColumns.getByRole("button").count()).toBe(3);
      await closeWorkboardFilters(page);
      const backlogColumn = page.locator(".workboard-column--backlog");
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
      await proof.capture(page, "11-collapsed-columns-mobile");
    } finally {
      await close();
    }
  });

  it("keeps touch collapse controls visible and at least 44px", async () => {
    await suite.withPage({ hasTouch: true }, async ({ page }) => {
      await installWorkboard(page, [
        card({ id: "touch-review-card", status: "review", title: "Review on touch" }),
      ]);
      await page.setViewportSize({ height: 844, width: 390 });
      const response = await page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);

      const collapseButton = page.getByRole("button", { name: "Collapse Review column" });
      await collapseButton.waitFor();
      await waitForControlUiProofSurface(collapseButton, []);
      const touchGeometry = await collapseButton.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        return {
          height: bounds.height,
          opacity: getComputedStyle(button).opacity,
          width: bounds.width,
        };
      });
      expect(touchGeometry.opacity).toBe("1");
      expect(touchGeometry.width).toBeGreaterThanOrEqual(44);
      expect(touchGeometry.height).toBeGreaterThanOrEqual(44);
    });
  });

  it("filters persisted boards and keeps the selection in the URL", async () => {
    const proof = createWorkboardProof(suite, "workboard-board-filter", viewport);
    const defaultCard = card({ id: "default-card", title: "Default board work" });
    const opsCard = card({
      id: "ops-card",
      title: "Operations board work",
      metadata: { automation: { boardId: "ops" } },
    });
    const boards: WorkboardBoardSummary[] = [
      makeBoard("default", { total: 1, active: 1, byStatus: { todo: 1 } }),
      makeBoard("ops", { name: "Operations", total: 1, active: 1, byStatus: { todo: 1 } }),
      makeBoard("archive", { name: "Old work", archivedAt: baseTime }),
    ];
    const { page, close } = await proof.open("workboard-board-filter");
    try {
      await installWorkboard(page, [defaultCard, opsCard], {
        methodResponses: {
          "workboard.boards.list": { boards },
          "workboard.cards.list": cardsListResponse([defaultCard, opsCard], boards),
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}workboard?board=ops&agent=main`);
      expect(response?.status()).toBe(200);
      await cardInColumn(page, "Todo", opsCard.title).waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard/ops");
      await expect.poll(() => page.getByText(defaultCard.title).count()).toBe(0);
      expect(new URL(page.url()).searchParams.has("board")).toBe(false);

      const historyBeforeFilter = await page.evaluate(() => history.length);
      for (const [boardId, pathname] of [
        ["__all__", "/workboard"],
        ["ops", "/workboard/ops"],
      ] as const) {
        await chooseWorkboardBoard(page, boardId);
        if (boardId === "__all__") {
          await cardInColumn(page, "Todo", defaultCard.title).waitFor();
        }
        await expect.poll(() => new URL(page.url()).pathname).toBe(pathname);
        expect(new URL(page.url()).search).toBe("?agent=main");
      }
      expect(await page.evaluate(() => history.length)).toBe(historyBeforeFilter);
      expect(await page.getByText(defaultCard.title).count()).toBe(0);
      const boardPicker = await openWorkboardBoardPicker(page);
      expect(await boardPicker.getByRole("option", { name: /Old work/u }).count()).toBeGreaterThan(
        0,
      );
      await proof.capture(page, "10-board-filter-ops");
    } finally {
      await close();
    }
  });
});
