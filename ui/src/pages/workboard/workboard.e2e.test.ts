// Control UI tests cover workboard behavior.
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardStatus,
} from "@openclaw/workboard-contract";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { BrowserContext, Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { WORKBOARD_CHANGED_EVENT } from "../../../../packages/workboard-contract/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { createControlUiE2eArtifactDir } from "../../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard mocked Gateway E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}. Run \`pnpm --dir ui exec playwright install chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const viewport = { height: 1000, width: 2400 };
const baseTime = Date.parse("2026-06-01T18:00:00.000Z");
const linkedSessionKey = "agent:main:workboard-proof";
const linkedSessionName = "Implementation session";
const WORKBOARD_STATUSES: readonly WorkboardStatus[] = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
];

type RecordedPage = {
  context: BrowserContext;
  page: Page;
  rawVideoDir: string;
};

type ProofArtifacts = {
  directory: string;
  screenshots: string[];
  videos: string[];
};

function createProofArtifacts(scope: string): ProofArtifacts {
  return {
    directory: captureUiProofEnabled ? createControlUiE2eArtifactDir(scope) : "",
    screenshots: [],
    videos: [],
  };
}

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
  await panel.waitFor({ state: "visible" });
}

async function chooseWorkboardDisplayOption(page: Page, option: string) {
  await openWorkboardFilters(page);
  await page
    .getByRole("group", { name: "Empty columns", exact: true })
    .getByRole("button", { name: option, exact: true })
    .click();
}

async function chooseWorkboardBoard(page: Page, boardId: string) {
  await openWorkboardFilters(page);
  const picker = page.locator("openclaw-select-picker").filter({
    has: page.getByRole("button", { name: /^Filter by board:/u }),
  });
  await picker.getByRole("button", { name: /^Filter by board:/u }).click();
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

async function waitForRequests(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<MockGatewayRequest[]> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const requests = await gateway.getRequests(method);
    if (requests.length >= count) {
      return requests;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${count} ${method} requests`);
}

async function waitForNextRequest(
  gateway: MockGatewayControls,
  method: string,
  previousCount: number,
): Promise<MockGatewayRequest> {
  const requests = await waitForRequests(gateway, method, previousCount + 1);
  const request = requests.at(-1);
  if (!request) {
    throw new Error(`No ${method} request found`);
  }
  return request;
}

function workboardConfigSnapshot() {
  const config = {
    plugins: {
      entries: {
        workboard: { enabled: true },
      },
    },
  };
  return {
    config,
    hash: "workboard-e2e-config",
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config, null, 2),
    resolved: config,
    sourceConfig: config,
  };
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
    contextTokens: 0,
    displayName: linkedSessionName,
    hasActiveRun: false,
    key: linkedSessionKey,
    kind: "direct",
    label: linkedSessionName,
    model: "gpt-5.5",
    modelProvider: "openai",
    totalTokens: 0,
    updatedAt: baseTime,
    ...overrides,
  };
}

function card(
  overrides: Partial<WorkboardCard> & Pick<WorkboardCard, "id" | "title">,
): WorkboardCard {
  return {
    createdAt: baseTime,
    labels: [],
    notes: "",
    position: 1000,
    priority: "normal",
    status: "todo",
    updatedAt: baseTime,
    ...overrides,
  };
}

function cardsListResponse(
  cards: WorkboardCard[],
  boards: WorkboardBoardSummary[] = [
    { id: "default", total: cards.length, active: cards.length, archived: 0, byStatus: {} },
  ],
) {
  return {
    boards,
    cards,
    statuses: WORKBOARD_STATUSES,
  };
}

function statusColumn(page: Page, status: string) {
  const statusClass = status.trim().toLowerCase().replaceAll(/\s+/gu, "-");
  return page.locator(`.workboard-column--${statusClass}`).first();
}

function cardInColumn(page: Page, status: string, title: string) {
  return statusColumn(page, status).locator(".workboard-card", { hasText: title }).first();
}

async function clickCardAction(cardLocator: Locator, name: string) {
  await cardLocator.hover();
  await cardLocator.locator(".workboard-card__menu-trigger").click();
  await cardLocator.getByRole("button", { name, exact: true }).click();
}

async function newRecordedPage(
  artifacts: ProofArtifacts,
  label: string,
  options: { hasTouch?: boolean } = {},
): Promise<RecordedPage> {
  const rawVideoDir = path.join(artifacts.directory, `${label}-raw`);
  if (captureUiProofEnabled) {
    await mkdir(rawVideoDir, { recursive: true });
  }
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await suite.browser.newContext({
      hasTouch: options.hasTouch,
      locale: "en-US",
      recordVideo: captureUiProofEnabled ? { dir: rawVideoDir, size: viewport } : undefined,
      serviceWorkers: "block",
      viewport,
    });
    page = await context.newPage();
    page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
    return { context, page, rawVideoDir };
  } catch (error) {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    throw error;
  }
}

async function captureScreenshot(
  page: Page,
  artifacts: ProofArtifacts,
  name: string,
  surface = page.locator(".shell"),
  content: readonly Locator[] = [page.locator(".workboard-page-title")],
): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const screenshotPath = path.join(artifacts.directory, `${name}.png`);
  await writeFile(screenshotPath, await takeControlUiViewportScreenshot(page, surface, content));
  artifacts.screenshots.push(screenshotPath);
}

async function closeRecordedPage(
  recorded: RecordedPage,
  artifacts: ProofArtifacts,
  label: string,
): Promise<void> {
  const video = recorded.page.video();
  await recorded.context.close();
  if (!video) {
    return;
  }
  const rawVideoPath = await video.path();
  const videoPath = path.join(artifacts.directory, `${label}.webm`);
  await copyFile(rawVideoPath, videoPath);
  artifacts.videos.push(videoPath);
  // Preserve the raw recording if close or copy fails; only remove the retained copy's source.
  await rm(recorded.rawVideoDir, { force: true, recursive: true });
}

suite.define(() => {
  it("persists Workboard create, edit, running move, lifecycle sync, reload, and read-only state", async () => {
    const artifacts = createProofArtifacts("workboard-lifecycle");
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
      events: [
        {
          at: baseTime + 4,
          fromStatus: "running",
          id: "event-review",
          kind: "moved",
          toStatus: "review",
        },
      ],
      status: "review",
      updatedAt: baseTime + 4,
    });
    const liveRefreshedCard = card({
      ...reviewedCard,
      notes: "Acceptance: live Gateway invalidation refreshed this card",
      title: "Workboard browser proof refreshed",
      updatedAt: baseTime + 5,
    });

    const writable = await newRecordedPage(artifacts, "workboard-writable");
    await writable.page.clock.install();
    try {
      const writableGateway = await installMockGateway(writable.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([sessionRow()]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([]),
        },
      });
      const response = await writable.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await writable.page
        .locator(".workboard-heading__actions")
        .getByRole("button", { name: /New card/u })
        .waitFor({ state: "visible" });
      await writableGateway.waitForRequest("workboard.cards.list");
      await expect.poll(() => writable.page.locator(".workboard-refresh").isEnabled()).toBe(true);
      expect(await writable.page.locator(".workboard-card").count()).toBe(0);
      await captureScreenshot(writable.page, artifacts, "01-empty-board");

      await openWorkboardFilters(writable.page);
      const highPriority = writable.page
        .getByRole("group", { name: "Priority", exact: true })
        .getByRole("checkbox", { name: /High/u });
      await highPriority.focus();
      await writable.page.keyboard.press("Space");
      await expect.poll(() => highPriority.isChecked()).toBe(true);
      await highPriority.uncheck();
      await expect.poll(() => highPriority.isChecked()).toBe(false);
      await closeWorkboardFilters(writable.page);

      await writableGateway.deferNext("workboard.cards.create");
      await writable.page
        .locator(".workboard-heading__actions")
        .getByRole("button", { name: /New card/u })
        .click();
      const createDialog = writable.page.getByRole("dialog", { name: "New card" });
      const createForm = writable.page.locator(".workboard-draft");
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await setWorkboardDraftField(createForm, "Title", createdCard.title);
      await setWorkboardDraftField(createForm, "Notes", createdCard.notes ?? "");
      await createForm.getByRole("button", { name: /^Session:/u }).click();
      await createForm
        .getByRole("option", { name: new RegExp(`^${escapeRegExp(linkedSessionName)}`, "u") })
        .click();
      await setWorkboardDraftField(createForm, "Labels", "ui, proof");
      await captureScreenshot(writable.page, artifacts, "02-create-dialog", createDialog, [
        createForm.getByLabel("Title"),
        createForm.getByLabel("Notes"),
      ]);
      const createBefore = (await writableGateway.getRequests("workboard.cards.create")).length;
      await createForm.getByRole("button", { name: /^Create$/u }).click();
      const createRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.create",
        createBefore,
      );
      expect(requestParams(createRequest)).toMatchObject({
        labels: ["ui", "proof"],
        notes: createdCard.notes,
        sessionKey: linkedSessionKey,
        status: "todo",
        title: createdCard.title,
      });
      expect(await createForm.getByLabel("Title").isDisabled()).toBe(true);
      expect(await createForm.getByLabel("Notes").isDisabled()).toBe(true);
      expect(await createForm.getByLabel("Labels").isDisabled()).toBe(true);
      expect(await createForm.getByRole("button", { name: /^Session:/u }).isDisabled()).toBe(true);
      expect(
        await createForm
          .getByRole("group", { name: "Status", exact: true })
          .getByRole("radio", { name: "Todo", exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await createForm
          .getByRole("group", { name: "Priority", exact: true })
          .getByRole("radio", { name: "Normal", exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await createForm.locator(".workboard-agent-select .agent-select__trigger").isDisabled(),
      ).toBe(true);
      const pendingCancelButtons = createForm.getByRole("button", {
        name: "Cancel",
        exact: true,
      });
      expect(await pendingCancelButtons.count()).toBe(2);
      expect(await pendingCancelButtons.first().isDisabled()).toBe(true);
      expect(await pendingCancelButtons.last().isDisabled()).toBe(true);
      expect(await createForm.locator(".workboard-template-strip button:disabled").count()).toBe(5);
      await writable.page.keyboard.press("Escape");
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await createDialog.click({ position: { x: 4, y: 4 } });
      await expect.poll(() => createDialog.isVisible()).toBe(true);
      await writableGateway.setMethodResponse(
        "workboard.cards.list",
        cardsListResponse([createdCard]),
      );
      await writableGateway.resolveDeferred("workboard.cards.create", { card: createdCard });
      await cardInColumn(writable.page, "Todo", createdCard.title).waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "03-created-card");

      await writableGateway.deferNext("workboard.cards.update");
      await clickCardAction(cardInColumn(writable.page, "Todo", createdCard.title), "Edit card");
      const editDialog = writable.page.getByRole("dialog", { name: "Edit card" });
      const editForm = writable.page.locator(".workboard-draft");
      await expect.poll(() => editDialog.isVisible()).toBe(true);
      await setWorkboardDraftField(editForm, "Title", editedCard.title);
      await setWorkboardDraftField(editForm, "Notes", editedCard.notes ?? "");
      await editForm.getByRole("radio", { name: "High", exact: true }).focus();
      await writable.page.keyboard.press("Space");
      await setWorkboardDraftField(editForm, "Labels", "ui, proof, e2e");
      const updateBeforeEdit = (await writableGateway.getRequests("workboard.cards.update")).length;
      await editForm.getByRole("button", { name: /^Save$/u }).click();
      const editRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.update",
        updateBeforeEdit,
      );
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
      await writableGateway.setMethodResponse(
        "workboard.cards.list",
        cardsListResponse([editedCard]),
      );
      await writableGateway.resolveDeferred("workboard.cards.update", { card: editedCard });
      await cardInColumn(writable.page, "Todo", editedCard.title).waitFor({ state: "visible" });
      await captureScreenshot(writable.page, artifacts, "04-edited-card");

      await cardInColumn(writable.page, "Todo", editedCard.title).click();
      const details = writable.page.locator(".workboard-detail");
      await details.getByText(editedCard.title).waitFor({ state: "visible" });
      await details.getByText("Acceptance: mocked Gateway browser proof").waitFor({
        state: "visible",
      });
      await details.getByRole("button", { name: /^Status:/u }).waitFor({ state: "visible" });
      await details.locator("button[popovertarget=workboard-detail-actions]").click();
      expect(await details.getByRole("button", { name: "Open session" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Edit card" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Archive card" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Delete card" }).count()).toBe(1);
      expect(await details.getByRole("button", { name: "Stop session" }).count()).toBe(0);
      await captureScreenshot(
        writable.page,
        artifacts,
        "05-detail-actions",
        writable.page.getByRole("dialog", { name: editedCard.title, exact: true }),
        [details.getByRole("button", { name: "Open session" })],
      );
      await details.locator('button[aria-label="Close"]').click();

      await writableGateway.deferNext("workboard.cards.move");
      const dragSource = cardInColumn(writable.page, "Todo", editedCard.title);
      await dragSource.dispatchEvent("dragstart");
      await expect
        .poll(() => dragSource.getAttribute("class"))
        .toContain("workboard-card--dragging");
      await expect
        .poll(() => dragSource.evaluate((element) => window.getComputedStyle(element).opacity))
        .toBe("0.45");
      expect(await writable.page.locator(".workboard-column--drop-target").count()).toBe(0);
      await statusColumn(writable.page, "Running").dispatchEvent("dragover");
      await expect
        .poll(() => writable.page.locator(".workboard-column--drop-target").count())
        .toBe(1);
      expect(await statusColumn(writable.page, "Running").getAttribute("class")).toContain(
        "workboard-column--drop-target",
      );
      await captureScreenshot(writable.page, artifacts, "06-drag-feedback");
      await dragSource.dispatchEvent("dragend");
      await expect
        .poll(() => dragSource.getAttribute("class"))
        .not.toContain("workboard-card--dragging");

      const moveBefore = (await writableGateway.getRequests("workboard.cards.move")).length;
      await dragSource.dragTo(statusColumn(writable.page, "Running"));
      const moveRequest = await waitForNextRequest(
        writableGateway,
        "workboard.cards.move",
        moveBefore,
      );
      expect(requestParams(moveRequest)).toMatchObject({
        id: editedCard.id,
        status: "running",
      });
      await writableGateway.setMethodResponse(
        "workboard.cards.list",
        cardsListResponse([runningCard]),
      );
      await writableGateway.resolveDeferred("workboard.cards.move", { card: runningCard });
      await cardInColumn(writable.page, "Running", editedCard.title).waitFor({
        state: "visible",
      });
      await captureScreenshot(writable.page, artifacts, "07-moved-running");

      const updateBeforeLifecycle = (await writableGateway.getRequests("workboard.cards.update"))
        .length;
      const sessionListBeforeSync = (await writableGateway.getRequests("sessions.list")).length;
      await writableGateway.setMethodResponse(
        "sessions.list",
        sessionsListResponse([
          sessionRow({ hasActiveRun: false, status: "done", updatedAt: baseTime + 4 }),
        ]),
      );
      await writableGateway.deferNext("sessions.list");
      await writableGateway.emitGatewayEvent("sessions.changed", {
        ...sessionRow({
          hasActiveRun: false,
          status: "done",
          updatedAt: baseTime + 4,
        }),
        reason: "lifecycle",
        sessionKey: linkedSessionKey,
        ts: baseTime + 4,
      });
      await waitForNextRequest(writableGateway, "sessions.list", sessionListBeforeSync);
      await writableGateway.resolveDeferred("sessions.list");
      await writable.page.waitForTimeout(250);
      expect(await writableGateway.getRequests("workboard.cards.update")).toHaveLength(
        updateBeforeLifecycle,
      );

      const listBeforeLifecycle = (await writableGateway.getRequests("workboard.cards.list"))
        .length;
      // Catalog and page refreshes read the same committed server state after the event.
      await writableGateway.setMethodResponse(
        "workboard.cards.list",
        cardsListResponse([reviewedCard]),
      );
      await writableGateway.deferNext("workboard.cards.list");
      await writableGateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
        epoch: "workboard-e2e",
        revision: 1,
      });
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeLifecycle);
      await writableGateway.resolveDeferred("workboard.cards.list");
      const reviewedCardSurface = cardInColumn(writable.page, "Review", editedCard.title);
      await reviewedCardSurface.waitFor({ state: "visible" });
      await clickCardAction(reviewedCardSurface, "View details");
      await writable.page.getByRole("tab", { name: "Activity", exact: true }).click();
      await writable.page.locator(".workboard-detail").getByText("Moved to Review").waitFor({
        state: "visible",
      });
      await captureScreenshot(
        writable.page,
        artifacts,
        "08-lifecycle-review",
        writable.page.getByRole("dialog", { name: editedCard.title, exact: true }),
        [details.getByText("Moved to Review")],
      );
      await details.locator('button[aria-label="Close"]').click();
      await details.waitFor({ state: "hidden" });

      await clickCardAction(cardInColumn(writable.page, "Review", editedCard.title), "Edit card");
      await expect.poll(() => editDialog.isVisible()).toBe(true);
      const unsavedNotes = "Keep these unfinished Workboard notes";
      await setWorkboardDraftField(editForm, "Notes", unsavedNotes);
      const listBeforeLiveRefresh = (await writableGateway.getRequests("workboard.cards.list"))
        .length;
      const tasksBeforeLiveRefresh = (await writableGateway.getRequests("tasks.list")).length;
      const liveRefreshResponse = cardsListResponse([liveRefreshedCard]);
      liveRefreshResponse.boards.push({
        id: "live",
        name: "Live metadata",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
      });
      await writableGateway.setMethodResponse("workboard.cards.list", liveRefreshResponse);
      await writableGateway.deferNext("workboard.cards.list");
      await writableGateway.emitGatewayEvent(WORKBOARD_CHANGED_EVENT, {
        epoch: "workboard-e2e",
        revision: 2,
      });
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeLiveRefresh);
      await writableGateway.resolveDeferred("workboard.cards.list");
      await expect
        .poll(() =>
          writable.page
            .getByRole("option", { name: /Live metadata/u, includeHidden: true })
            .count(),
        )
        .toBe(1);
      expect(await editForm.getByLabel("Notes").inputValue()).toBe(unsavedNotes);
      expect(
        await reviewedCardSurface.getByRole("heading", { includeHidden: true }).textContent(),
      ).toBe(reviewedCard.title);
      expect(
        await writable.page
          .getByRole("heading", { name: liveRefreshedCard.title, exact: true, includeHidden: true })
          .count(),
      ).toBe(0);
      expect(await writableGateway.getRequests("tasks.list")).toHaveLength(tasksBeforeLiveRefresh);
      const listBeforeDraftClose = (await writableGateway.getRequests("workboard.cards.list"))
        .length;
      await editForm
        .locator(":scope > .workboard-modal__actions")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();
      await writable.page
        .locator(".workboard-discard")
        .getByRole("button", { name: "Discard", exact: true })
        .click();
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeDraftClose);
      await cardInColumn(writable.page, "Review", liveRefreshedCard.title).waitFor({
        state: "visible",
      });
      const listAfterLiveRefresh = (await writableGateway.getRequests("workboard.cards.list"))
        .length;
      await writable.page.clock.fastForward(1_250);
      expect(await writableGateway.getRequests("workboard.cards.list")).toHaveLength(
        listAfterLiveRefresh,
      );

      await writableGateway.deferNext("workboard.cards.list");
      const listBeforeReload = (await writableGateway.getRequests("workboard.cards.list")).length;
      await writable.page
        .locator(".workboard-heading__actions")
        .getByRole("button", { name: /^Refresh$/u })
        .click();
      await waitForNextRequest(writableGateway, "workboard.cards.list", listBeforeReload);
      await writableGateway.resolveDeferred("workboard.cards.list");
      await cardInColumn(writable.page, "Review", liveRefreshedCard.title).waitFor({
        state: "visible",
      });
      await captureScreenshot(writable.page, artifacts, "09-reloaded-review");
    } finally {
      await closeRecordedPage(writable, artifacts, "workboard-writable");
    }

    const readOnly = await newRecordedPage(artifacts, "workboard-read-only");
    try {
      const readOnlyGateway = await installMockGateway(readOnly.page, {
        ...workboardUi,
        operatorScopes: ["operator.read"],
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([
            sessionRow({ hasActiveRun: false, status: "done", updatedAt: baseTime + 4 }),
          ]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([runningCard]),
        },
      });
      const response = await readOnly.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await cardInColumn(readOnly.page, "Running", editedCard.title).waitFor({
        state: "visible",
      });
      await captureScreenshot(readOnly.page, artifacts, "09-read-only-board");
      expect(await readOnly.page.getByRole("button", { name: /New card/u }).count()).toBe(0);
      expect(await readOnly.page.locator('button[aria-label="Edit card"]').count()).toBe(0);
      expect(await readOnly.page.locator('button[aria-label="Delete card"]').count()).toBe(0);
      expect(await readOnly.page.locator('button[aria-label="Run default agent"]').count()).toBe(0);
      expect(
        await cardInColumn(readOnly.page, "Running", editedCard.title).getAttribute("draggable"),
      ).toBe("false");

      await cardInColumn(readOnly.page, "Running", editedCard.title).click();
      await readOnly.page.locator(".workboard-detail").getByText(editedCard.title).waitFor({
        state: "visible",
      });
      const readOnlyDetail = readOnly.page.locator(".workboard-detail");
      expect(await readOnlyDetail.getByRole("button", { name: /^Status:/u }).count()).toBe(0);
      expect(await readOnlyDetail.getByRole("button", { name: "Edit card" }).count()).toBe(0);
      expect(await readOnlyDetail.getByRole("button", { name: "Archive card" }).count()).toBe(0);
      expect(await readOnlyDetail.getByRole("button", { name: "Delete card" }).count()).toBe(0);
      expect(await readOnly.page.locator(".workboard-detail__note").count()).toBe(0);
      expect(await readOnly.page.getByRole("button", { name: /Add note/u }).count()).toBe(0);
      expect(await readOnlyGateway.getRequests("workboard.cards.update")).toHaveLength(0);
      expect(await readOnlyGateway.getRequests("workboard.cards.move")).toHaveLength(0);
      expect(await readOnlyGateway.getRequests("workboard.cards.create")).toHaveLength(0);
    } finally {
      await closeRecordedPage(readOnly, artifacts, "workboard-read-only");
    }

    if (captureUiProofEnabled) {
      await writeFile(
        path.join(artifacts.directory, "manifest.json"),
        `${JSON.stringify(artifacts, null, 2)}\n`,
        "utf-8",
      );
    }
  });

  it("keeps card titles visible when a column overflows its height", async () => {
    const artifacts = createProofArtifacts("workboard-overflow");
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

    const recorded = await newRecordedPage(artifacts, "workboard-overflow");
    try {
      await installMockGateway(recorded.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([sessionRow()]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse(crowdedCards),
        },
      });
      // Constrain the height so the Todo column must overflow its visible area.
      await recorded.page.setViewportSize({ height: 720, width: 1400 });
      const response = await recorded.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      const column = statusColumn(recorded.page, "Todo");
      await column.waitFor({ state: "visible" });
      await cardInColumn(recorded.page, "Todo", overflowTitle(0)).waitFor({ state: "visible" });
      await captureScreenshot(recorded.page, artifacts, "09-overflow-column");

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
      await closeRecordedPage(recorded, artifacts, "workboard-overflow");
    }
  });

  it("collapses empty stages into rails without squeezing active columns", async () => {
    const artifacts = createProofArtifacts("workboard-collapsed-columns");
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
    const recorded = await newRecordedPage(artifacts, "workboard-collapsed-columns");
    try {
      const gateway = await installMockGateway(recorded.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([reviewCard, doneCard]),
          "workboard.cards.move": { card: { ...reviewCard, status: "ready" } },
        },
      });
      await recorded.page.setViewportSize({ height: 760, width: 1200 });
      const response = await recorded.page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);
      await recorded.page.locator(".workboard-column--review .workboard-card").waitFor();

      const reviewHeader = recorded.page.locator(
        ".workboard-column--review .workboard-column__header",
      );
      const collapseButton = reviewHeader.getByRole("button", { name: "Collapse Review column" });
      expect(await collapseButton.evaluate((button) => getComputedStyle(button).opacity)).toBe("0");
      await collapseButton.focus();
      await expect
        .poll(() => collapseButton.evaluate((button) => getComputedStyle(button).opacity))
        .toBe("1");
      await collapseButton.blur();
      await expect
        .poll(() => collapseButton.evaluate((button) => getComputedStyle(button).opacity))
        .toBe("0");
      await reviewHeader.hover();
      await expect
        .poll(() => collapseButton.evaluate((button) => getComputedStyle(button).opacity))
        .toBe("1");

      const collapsedColumns = recorded.page.locator(".workboard-column--collapsed");
      await expect.poll(() => collapsedColumns.count()).toBe(0);
      await openWorkboardFilters(recorded.page);
      const emptyColumns = recorded.page.getByRole("group", { name: "Empty columns", exact: true });
      await emptyColumns.getByRole("button", { name: "Hide empty", exact: true }).click();
      await expect.poll(() => recorded.page.locator(".workboard-column").count()).toBe(2);
      await chooseWorkboardDisplayOption(recorded.page, "Show all");
      await expect.poll(() => recorded.page.locator(".workboard-column").count()).toBe(9);
      await chooseWorkboardDisplayOption(recorded.page, "Collapse empty");
      await expect.poll(() => collapsedColumns.count()).toBe(7);
      const collapsedWidth = await recorded.page
        .locator(".workboard-column--ready")
        .evaluate((column) => column.getBoundingClientRect().width);
      const reviewWidth = await recorded.page
        .locator(".workboard-column--review")
        .evaluate((column) => column.getBoundingClientRect().width);
      expect(collapsedWidth).toBeGreaterThanOrEqual(44);
      expect(collapsedWidth).toBeLessThanOrEqual(52);
      expect(reviewWidth).toBeGreaterThanOrEqual(262);

      const readyRail = recorded.page.locator(".workboard-column--ready .workboard-column__rail");
      const collapsedRailStyle = await readyRail.evaluate((rail) => ({
        boxShadow: getComputedStyle(rail).boxShadow,
      }));
      expect(collapsedRailStyle.boxShadow).toBe("none");

      await recorded.page.emulateMedia({ reducedMotion: "reduce" });
      const reducedMotionTransitions = await recorded.page.evaluate(() => ({
        collapse: getComputedStyle(
          document.querySelector(".workboard-column__collapse") as HTMLElement,
        ).transitionDuration,
        rail: getComputedStyle(
          document.querySelector(".workboard-column__rail-icon") as HTMLElement,
        ).transitionDuration,
      }));
      expect(reducedMotionTransitions).toEqual({ collapse: "0s", rail: "0s" });
      await recorded.page.emulateMedia({ reducedMotion: "no-preference" });

      await captureScreenshot(recorded.page, artifacts, "10-collapsed-columns-desktop");

      await recorded.page.getByRole("button", { name: "Expand Ready column" }).click();
      await expect
        .poll(() => recorded.page.locator(".workboard-column--ready").getAttribute("class"))
        .not.toContain("workboard-column--collapsed");
      const expandedWidth = await recorded.page
        .locator(".workboard-column--ready")
        .evaluate((column) => column.getBoundingClientRect().width);
      expect(expandedWidth).toBeGreaterThanOrEqual(262);
      await recorded.page.getByRole("button", { name: "Collapse Ready column" }).click();

      await closeWorkboardFilters(recorded.page);
      await recorded.page
        .locator(".workboard-status-tabs")
        .getByRole("button", { name: "Review", exact: true })
        .click();
      const singleColumnBoard = recorded.page.locator(
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
      await recorded.page
        .locator(".workboard-status-tabs")
        .getByRole("button", { name: "All", exact: true })
        .click();
      await closeWorkboardFilters(recorded.page);

      const moveCount = (await gateway.getRequests("workboard.cards.move")).length;
      await recorded.page
        .locator(".workboard-column--review .workboard-card")
        .dragTo(recorded.page.locator(".workboard-column--ready .workboard-column__rail"));
      const moveRequest = await waitForNextRequest(gateway, "workboard.cards.move", moveCount);
      expect(requestParams(moveRequest)).toMatchObject({ id: reviewCard.id, status: "ready" });

      await recorded.page.setViewportSize({ height: 760, width: 700 });
      await openWorkboardFilters(recorded.page);
      await expect.poll(() => emptyColumns.getByRole("button").count()).toBe(3);
      await closeWorkboardFilters(recorded.page);
      const backlogColumn = recorded.page.locator(".workboard-column--backlog");
      const backlogRail = backlogColumn.getByRole("button", { name: "Expand Backlog column" });
      await backlogRail.scrollIntoViewIfNeeded();
      await backlogRail.focus();
      await recorded.page.keyboard.press("Enter");
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
      await captureScreenshot(recorded.page, artifacts, "11-collapsed-columns-mobile");
    } finally {
      await closeRecordedPage(recorded, artifacts, "workboard-collapsed-columns");
    }
  });

  it("keeps touch collapse controls visible and at least 44px", async () => {
    await suite.withPage({ hasTouch: true }, async ({ page }) => {
      await installMockGateway(page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.cards.list": cardsListResponse([
            card({ id: "touch-review-card", status: "review", title: "Review on touch" }),
          ]),
        },
      });
      await page.setViewportSize({ height: 844, width: 390 });
      const response = await page.goto(`${suite.server.baseUrl}workboard`);
      expect(response?.status()).toBe(200);

      const collapseButton = page.getByRole("button", { name: "Collapse Review column" });
      await collapseButton.waitFor({ state: "visible" });
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
    const artifacts = createProofArtifacts("workboard-board-filter");
    const defaultCard = card({ id: "default-card", title: "Default board work" });
    const opsCard = card({
      id: "ops-card",
      title: "Operations board work",
      metadata: { automation: { boardId: "ops" } },
    });
    const boards: WorkboardBoardSummary[] = [
      { id: "default", total: 1, active: 1, archived: 0, byStatus: { todo: 1 } },
      {
        id: "ops",
        name: "Operations",
        total: 1,
        active: 1,
        archived: 0,
        byStatus: { todo: 1 },
      },
      {
        id: "archive",
        name: "Old work",
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
        archivedAt: baseTime,
      },
    ];
    const recorded = await newRecordedPage(artifacts, "workboard-board-filter");
    try {
      await installMockGateway(recorded.page, {
        ...workboardUi,
        methodResponses: {
          "config.get": workboardConfigSnapshot(),
          "sessions.list": sessionsListResponse([]),
          "tasks.list": { nextCursor: null, tasks: [] },
          "workboard.boards.list": { boards },
          "workboard.cards.list": cardsListResponse([defaultCard, opsCard], boards),
        },
      });

      const response = await recorded.page.goto(
        `${suite.server.baseUrl}workboard?board=ops&agent=main`,
      );
      expect(response?.status()).toBe(200);
      await cardInColumn(recorded.page, "Todo", opsCard.title).waitFor({ state: "visible" });
      await expect.poll(() => new URL(recorded.page.url()).pathname).toBe("/workboard/ops");
      await expect.poll(() => recorded.page.getByText(defaultCard.title).count()).toBe(0);
      expect(new URL(recorded.page.url()).searchParams.has("board")).toBe(false);

      const historyBeforeFilter = await recorded.page.evaluate(() => history.length);
      await chooseWorkboardBoard(recorded.page, "__all__");
      await cardInColumn(recorded.page, "Todo", defaultCard.title).waitFor({ state: "visible" });
      await expect.poll(() => new URL(recorded.page.url()).pathname).toBe("/workboard");
      expect(new URL(recorded.page.url()).searchParams.has("board")).toBe(false);
      expect(new URL(recorded.page.url()).search).toBe("?agent=main");

      await chooseWorkboardBoard(recorded.page, "ops");
      await expect.poll(() => new URL(recorded.page.url()).pathname).toBe("/workboard/ops");
      expect(new URL(recorded.page.url()).search).toBe("?agent=main");
      expect(await recorded.page.evaluate(() => history.length)).toBe(historyBeforeFilter);
      expect(await recorded.page.getByText(defaultCard.title).count()).toBe(0);
      expect(
        await recorded.page.getByRole("option", { name: /Old work/u, includeHidden: true }).count(),
      ).toBeGreaterThan(0);
      await captureScreenshot(recorded.page, artifacts, "10-board-filter-ops");
    } finally {
      await closeRecordedPage(recorded, artifacts, "workboard-board-filter");
    }
  });
});
