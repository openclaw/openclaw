import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { agentRoster } from "../../e2e/agent-roster.test-support.ts";
import { createControlUiE2eSuite } from "../../e2e/control-ui-e2e-suite.test-support.ts";
import { installMockGateway, waitForControlUiRoute } from "../../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../../test-helpers/control-ui-workboard-fixture.ts";
import {
  button,
  configSnapshot,
  expectFocus,
  makeBoard,
  makeCard,
} from "./workboard.e2e.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard routing",
});

const withPage = (run: (page: Page) => Promise<void>) =>
  suite.withPage(
    { locale: "en-US", serviceWorkers: "block", viewport: { width: 1600, height: 1000 } },
    ({ page }) => run(page),
  );

const boards = [
  makeBoard("default"),
  makeBoard("ops", { name: "Operations", icon: "⚙", color: "#22c55e" }),
];

function installWorkboard(page: Page, extra: Parameters<typeof installMockGateway>[1] = {}) {
  return installMockGateway(page, {
    ...workboardUi,
    sessions: [],
    ...extra,
    methodResponses: {
      "config.get": configSnapshot("workboard-routing-true"),
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
  it("renders board appearance and replaces a missing board route", async () => {
    await withPage(async (page) => {
      await installWorkboard(page);
      await page.goto(suite.server.baseUrl + "workboard/ops?agent=main");
      await page.locator(".workboard-page-title", { hasText: "Operations" }).waitFor();
      const glyph = page.locator(".workboard-board-glyph--header openclaw-appearance-glyph");
      await expect.poll(() => glyph.textContent()).toContain("⚙");
      await expect
        .poll(() => glyph.evaluate((element) => getComputedStyle(element).color))
        .toBe("rgb(34, 197, 94)");
      const length = await page.evaluate(() => history.length);
      await page.goto(suite.server.baseUrl + "workboard/deleted?agent=main");
      await waitForControlUiRoute(page, {
        pathname: "/workboard",
        routeId: "workboard",
        search: "?agent=main",
      });
      await page.locator(".workboard-page-title", { hasText: "All boards" }).waitFor();
      expect(await page.evaluate(() => history.length)).toBe(length + 1);
    });
  });

  it("creates cards for the selected named agent without hiding them", async () => {
    await withPage(async (page) => {
      const createdCard = makeCard({
        id: "writer-card",
        title: "Keep the writer task visible",
        agentId: "writer",
      });

      const gateway = await installWorkboard(page, {
        methodResponses: {
          "agents.list": agentRoster({ main: "Main", writer: "Writer" }, "main", "agent"),
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
        .poll(() => agentScope.locator(".agent-select__menu:popover-open").count())
        .toBe(0);

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
      expect(
        await createForm
          .locator("input:enabled, textarea:enabled, select:enabled, button:enabled")
          .count(),
      ).toBe(0);
      const dialog = page.getByRole("dialog", { name: "New card", exact: true });
      await page.keyboard.press("Escape");
      expect(await dialog.isVisible()).toBe(true);
      await dialog.click({ position: { x: 4, y: 4 } });
      expect(await dialog.isVisible()).toBe(true);
      await gateway.resolveDeferred("workboard.cards.create", { card: createdCard });

      await page.locator(".workboard-card", { hasText: createdCard.title }).waitFor();
    });
  });

  it("refreshes board navigation after browser Back retains an unfinished card draft", async () => {
    await withPage(async (page) => {
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
    });
  });

  it("hides Workboard navigation while the plugin is inactive", async () => {
    await suite.withPage({ serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        nativePlugins: [],
        sessions: [],
        methodResponses: {
          "config.get": configSnapshot("workboard-routing-false", false),
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
