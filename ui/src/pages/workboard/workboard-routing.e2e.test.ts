import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiRoute,
} from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import {
  createWorkboardProof,
  button,
  configSnapshot,
  expectFocus,
  makeBoard,
  makeCard,
} from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard routing",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed at ${executablePath}.`,
});

const artifactParent = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/workboard-routing");
const boards = [
  makeBoard("default"),
  makeBoard("ops", { name: "Operations", icon: "⚙", color: "#22c55e" }),
];

const sessions = {
  count: 0,
  defaults: { contextTokens: null, model: null, modelProvider: null },
  path: "",
  sessions: [],
  ts: 1,
};

function installWorkboard(page: Page, extra: Parameters<typeof installMockGateway>[1] = {}) {
  return installMockGateway(page, {
    ...workboardUi,
    ...extra,
    methodResponses: {
      "config.get": configSnapshot("workboard-routing-true"),
      "sessions.list": sessions,
      "workboard.boards.list": { boards },
      "workboard.cards.list": { boards, cards: [], statuses: ["todo", "done"] },
      ...extra.methodResponses,
    },
  });
}

function boardEntry(page: Page) {
  return page.locator("openclaw-app-sidebar .sidebar-pages__entry").filter({
    has: page.locator('[data-sidebar-entry="plugin:workboard/board-ops"]'),
  });
}

function pinnedBoard(page: Page) {
  return page.locator(
    'openclaw-app-sidebar .sidebar-rail [data-sidebar-entry="plugin:workboard/board-ops"] a',
  );
}

function agentValue(picker: Locator) {
  return picker.evaluate((element) => (element as HTMLElement & { value: string }).value);
}

suite.define(() => {
  it("routes, pins, persists, and normalizes Workboard boards", async () => {
    const proof = createWorkboardProof(
      suite,
      "workboard-routing",
      { width: 1600, height: 1000 },
      { parent: artifactParent },
    );
    const { page, close } = await proof.open("routing");
    try {
      const gateway = await installWorkboard(page);

      const response = await page.goto(`${suite.server.baseUrl}workboard/ops?agent=main`);
      expect(response?.status()).toBe(200);
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      const headerGlyph = page.locator(".workboard-board-glyph--header openclaw-appearance-glyph");
      await expect.poll(() => headerGlyph.textContent()).toContain("⚙");
      await expect
        .poll(() => headerGlyph.evaluate((element) => getComputedStyle(element).color))
        .toBe("rgb(34, 197, 94)");
      const filterTrigger = page.locator(".workboard-filter-trigger");
      await filterTrigger.click();
      await page.getByRole("button", { name: /^Filter by board:/u }).waitFor();
      await filterTrigger.click();
      await proof.capture(page, "01-board-route", page.locator(".shell"), [headerGlyph]);

      const sidebar = page.locator("openclaw-app-sidebar");
      await button(sidebar, "Pages").click();
      const workboardEntry = sidebar.locator(".sidebar-pages__entry").filter({
        has: page.locator('[data-sidebar-entry="plugin:workboard/workboard"]'),
      });
      await button(workboardEntry, "Pin").click();
      const pinnedWorkboard = sidebar.locator(
        '.sidebar-rail [data-sidebar-entry="plugin:workboard/workboard"]',
      );
      await pinnedWorkboard.getByRole("link", { name: "Workboard", exact: true }).waitFor();
      expect(await pinnedWorkboard.locator(".nav-item__children, .nav-item--child").count()).toBe(
        0,
      );
      const entry = boardEntry(page);
      await entry.getByRole("link", { name: "Operations", exact: true }).waitFor();
      await button(entry, "Pin").click();
      const pinned = pinnedBoard(page);
      await pinned.waitFor();
      expect(await pinned.getAttribute("href")).toBe("/workboard/ops");
      expect(await entry.getByRole("link", { name: "Operations", exact: true }).isVisible()).toBe(
        true,
      );
      expect(await button(entry, "Unpin").count()).toBe(1);
      await expect
        .poll(() =>
          page.evaluate((key) => {
            const stored = JSON.parse(localStorage.getItem(key) ?? "{}");
            return stored.railShortcuts;
          }, controlUiBundledSettingsStorageKey(suite.server.baseUrl)),
        )
        .toContain("plugin:workboard/board-ops");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      await proof.capture(page, "02-pinned-board", page.locator(".shell"), [pinned]);

      await page.goto(`${suite.server.baseUrl}workboard?board=ops&agent=main`);
      await waitForControlUiRoute(page, {
        pathname: "/workboard/ops",
        routeId: "workboard",
        search: "?agent=main",
      });

      await page.reload();
      await pinned.waitFor();
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      expect(await pinned.getAttribute("href")).toBe("/workboard/ops");
      await pinnedWorkboard.getByRole("link", { name: "Workboard", exact: true }).waitFor();
      expect(await pinnedWorkboard.locator(".nav-item__children, .nav-item--child").count()).toBe(
        0,
      );
      await proof.capture(page, "03-legacy-normalized-and-persisted", page.locator(".shell"), [
        page.locator(".workboard-page-title", { hasText: "Operations" }),
      ]);

      const historyBeforeMissingBoard = await page.evaluate(() => history.length);
      await page.goto(`${suite.server.baseUrl}workboard/deleted?agent=main`);
      await waitForControlUiRoute(page, {
        pathname: "/workboard",
        routeId: "workboard",
        search: "?agent=main",
      });
      await page.locator(".workboard-page-title", { hasText: "All boards" }).waitFor();
      expect(await page.evaluate(() => history.length)).toBe(historyBeforeMissingBoard + 1);
    } finally {
      await close();
    }
  });

  it("creates cards for the selected named agent without hiding them", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1600, height: 1000 },
      },
      async ({ page }) => {
        const createdCard = makeCard({
          id: "writer-card",
          title: "Keep the writer task visible",
          agentId: "writer",
        });

        const gateway = await installWorkboard(page, {
          methodResponses: {
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
        await page.goto(`${suite.server.baseUrl}workboard`);
        await gateway.waitForRequest("agents.list");

        const agentScope = page.locator(".workboard-agent-filter openclaw-agent-select");
        await agentScope.locator(".agent-select__trigger").click();
        const agentOptions = agentScope.locator(".agent-select__option[data-agent-option]");
        await expectFocus(agentOptions.filter({ hasText: "Main" }));
        await agentOptions.filter({ hasText: "Writer" }).click();
        await expect.poll(() => agentValue(agentScope)).toBe("writer");
        await expect
          .poll(
            () =>
              agentScope.evaluate((picker) => ({
                open:
                  picker.querySelector(".agent-select__trigger")?.getAttribute("aria-expanded") ===
                  "true",
                popupActive: picker.querySelector(".agent-select__menu")?.matches(":popover-open"),
              })),
            { timeout: 5_000 },
          )
          .toEqual({ open: false, popupActive: false });

        await gateway.deferNext("workboard.cards.create");
        await page.getByRole("button", { name: /New card/u }).click();

        const createForm = page.locator(".workboard-draft");
        const draftAgent = createForm.locator(".workboard-agent-select openclaw-agent-select");
        await expect.poll(() => agentValue(draftAgent)).toBe("writer");
        await createForm.getByLabel("Title").fill(createdCard.title);
        await createForm.getByRole("button", { name: /^Create$/u }).click();

        const createRequest = await gateway.waitForRequest("workboard.cards.create");
        expect(createRequest.params).toMatchObject({
          agentId: "writer",
          title: createdCard.title,
        });
        await gateway.resolveDeferred("workboard.cards.create", { card: createdCard });

        await page.locator(".workboard-card", { hasText: createdCard.title }).waitFor();
      },
    );
  });

  it("refreshes board navigation after browser Back retains an unfinished card draft", async () => {
    await suite.withPage(
      { serviceWorkers: "block", viewport: { width: 1600, height: 1000 } },
      async ({ page }) => {
        const gateway = await installWorkboard(page);
        await page.goto(`${suite.server.baseUrl}apps`);
        const sidebar = page.locator("openclaw-app-sidebar");
        await button(sidebar, "Pages").click();
        await button(boardEntry(page), "Pin").click();
        const pinned = pinnedBoard(page);
        await pinned.click();
        await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
        await page.getByRole("button", { name: /New card/u }).click();
        await page.locator(".workboard-draft__title").fill("Keep this unfinished card");

        await page.goBack();
        await waitForControlUiRoute(page, { pathname: "/apps", routeId: "apps", search: "" });
        await page.locator(".workboard-draft").waitFor({ state: "detached" });
        const renamedBoards = boards.map((board) =>
          board.id === "ops" ? { ...board, name: "Renamed operations" } : board,
        );
        await gateway.setMethodResponse("workboard.cards.list", {
          boards: renamedBoards,
          cards: [],
          statuses: ["todo", "done"],
        });
        await gateway.setMethodResponse("workboard.boards.list", { boards: renamedBoards });
        await gateway.emitGatewayEvent("plugin.workboard.changed", {
          epoch: "workboard-draft-navigation",
          revision: 1,
        });
        await expect.poll(() => pinned.textContent()).toContain("Renamed operations");

        await page.goForward();
        await expect
          .poll(() => page.locator(".workboard-draft__title").inputValue())
          .toBe("Keep this unfinished card");
      },
    );
  });

  it("hides Workboard navigation while the plugin is inactive", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        nativePlugins: [],
        methodResponses: {
          "config.get": configSnapshot("workboard-routing-false", false),
          "sessions.list": sessions,
          "workboard.boards.list": { boards },
        },
      });
      await page.goto(`${suite.server.baseUrl}chat`);
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
