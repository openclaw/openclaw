import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { waitForControlUiProofSurface } from "../../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../../test-helpers/control-ui-e2e.ts";
import {
  cardFitsWithinWorkboardContent,
  createMobileScrollCards,
  expectedMobileScrollGeometry,
  readMobileScrollGeometry,
} from "./workboard-scroll.e2e.test-support.ts";
import {
  createWorkboardCase,
  filters,
  boardPicker,
  stableRequests,
  html5Drag,
  button,
  cardsListResponse,
  configSnapshot,
  dialog,
  expectCount,
  expectFocus,
  expectVisible,
  installWorkboard,
  makeBoard,
  makeCard,
  moved,
  requestParams,
  sessionsListResponse,
} from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard E2E",
  startServerBeforeBrowser: true,
});
const time = Date.parse("2026-06-01T18:00:00.000Z");
const sessionKey = "agent:main:workboard-proof";
const card = (id: string, overrides: Partial<WorkboardCard> = {}, at = time) =>
  makeCard({ id, title: id, notes: "", ...overrides }, at);
const session = (status?: "running" | "done", updatedAt = time) => ({
  key: sessionKey,
  kind: "direct",
  displayName: "Implementation session",
  label: "Implementation session",
  status,
  updatedAt,
  hasActiveRun: status === "running",
});
const width = (element: Locator) => element.evaluate((node) => node.getBoundingClientRect().width);
const opacity = (element: Locator) => element.evaluate((node) => getComputedStyle(node).opacity);
const value = (element: Locator) =>
  element.evaluate((node) => (node as HTMLElement & { value: string }).value);
const boards = [
  makeBoard("default"),
  makeBoard("ops", { name: "Operations", icon: "⚙", color: "#22c55e" }),
];
const emptySessions = {
  count: 0,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  path: "",
  sessions: [],
  ts: 1,
};
const routingResponses = {
  "config.get": configSnapshot("workboard-routing-true"),
  "sessions.list": emptySessions,
  "workboard.boards.list": { boards },
  "workboard.cards.list": cardsListResponse([], boards, ["todo", "done"]),
};

const openBoard = createWorkboardCase(suite);

const boardEntry = (page: Page) =>
  page.locator("openclaw-app-sidebar .sidebar-pages__entry").filter({
    has: page.locator('[data-sidebar-entry="plugin:workboard/board-ops"]'),
  });
const pinnedBoard = (page: Page) =>
  page.locator(
    'openclaw-app-sidebar .sidebar-rail [data-sidebar-entry="plugin:workboard/board-ops"] a',
  );

suite.define(() => {
  it("persists creation, running moves, lifecycle sync and deferred refresh", async () => {
    const created = card(
      "card-1",
      { labels: ["ui", "proof"], notes: "Acceptance: browser proof", sessionKey },
      time + 1,
    );
    const edited = created;
    const running = { ...edited, status: "running" as const, updatedAt: time + 3 };
    const reviewed = {
      ...running,
      status: "review" as const,
      updatedAt: time + 4,
      events: [moved("review", time + 4, "running", "review")],
    };
    const refreshed = {
      ...reviewed,
      title: "Refreshed proof",
      notes: "Live invalidation",
      updatedAt: time + 5,
    };
    const ui = await openBoard("workboard-lifecycle", [], {
      clock: true,
      responses: { "sessions.list": sessionsListResponse([session()]) },
    });

    const { page, gateway, b, draft, details, tile, defer, resolve } = ui;
    await b("New card", page.locator(".workboard-heading__actions")).waitFor();
    await gateway.waitForRequest("workboard.cards.list");
    await expect.poll(() => page.locator(".workboard-refresh").isEnabled()).toBe(true);
    expect(await page.locator(".workboard-card").count()).toBe(0);
    await ui.snap("01-empty-board");
    await filters(page, true);
    const high = page
      .getByRole("group", { name: "Priority", exact: true })
      .getByRole("checkbox", { name: /High/u, disabled: false });
    await high.press("Space");
    await expect.poll(() => high.isChecked()).toBe(true);
    await high.uncheck();
    await expect.poll(() => high.isChecked()).toBe(false);
    await filters(page, false);

    await defer("create");
    await b("New card", page.locator(".workboard-heading__actions")).click();
    const createDialog = dialog(page, "New card");
    await expectVisible(createDialog);
    await ui.fields({ Title: created.title, Notes: created.notes ?? "", Labels: "ui, proof" });
    await draft.getByRole("button", { name: /^Session:/u }).click();
    await draft.getByRole("option", { name: /^Implementation session/u }).click();
    await ui.snap("02-create-dialog", createDialog, [
      draft.getByLabel("Title"),
      draft.getByLabel("Notes"),
    ]);
    const beforeCreate = await ui.count("workboard.cards.create");
    await b("Create", draft).click();
    const create = await gateway.waitForRequest("workboard.cards.create", {
      after: beforeCreate,
    });
    expect(requestParams(create)).toMatchObject({
      labels: created.labels,
      notes: created.notes,
      sessionKey,
      status: "todo",
      title: created.title,
    });
    const pendingControls = [
      ...["Title", "Notes", "Labels"].map((label) => draft.getByLabel(label)),
      draft.getByRole("button", { name: /^Session:/u }),
      draft
        .getByRole("group", { name: "Status", exact: true })
        .getByRole("radio", { name: "Todo", exact: true }),
      draft
        .getByRole("group", { name: "Priority", exact: true })
        .getByRole("radio", { name: "Normal", exact: true }),
      draft.locator(".workboard-agent-select .agent-select__trigger"),
      b("Cancel", draft).first(),
      b("Cancel", draft).last(),
    ];
    for (const control of pendingControls) {
      expect(await control.isDisabled()).toBe(true);
    }
    expect(await b("Cancel", draft).count()).toBe(2);
    expect(await draft.locator(".workboard-template-strip button:disabled").count()).toBe(5);
    await page.keyboard.press("Escape");
    await expectVisible(createDialog);
    await createDialog.click({ position: { x: 4, y: 4 } });
    await expectVisible(createDialog);
    await ui.setCards([created]);
    await resolve("create", created);
    await tile("Todo", created.title).waitFor();
    await ui.snap("03-created-card");

    await tile("Todo", edited.title).click();
    await details.getByText(edited.title).waitFor();
    await details.getByText("Acceptance: browser proof").waitFor();
    await details.getByRole("button", { name: /^Status:/u }).waitFor();
    await details.locator("button[popovertarget=workboard-detail-actions]").click();
    for (const name of ["Open session", "Edit card", "Archive card", "Delete card"]) {
      expect(await details.getByRole("button", { name }).count()).toBe(1);
    }
    expect(await details.getByRole("button", { name: "Stop session" }).count()).toBe(0);
    await ui.snap("05-detail-actions", dialog(page, edited.title), [
      details.getByRole("button", { name: "Open session" }),
    ]);
    await details.locator('button[aria-label="Close"]').click();

    await defer("move");
    const drag = tile("Todo", edited.title);
    await drag.dispatchEvent("dragstart");
    await expect.poll(() => drag.getAttribute("class")).toContain("workboard-card--dragging");
    await expect.poll(() => opacity(drag)).toBe("0.45");
    expect(await page.locator(".workboard-column--drop-target").count()).toBe(0);
    await ui.col("Running").dispatchEvent("dragover");
    await expectCount(page.locator(".workboard-column--drop-target"), 1);
    expect(await ui.col("Running").getAttribute("class")).toContain(
      "workboard-column--drop-target",
    );
    await ui.snap("06-drag-feedback");
    await drag.dispatchEvent("dragend");
    await expect.poll(() => drag.getAttribute("class")).not.toContain("workboard-card--dragging");
    const beforeMove = await ui.count("workboard.cards.move");
    await drag.dragTo(ui.col("Running"));
    expect(
      requestParams(await gateway.waitForRequest("workboard.cards.move", { after: beforeMove })),
    ).toMatchObject({ id: edited.id, status: "running" });
    await ui.setCards([running]);
    await resolve("move", running);
    await tile("Running", edited.title).waitFor();
    await ui.snap("07-moved-running");

    const updates = await ui.count("workboard.cards.update"),
      sessions = await ui.count("sessions.list");
    const completed = session("done", time + 4);
    await gateway.setMethodResponse("sessions.list", sessionsListResponse([completed]));
    await gateway.deferNext("sessions.list");
    await gateway.emitGatewayEvent("sessions.changed", {
      ...completed,
      reason: "lifecycle",
      sessionKey,
      ts: time + 4,
    });
    await gateway.waitForRequest("sessions.list", { after: sessions });
    await gateway.resolveDeferred("sessions.list");
    await page.waitForTimeout(250);
    expect(await gateway.getRequests("workboard.cards.update")).toHaveLength(updates);
    const lists = await ui.count("workboard.cards.list");
    await ui.setCards([reviewed]);
    await gateway.deferNext("workboard.cards.list");
    await ui.emit(1);
    await gateway.waitForRequest("workboard.cards.list", { after: lists });
    await gateway.resolveDeferred("workboard.cards.list");
    const reviewTile = tile("Review", edited.title);
    await reviewTile.waitFor();
    await ui.action(reviewTile, "View details");
    await page.getByRole("tab", { name: "Activity", exact: true }).click();
    await details.getByText("Moved to Review").waitFor();
    await ui.snap("08-lifecycle-review", dialog(page, edited.title), [
      details.getByText("Moved to Review"),
    ]);
    await details.locator('button[aria-label="Close"]').click();
    await details.waitFor({ state: "hidden" });

    await ui.action(reviewTile, "Edit card");
    await expectVisible(editDialog);
    await ui.fields({ Notes: "Keep unfinished notes" });
    const oldLists = await ui.count("workboard.cards.list"),
      oldBoards = await ui.count("workboard.boards.list");
    const response = cardsListResponse([refreshed]);
    response.boards.push(makeBoard("live", { name: "Live metadata" }));
    await gateway.setMethodResponse("workboard.cards.list", response);
    await gateway.setMethodResponse("workboard.boards.list", { boards: response.boards });
    await gateway.deferNext("workboard.boards.list");
    await ui.emit(2);
    await gateway.waitForRequest("workboard.boards.list", { after: oldBoards });
    await gateway.resolveDeferred("workboard.boards.list");
    expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(oldLists);
    expect(await draft.getByLabel("Notes").inputValue()).toBe("Keep unfinished notes");
    expect(await reviewTile.getByRole("heading", { includeHidden: true }).textContent()).toBe(
      reviewed.title,
    );
    expect(
      await page
        .getByRole("heading", { name: refreshed.title, exact: true, includeHidden: true })
        .count(),
    ).toBe(0);
    await gateway.deferNext("workboard.cards.list");
    await b("Cancel", draft.locator(":scope > .workboard-modal__actions")).click();
    await b("Discard", page.locator(".workboard-discard")).click();
    await gateway.waitForRequest("workboard.cards.list", { after: oldLists });
    const picker = await boardPicker(page);
    await expectCount(picker.getByRole("option", { name: /Live metadata/u }), 1);
    await picker.locator(".picker-select__trigger").click();
    await picker.locator(".picker-select__menu").waitFor({ state: "hidden" });
    await filters(page, false);
    await gateway.resolveDeferred("workboard.cards.list");
    await tile("Review", refreshed.title).waitFor();
    const afterRefresh = await ui.count("workboard.cards.list");
    await page.clock.fastForward(1_250);
    expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(afterRefresh);
    await gateway.deferNext("workboard.cards.list");
    await b("Refresh", page.locator(".workboard-heading__actions")).click();
    await gateway.waitForRequest("workboard.cards.list", { after: afterRefresh });
    await gateway.resolveDeferred("workboard.cards.list");
    await tile("Review", refreshed.title).waitFor();
    await ui.snap("09-reloaded-review");
  });

  it("keeps read-only cards inspectable without mutation controls or requests", async () => {
    const running = card("read-only", { status: "running", sessionKey });
    const { page, gateway, tile, details, snap } = await openBoard(
      "workboard-read-only",
      [running],
      {
        responses: { "sessions.list": sessionsListResponse([session("done", time + 4)]) },
        gateway: { operatorScopes: ["operator.read"] },
      },
    );

    const target = tile("Running", running.title);
    await target.waitFor();
    await snap("09-read-only-board");
    expect(await page.getByRole("button", { name: /New card/u }).count()).toBe(0);
    for (const name of ["Edit card", "Delete card", "Run default agent"]) {
      expect(await page.locator('button[aria-label="' + name + '"]').count()).toBe(0);
    }
    expect(await target.getAttribute("draggable")).toBe("false");
    await target.click();
    await details.getByText(running.title).waitFor();
    for (const name of [/^Status:/u, "Edit card", "Archive card", "Delete card"]) {
      expect(await details.getByRole("button", { name }).count()).toBe(0);
    }
    expect(await page.locator(".workboard-detail__note").count()).toBe(0);
    expect(await page.getByRole("button", { name: /Add note/u }).count()).toBe(0);
    for (const action of ["update", "move", "create"]) {
      expect(await gateway.getRequests("workboard.cards." + action)).toHaveLength(0);
    }
  });

  it("keeps card titles visible when a desktop column overflows", async () => {
    const cards = Array.from({ length: 8 }, (_, i) =>
      card("overflow-" + i, {
        position: 1000 + i,
        updatedAt: time + i,
        title: "Overflowing backlog card " + i + " with a long title wrapping onto two lines",
      }),
    );
    const { col, tile, snap } = await openBoard("workboard-overflow", cards, {
      size: { width: 1400, height: 720 },
      responses: { "sessions.list": sessionsListResponse([session()]) },
    });

    await col("Todo").waitFor();
    await tile("Todo", cards[0].title).waitFor();
    await snap("09-overflow-column");
    const heights = await col("Todo")
      .locator(".workboard-card h3")
      .evaluateAll((titles) => titles.map((title) => title.getBoundingClientRect().height));
    expect(heights).toHaveLength(8);
    for (const height of heights) {
      expect(height).toBeGreaterThan(0);
    }
    expect(
      await col("Todo")
        .locator(".workboard-column__cards")
        .evaluate((node) => node.scrollHeight > node.clientHeight + 1),
    ).toBe(true);
  });

  it("scrolls every mobile card into view without moving the toolbar or outer containers", async () => {
    const { page, col } = await openBoard("workboard-scroll", createMobileScrollCards(time), {
      size: { width: 390, height: 700 },
      responses: { "config.get": configSnapshot("workboard-mobile-scroll-e2e-config") },
      gateway: { sessions: [] },
    });

    const cards = col("Todo").locator(".workboard-column__cards");
    const last = col("Todo")
      .locator(".workboard-card", { hasText: "Mobile workboard card 6" })
      .first();
    const toolbar = page.locator(".workboard-toolbar");
    await last.waitFor({ state: "attached" });
    expect(await readMobileScrollGeometry(cards, "Mobile workboard card 6")).toEqual(
      expectedMobileScrollGeometry,
    );
    const top = await toolbar.evaluate((node) => node.getBoundingClientRect().top);
    await cards.hover();
    for (let attempt = 0; attempt < 8 && !(await cardFitsWithinWorkboardContent(last)); attempt++) {
      const previous = await cards.evaluate((node) => node.scrollTop);
      await page.mouse.wheel(0, 320);
      await expect.poll(() => cards.evaluate((node) => node.scrollTop)).toBeGreaterThan(previous);
    }
    await expect.poll(() => cards.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
    expect(await cardFitsWithinWorkboardContent(last)).toBe(true);
    expect(await toolbar.evaluate((node) => node.getBoundingClientRect().top)).toBeCloseTo(top, 0);
    for (const selector of [".workboard-board", ".content--workboard"]) {
      expect(await page.locator(selector).evaluate((node) => node.scrollTop)).toBe(0);
    }
  });

  it("collapses empty stages without squeezing columns and supports keyboard, touch and rail drops", async () => {
    const review = card("review", { status: "review" });
    const { page, col, b, tile, gateway, count, snap } = await openBoard(
      "workboard-columns",
      [review, card("done", { status: "done" })],
      {
        size: { width: 1200, height: 760 },
        responses: { "workboard.cards.move": { card: { ...review, status: "ready" } } },
      },
    );

    await tile("Review", review.title).waitFor();
    const header = col("Review").locator(".workboard-column__header");
    const collapse = b("Collapse Review column", header);
    expect(await opacity(collapse)).toBe("0");
    for (const [action, expected] of [
      [() => collapse.focus(), "1"],
      [() => collapse.blur(), "0"],
      [() => header.hover(), "1"],
    ] as const) {
      await action();
      await expect.poll(() => opacity(collapse)).toBe(expected);
    }
    const collapsed = page.locator(".workboard-column--collapsed");
    const empty = page.getByRole("group", { name: "Empty columns", exact: true });
    await expectCount(collapsed, 0);
    for (const [name, expectedCount] of [
      ["Hide empty", 2],
      ["Show all", 9],
      ["Collapse empty", 9],
    ] as const) {
      await filters(page, true);
      await b(name, empty).click();
      await expectCount(page.locator(".workboard-column"), expectedCount);
    }
    await expectCount(collapsed, 7);
    const narrow = await width(col("Ready")),
      wide = await width(col("Review"));
    expect(narrow).toBeGreaterThanOrEqual(44);
    expect(narrow).toBeLessThanOrEqual(52);
    expect(wide).toBeGreaterThanOrEqual(262);
    const rail = col("Ready").locator(".workboard-column__rail");
    expect(await rail.evaluate((node) => getComputedStyle(node).boxShadow)).toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const selector of [".workboard-column__collapse", ".workboard-column__rail-icon"]) {
      expect(
        await page
          .locator(selector)
          .first()
          .evaluate((node) => getComputedStyle(node).transitionDuration),
      ).toBe("0s");
    }
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await snap("10-collapsed-columns-desktop");
    await b("Expand Ready column").click();
    await expect
      .poll(() => col("Ready").getAttribute("class"))
      .not.toContain("workboard-column--collapsed");
    expect(await width(col("Ready"))).toBeGreaterThanOrEqual(262);
    await b("Collapse Ready column").click();
    await filters(page, false);
    const tabs = page.locator(".workboard-status-tabs");
    await b("Review", tabs).click();
    const geometry = await page
      .locator(".workboard-board--page.workboard-board--single-column")
      .evaluate((board) => {
        const column = board.querySelector(".workboard-column")!;
        const box = column.getBoundingClientRect();
        return { width: box.width, left: box.left - board.getBoundingClientRect().left };
      });
    expect(geometry.width).toBeCloseTo(wide, 0);
    expect(geometry.left).toBeCloseTo(0, 0);
    await b("All", tabs).click();
    await filters(page, false);
    const board = page.locator(".workboard-board--page");
    await board.evaluate((node) => node.scrollTo({ left: 0, behavior: "instant" }));
    await expect.poll(() => board.evaluate((node) => node.scrollLeft)).toBe(0);
    const moves = await count("workboard.cards.move");
    await tile("Review", review.title).dragTo(rail);
    expect(
      requestParams(await gateway.waitForRequest("workboard.cards.move", { after: moves })),
    ).toMatchObject({ id: review.id, status: "ready" });
    await page.setViewportSize({ width: 700, height: 760 });
    await filters(page, true);
    await expectCount(empty.getByRole("button"), 3);
    await filters(page, false);
    const expand = b("Expand Backlog column", col("Backlog"));
    await expand.scrollIntoViewIfNeeded();
    await expand.focus();
    await page.keyboard.press("Enter");
    await expectVisible(b("Collapse Backlog column", col("Backlog")));
    await expectVisible(b("New card in Backlog", col("Backlog")).last());
    await b("Collapse Backlog column", col("Backlog")).click();
    await expectVisible(expand);
    await snap("11-collapsed-columns-mobile");
  });

  it("keeps touch collapse controls visible and at least 44px", async () => {
    await suite.withPage({ hasTouch: true }, async ({ page }) => {
      await installWorkboard(page, [card("touch", { status: "review" })]);
      await page.setViewportSize({ width: 390, height: 844 });
      expect((await page.goto(suite.server.baseUrl + "workboard"))?.status()).toBe(200);
      const collapse = page.getByRole("button", { name: "Collapse Review column" });
      await collapse.waitFor();
      await waitForControlUiProofSurface(collapse, []);
      const geometry = await collapse.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return { height: box.height, width: box.width, opacity: getComputedStyle(node).opacity };
      });
      expect(geometry.opacity).toBe("1");
      expect(geometry.width).toBeGreaterThanOrEqual(44);
      expect(geometry.height).toBeGreaterThanOrEqual(44);
    });
  });

  it("filters persisted boards without growing history or losing query parameters", async () => {
    const plain = card("default-card", {});
    const ops = card("ops-card", {
      metadata: { automation: { boardId: "ops" } },
    });
    const choices = [
      makeBoard("default", { total: 1, active: 1, byStatus: { todo: 1 } }),
      makeBoard("ops", { name: "Operations", total: 1, active: 1, byStatus: { todo: 1 } }),
      makeBoard("archive", { name: "Old work", archivedAt: time }),
    ];
    const { page, tile, snap } = await openBoard("workboard-filter", [plain, ops], {
      path: "workboard?board=ops&agent=main",
      responses: {
        "workboard.boards.list": { boards: choices },
        "workboard.cards.list": cardsListResponse([plain, ops], choices),
      },
    });

    await tile("Todo", ops.title).waitFor();
    await expect.poll(() => new URL(page.url()).pathname).toBe("/workboard/ops");
    await expectCount(page.getByText(plain.title), 0);
    expect(new URL(page.url()).searchParams.has("board")).toBe(false);
    const history = await page.evaluate(() => window.history.length);
    for (const [id, path] of [
      ["__all__", "/workboard"],
      ["ops", "/workboard/ops"],
    ]) {
      const picker = await boardPicker(page);
      await picker.locator('[role="option"][data-value="' + id + '"]').click();
      if (id === "__all__") {
        await tile("Todo", plain.title).waitFor();
      }
      await expect.poll(() => new URL(page.url()).pathname).toBe(path);
      expect(new URL(page.url()).search).toBe("?agent=main");
    }
    expect(await page.evaluate(() => window.history.length)).toBe(history);
    expect(await page.getByText(plain.title).count()).toBe(0);
    expect(
      await (await boardPicker(page)).getByRole("option", { name: /Old work/u }).count(),
    ).toBeGreaterThan(0);
    await snap("10-board-filter-ops");
  });

  it("preserves an execution-owned session while editing a linked card", async () => {
    const original = card(
      "execution-card",
      {
        status: "running",
        execution: {
          id: "execution-linked",
          kind: "agent-session",
          engine: "codex",
          mode: "autonomous",
          status: "running",
          model: "openai/gpt-5.5",
          sessionKey,
          startedAt: 900,
          updatedAt: 2_000,
        },
      },
      2_000,
    );
    const updated = { ...original, title: "Renamed execution-linked work", updatedAt: 2_500 };
    const {
      page,
      gateway,
      action,
      strictTile: tile,
      draft,
      fields,
      b,
    } = await openBoard("execution-linked", [original], {
      size: { width: 1280, height: 900 },
      responses: {
        "config.get": {
          config: { plugins: { entries: { workboard: { enabled: true } } } },
          hash: "execution-linked-workboard-e2e-config",
        },
        "sessions.list": sessionsListResponse([session("running", 2_000)], Date.now()),
        "workboard.cards.update": { card: updated },
      },
    });

    const target = tile("Running", original.title);
    await target.waitFor({ timeout: 10_000 });
    await action(target, "Edit card");
    const edit = dialog(page, "Edit card");
    await edit.waitFor({ timeout: 10_000 });
    await expectVisible(b("Session: Implementation session", draft));
    await fields({ Title: updated.title });
    await b("Save").click();
    const requests = await stableRequests(gateway, "workboard.cards.update", 1);
    expect(requestParams(requests[0]!)).toEqual({
      id: original.id,
      expectedUpdatedAt: original.updatedAt,
      patch: { title: updated.title },
    });
    await edit.waitFor({ state: "detached", timeout: 10_000 });
    await tile("Running", updated.title).waitFor({ timeout: 10_000 });
  });

  it("persists reopened fields and keeps a dragged linked card ahead of stale lifecycle", async () => {
    const events = [moved("manual-todo", 2_000, "running", "todo")];
    const original = card(
      "card-1",
      {
        sessionKey,
        agentId: "main",
        labels: ["ui"],
        notes: "Original notes",
        createdAt: 900,
        events,
      },
      2_000,
    );
    const patch = {
      title: "Persisted renamed card",
      notes: "Edited notes survive reopening.",
      priority: "high" as const,
      labels: ["ui", "proof", "e2e"],
    };
    const edited = {
      ...original,
      ...patch,
      updatedAt: 2_500,
      events: [...events, { id: "edited", kind: "edited" as const, at: 2_500 }],
    };
    const dragged = {
      ...edited,
      status: "running" as const,
      position: 6_000,
      updatedAt: 3_000,
      events: [...edited.events, moved("manual-running", 3_000, "todo", "running")],
    };
    const stale = {
      ...dragged,
      status: "review" as const,
      updatedAt: 3_500,
      events: [...dragged.events, moved("stale-review", 3_500, "running", "review")],
    };
    const product = card(
      "product",
      {
        status: "running",
        position: 9_000,
        createdAt: 900,
        metadata: { automation: { boardId: "product" } },
      },
      2_000,
    );
    const archived = card(
      "archived",
      { status: "running", position: 3_000, createdAt: 900, metadata: { archivedAt: 1_000 } },
      2_000,
    );
    const {
      page,
      gateway,
      strictTile: tile,
      action,
      fields,
      b,
      draft,
      snap,
    } = await openBoard("workboard-status-persistence", [original, product, archived], {
      size: { width: 1280, height: 900 },
      responses: {
        "config.get": {
          config: { plugins: { entries: { workboard: { enabled: true } } } },
          hash: "workboard-e2e-config",
        },
        "sessions.list": sessionsListResponse([session("done", 1_000)], Date.now()),
        "workboard.cards.move": { card: dragged },
        "workboard.cards.update": {
          cases: [
            {
              match: { id: original.id, expectedUpdatedAt: original.updatedAt, patch },
              response: { card: edited },
            },
            {
              match: { id: original.id, patch: { status: "review" } },
              response: { card: stale },
            },
          ],
        },
      },
    });

    const todo = tile("Todo", original.title),
      renamed = tile("Todo", edited.title),
      running = tile("Running", edited.title);
    await todo.waitFor({ timeout: 10_000 });
    await tile("Running", product.title).waitFor({ timeout: 10_000 });
    await expectCount(page.getByText(archived.title), 0);
    await stableRequests(gateway, "workboard.cards.update", 0);
    await action(todo, "Edit card");
    const edit = dialog(page, "Edit card");
    await edit.waitFor({ timeout: 10_000 });
    await fields({ Title: patch.title, Notes: patch.notes, Labels: "ui, proof, e2e" });
    const priority = draft.getByRole("radio", { name: "High", exact: true });
    await priority.focus();
    await page.keyboard.press("Space");
    await b("Save").click();
    expect(requestParams((await stableRequests(gateway, "workboard.cards.update", 1))[0]!)).toEqual(
      { id: original.id, expectedUpdatedAt: original.updatedAt, patch },
    );
    await edit.waitFor({ state: "detached", timeout: 10_000 });
    await renamed.waitFor({ timeout: 10_000 });
    await action(renamed, "Edit card");
    await edit.waitFor({ timeout: 10_000 });
    await expect
      .poll(async () => ({
        title: await draft.getByLabel("Title").inputValue(),
        notes: await draft.getByLabel("Notes").inputValue(),
        high: await priority.isChecked(),
        labels: await draft.getByLabel("Labels").inputValue(),
      }))
      .toEqual({
        title: patch.title,
        notes: patch.notes,
        high: true,
        labels: "ui, proof, e2e",
      });
    await snap("workboard-edit-reopen", edit, [
      draft.getByLabel("Title"),
      draft.getByLabel("Notes"),
    ]);
    await b("Cancel", draft.locator(":scope > .workboard-modal__actions").last()).click();
    await edit.waitFor({ state: "detached", timeout: 10_000 });
    await html5Drag(renamed, tile("Running", product.title));
    const move = requestParams(await gateway.waitForRequest("workboard.cards.move"));
    expect(move).toMatchObject({ id: original.id, status: "running" });
    expect(move.position).toBeGreaterThan(archived.position);
    expect(move.position).toBeLessThan(product.position);
    await running.waitFor({ timeout: 10_000 });
    await expect
      .poll(() =>
        page
          .locator(".workboard-column--running .workboard-card")
          .getByRole("heading")
          .allTextContents(),
      )
      .toEqual([edited.title, product.title]);
    await stableRequests(gateway, "workboard.cards.update", 1);
    await snap("workboard-drag-running-persisted", page.locator(".shell"), [running]);
  });

  it("routes, pins, persists and normalizes boards", async () => {
    const { page, gateway, b, goto, snap } = await openBoard("workboard-routing", [], {
      path: "workboard/ops?agent=main",
      size: { width: 1600, height: 1000 },
      responses: routingResponses,
    });

    const title = page.locator(".workboard-page-title", { hasText: "Operations" });
    await title.waitFor();
    const glyph = page.locator(".workboard-board-glyph--header openclaw-appearance-glyph");
    await expect.poll(() => glyph.textContent()).toContain("⚙");
    await expect
      .poll(() => glyph.evaluate((node) => getComputedStyle(node).color))
      .toBe("rgb(34, 197, 94)");
    const trigger = page.locator(".workboard-filter-trigger");
    await trigger.click();
    await page.getByRole("button", { name: /^Filter by board:/u }).waitFor();
    await trigger.click();
    await snap("01-board-route", page.locator(".shell"), [glyph]);
    const sidebar = page.locator("openclaw-app-sidebar");
    await b("Pages", sidebar).click();
    const workboard = sidebar
      .locator(".sidebar-pages__entry")
      .filter({ has: page.locator('[data-sidebar-entry="plugin:workboard/workboard"]') });
    await b("Pin", workboard).click();
    const pinnedRoot = sidebar.locator(
      '.sidebar-rail [data-sidebar-entry="plugin:workboard/workboard"]',
    );
    const rootLink = pinnedRoot.getByRole("link", { name: "Workboard", exact: true });
    await rootLink.waitFor();
    expect(await pinnedRoot.locator(".nav-item__children, .nav-item--child").count()).toBe(0);
    const entry = boardEntry(page),
      link = entry.getByRole("link", { name: "Operations", exact: true });
    await link.waitFor();
    await b("Pin", entry).click();
    const pinned = pinnedBoard(page);
    await pinned.waitFor();
    expect(await pinned.getAttribute("href")).toBe("/workboard/ops");
    expect(await link.isVisible()).toBe(true);
    expect(await b("Unpin", entry).count()).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(
          (key) => JSON.parse(localStorage.getItem(key) ?? "{}").railShortcuts,
          controlUiBundledSettingsStorageKey(suite.server.baseUrl),
        ),
      )
      .toContain("plugin:workboard/board-ops");
    expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
    await snap("02-pinned-board", page.locator(".shell"), [pinned]);
    await goto("workboard?board=ops&agent=main");
    await waitForControlUiRoute(page, {
      pathname: "/workboard/ops",
      routeId: "workboard",
      search: "?agent=main",
    });
    await page.reload();
    await pinned.waitFor();
    await title.waitFor();
    expect(await pinned.getAttribute("href")).toBe("/workboard/ops");
    await rootLink.waitFor();
    expect(await pinnedRoot.locator(".nav-item__children, .nav-item--child").count()).toBe(0);
    await snap("03-legacy-normalized-and-persisted", page.locator(".shell"), [title]);
    const history = await page.evaluate(() => window.history.length);
    await goto("workboard/deleted?agent=main");
    await waitForControlUiRoute(page, {
      pathname: "/workboard",
      routeId: "workboard",
      search: "?agent=main",
    });
    await page.locator(".workboard-page-title", { hasText: "Workboard" }).waitFor();
    expect(await page.evaluate(() => window.history.length)).toBe(history + 1);
  });

  it("creates cards for the selected named agent without hiding them", async () => {
    const created = card("writer-card", { agentId: "writer" }, 1);
    const { page, gateway, draft, fields, b } = await openBoard("workboard-agent", [], {
      size: { width: 1600, height: 1000 },
      responses: {
        ...routingResponses,
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: [
            { id: "main", name: "Main" },
            { id: "writer", name: "Writer" },
          ],
        },
      },
    });

    await gateway.waitForRequest("agents.list");
    const picker = page.locator(".workboard-agent-filter openclaw-agent-select");
    await picker.locator(".agent-select__trigger").click();
    const options = picker.locator(".agent-select__option[data-agent-option]");
    await expectFocus(options.filter({ hasText: "Main" }));
    await options.filter({ hasText: "Writer" }).click();
    await expect.poll(() => value(picker)).toBe("writer");
    await expect
      .poll(
        () =>
          picker.evaluate((node) => ({
            open:
              node.querySelector(".agent-select__trigger")?.getAttribute("aria-expanded") ===
              "true",
            popupActive: node.querySelector(".agent-select__menu")?.matches(":popover-open"),
          })),
        { timeout: 5_000 },
      )
      .toEqual({ open: false, popupActive: false });
    await gateway.deferNext("workboard.cards.create");
    await page.getByRole("button", { name: /New card/u }).click();
    await expect
      .poll(() => value(draft.locator(".workboard-agent-select openclaw-agent-select")))
      .toBe("writer");
    await fields({ Title: created.title });
    await b("Create", draft).click();
    expect((await gateway.waitForRequest("workboard.cards.create")).params).toMatchObject({
      agentId: "writer",
      title: created.title,
    });
    await gateway.resolveDeferred("workboard.cards.create", { card: created });
    await page.locator(".workboard-card", { hasText: created.title }).waitFor();
  });

  it("refreshes pinned navigation after Back without discarding an unfinished draft", async () => {
    const { page, gateway, b, fields } = await openBoard("workboard-back", [], {
      path: "apps",
      size: { width: 1600, height: 1000 },
      responses: routingResponses,
    });

    await b("Pages", page.locator("openclaw-app-sidebar")).click();
    await b("Pin", boardEntry(page)).click();
    const pinned = pinnedBoard(page);
    await pinned.click();
    await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
    await page.getByRole("button", { name: /New card/u }).click();
    await fields({ Title: "Keep unfinished card" });
    await page.goBack();
    await waitForControlUiRoute(page, { pathname: "/apps", routeId: "apps", search: "" });
    await page.locator(".workboard-draft").waitFor({ state: "detached" });
    const renamed = boards.map((board) =>
      board.id === "ops" ? { ...board, name: "Renamed operations" } : board,
    );
    await gateway.setMethodResponse(
      "workboard.cards.list",
      cardsListResponse([], renamed, ["todo", "done"]),
    );
    await gateway.setMethodResponse("workboard.boards.list", { boards: renamed });
    await gateway.emitGatewayEvent("plugin.workboard.changed", {
      epoch: "workboard-draft-navigation",
      revision: 1,
    });
    await expect.poll(() => pinned.textContent()).toContain("Renamed operations");
    await page.goForward();
    await expect
      .poll(() => page.locator(".workboard-draft__title").inputValue())
      .toBe("Keep unfinished card");
  });

  it("hides navigation and avoids board reads while the plugin is inactive", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        nativePlugins: [],
        methodResponses: {
          "config.get": configSnapshot("workboard-routing-false", false),
          "sessions.list": emptySessions,
          "workboard.boards.list": { boards },
        },
      });
      await page.goto(suite.server.baseUrl + "chat");
      const sidebar = page.locator("openclaw-app-sidebar");
      await gateway.waitForRequest("config.get");
      await button(sidebar, "Pages").click();
      const pages = sidebar.locator(".sidebar-pages");
      await pages.waitFor();
      expect(await pages.getByRole("link", { name: "Workboard", exact: true }).count()).toBe(0);
      expect(await pages.locator('[data-sidebar-entry^="plugin:workboard/"]').count()).toBe(0);
      expect(
        await sidebar.locator('.sidebar-rail [data-sidebar-entry^="plugin:workboard/"]').count(),
      ).toBe(0);
      expect(await gateway.getRequests("workboard.boards.list")).toHaveLength(0);
    });
  });
});
