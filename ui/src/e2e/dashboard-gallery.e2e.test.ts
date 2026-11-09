import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { SessionsResolveResult } from "../../../packages/gateway-protocol/src/index.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { seedChatSettings } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";
import { themeConfigResponse } from "./theme-typography.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard gallery",
  startServerBeforeBrowser: true,
});

const now = Date.now();
const selectedSessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const selectedResolution = {
  ok: true,
  key: selectedSessionKey,
  agentId: "main",
  displayName: "Release health",
  boardFace: "dashboard",
  boardPresentation: "expanded",
} satisfies SessionsResolveResult;
const capacityKey = "agent:main:dashboard:capacity";
const agesSeconds = [3, 8, 18, 42, 75, 130, 160, 190, 220, 250, 280, 310];
const dashboardRows = agesSeconds.map((age, index) => ({
  key:
    index === 0
      ? selectedSessionKey
      : index === 11
        ? capacityKey
        : `agent:main:dashboard:sample-${index}`,
  kind: "direct",
  boardFace: "dashboard",
  boardPresentation: "expanded",
  displayName: index === 0 ? selectedResolution.displayName : `Dashboard ${index}`,
  updatedAt: now - age * 1_000,
  status: index === 0 ? "running" : "done",
  createdActor: {
    type: "human",
    id: index % 2 ? "riley" : "mira",
    label: index % 2 ? "Riley" : "Mira",
  },
}));

const widgetMarkup = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#111827;color:#f8fafc;font:16px sans-serif"><main style="padding:24px"><h1>Live Gateway Pulse</h1><strong>All systems nominal</strong><p><label>Notes <input aria-label="Notes"></label></p><button onclick="document.querySelector('ul').replaceChildren(...Array.from(document.querySelectorAll('li')).reverse())">Reverse rows</button><ul><li>café</li><li>雪</li><li>🦞</li></ul></main></body></html>`;
const resolveMatch = { shortId: "1234567890abcdef1234567890abcdef", agentId: "main" };
const responseCase = (match: object, response: unknown) => ({ match, response });
const boardWidget = (name: string, title: string, contentKind: string, position: number) => ({
  name,
  title,
  contentKind,
  position,
  tabId: "main",
  sizeW: 12,
  sizeH: 6,
  grantState: "granted",
  revision: 1,
});
const boardSnapshots = dashboardRows.map((row) => ({
  sessionKey: row.key,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [
    {
      ...boardWidget("gateway-pulse", "Live Gateway Pulse", "html", 0),
      frameUrl: "/dashboard-gallery-widget.html",
    },
    ...(row.key === selectedSessionKey
      ? [boardWidget("release-tools", "Release tools", "mcp-app", 1)]
      : []),
  ],
}));
async function waitForPreview(card: Locator) {
  const frame = card.locator('iframe[title="Live Gateway Pulse"]');
  await frame.waitFor();
  await frame.contentFrame().getByText("All systems nominal", { exact: true }).waitFor();
}
async function searchDashboards(gallery: Locator, query: string) {
  const field = gallery.getByRole("searchbox", { name: "Search dashboards", exact: true });
  if (!(await field.isVisible())) {
    await gallery.getByRole("button", { name: "Search dashboards", exact: true }).click();
  }
  await field.fill(query);
}
suite.define(() => {
  it.each(["dark", "light"] as const)("fits empty dashboard previews in %s mode", async (mode) => {
    const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    const emptyKey = "agent:main:dashboard:empty";
    const rows = [
      { ...dashboardRows[0]!, hasBoard: true },
      {
        ...dashboardRows[1]!,
        key: emptyKey,
        hasBoard: true,
        displayName: "A dashboard with a long title that should stay inside its gallery card",
      },
    ];
    const list = (sessions: typeof rows) => ({
      ts: now,
      path: "",
      count: sessions.length,
      defaults: { contextTokens: null, model: null, modelProvider: null },
      sessions,
    });
    await suite.withPage(
      {
        colorScheme: mode,
        viewport: { width: 1440, height: 900 },
        ...(capture
          ? { recordVideo: { dir: suite.artifactDir, size: { width: 1440, height: 900 } } }
          : {}),
      },
      async ({ page }) => {
        await seedChatSettings(page, suite.server.baseUrl, { theme: "dash", themeMode: mode });
        await page.route("**/dashboard-gallery-widget.html", (route) =>
          route.fulfill({ contentType: "text/html; charset=utf-8", body: widgetMarkup }),
        );
        const gateway = await installMockGateway(page, {
          sessions: rows,
          featureMethods: ["board.get"],
          deferredRequests: [{ method: "sessions.list", match: { hasBoard: true } }],
          methodResponses: {
            "config.get": themeConfigResponse("dash", mode),
            "sessions.list": { cases: [responseCase({ hasBoard: true }, list(rows))] },
            "board.get": {
              cases: [
                responseCase({ sessionKey: selectedSessionKey }, boardSnapshots[0]),
                responseCase(
                  { sessionKey: emptyKey },
                  { ...boardSnapshots[1], sessionKey: emptyKey, widgets: [] },
                ),
              ],
            },
          },
        });
        await page.goto(`${suite.server.baseUrl}dashboards`);
        const gallery = page.locator("openclaw-dashboards-page");
        const header = gallery.locator(".dashboards-header");
        await gallery.locator(".dashboards-loading").waitFor();
        const loadingHeader = await header.boundingBox();
        await gateway.resolveDeferred("sessions.list");
        await gallery.locator("[data-dashboard-session]").first().waitFor();
        const loadedHeader = await header.boundingBox();
        expect(loadedHeader!.y).toBeCloseTo(loadingHeader!.y, 0);
        expect(Math.abs(loadedHeader!.height - loadingHeader!.height)).toBeLessThan(1);
        const emptyCard = gallery.locator(`[data-dashboard-session="${emptyKey}"]`);
        const filledCard = gallery.locator(`[data-dashboard-session="${selectedSessionKey}"]`);
        const empty = emptyCard.locator(".board-empty");
        await empty.waitFor();
        await waitForPreview(filledCard);
        await expect.poll(() => page.locator("html").getAttribute("data-theme-id")).toBe("dash");
        await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
        const saveFrame = async (name: string, element: Locator) => {
          if (!capture) {
            return;
          }
          const frame = await takeControlUiScreenshotFrame(
            page,
            page.locator("openclaw-app"),
            [element],
            {
              animations: "disabled",
              scrollTo: element,
              elements: [element],
            },
          );
          writeFileSync(path.join(suite.artifactDir, `${mode}-${name}.png`), frame.png);
          writeFileSync(
            path.join(suite.artifactDir, `${mode}-${name}-crop.png`),
            frame.elements[0]!.png,
          );
        };
        const measurements = [];
        for (const width of [1280, 320]) {
          await page.setViewportSize({ width, height: 900 });
          await emptyCard.scrollIntoViewIfNeeded();
          await saveFrame(`gallery-${width}`, emptyCard);
          const bounds = await empty.evaluate((element) => {
            const preview = element.closest(".dashboard-preview")!.getBoundingClientRect();
            return {
              preview: {
                top: preview.top,
                bottom: preview.bottom,
                left: preview.left,
                right: preview.right,
              },
              // The sheet extends beyond its frame; the empty-state content must stay readable.
              content: [...element.children].map((child) => {
                const rect = child.getBoundingClientRect();
                return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
              }),
            };
          });
          measurements.push({ width, bounds });
          for (const content of bounds.content) {
            expect
              .soft(content.top, `empty preview top at ${width}px`)
              .toBeGreaterThanOrEqual(bounds.preview.top);
            expect
              .soft(content.bottom, `empty preview bottom at ${width}px`)
              .toBeLessThanOrEqual(bounds.preview.bottom);
            expect.soft(content.left).toBeGreaterThanOrEqual(bounds.preview.left);
            expect.soft(content.right).toBeLessThanOrEqual(bounds.preview.right);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
        await emptyCard.scrollIntoViewIfNeeded();
        const restingY = (await emptyCard.boundingBox())!.y;
        await emptyCard.hover();
        await expect.poll(async () => (await emptyCard.boundingBox())!.y).toBeLessThan(restingY);
        await saveFrame("hover", emptyCard);
        await searchDashboards(gallery, "No matching dashboard");
        await gallery.locator("[data-dashboards-no-results]").waitFor();
        await saveFrame("search-empty", gallery.locator("[data-dashboards-no-results]"));
        await gateway.setMethodResponse("sessions.list", {
          cases: [responseCase({ hasBoard: true }, list([]))],
        });
        await page.reload();
        await gallery.locator(".dashboards-loading").waitFor();
        await gateway.resolveDeferred("sessions.list");
        await gallery.locator("[data-dashboards-empty]").waitFor();
        expect(await gallery.locator("[data-dashboards-no-results]").count()).toBe(0);
        await saveFrame("catalog-empty", gallery.locator("[data-dashboards-empty]"));
        if (capture) {
          const theme = await page.evaluate(() => ({
            id: document.documentElement.dataset.themeId,
            mode: document.documentElement.dataset.themeMode,
            palette: document.documentElement.dataset.theme,
            sheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
              .filter((link) => link.href.includes("/themes/"))
              .map((link) => ({ href: link.href, loaded: Boolean(link.sheet) })),
            background: getComputedStyle(document.body).backgroundColor,
            color: getComputedStyle(document.body).color,
          }));
          writeFileSync(
            path.join(suite.artifactDir, `${mode}-measurements.json`),
            JSON.stringify({ theme, measurements }, null, 2),
          );
        }
      },
    );
  });

  it.each(["grid", "list"] as const)(
    "keeps the phone %s geometry from skeleton to loaded",
    async (view) => {
      const rows = [{ ...dashboardRows[0]!, hasBoard: true }];
      await suite.withPage(
        { colorScheme: "light", viewport: { width: 390, height: 844 } },
        async ({ page }) => {
          await page.route("**/dashboard-gallery-widget.html", (route) =>
            route.fulfill({ contentType: "text/html; charset=utf-8", body: widgetMarkup }),
          );
          await seedChatSettings(page, suite.server.baseUrl, {
            dashboardsDisplay: { view, sort: "updated", group: "none" },
          });
          const gateway = await installMockGateway(page, {
            sessions: rows,
            featureMethods: ["board.get"],
            deferredRequests: [{ method: "sessions.list", match: { hasBoard: true } }],
            methodResponses: {
              "board.get": boardSnapshots[0],
              "sessions.list": {
                cases: [
                  responseCase(
                    { hasBoard: true },
                    {
                      ts: now,
                      path: "",
                      count: rows.length,
                      defaults: { contextTokens: null, model: null, modelProvider: null },
                      sessions: rows,
                    },
                  ),
                ],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}dashboards`);
          const gallery = page.locator("openclaw-dashboards-page");
          const geometry = async () => {
            const header = (await gallery.locator(".dashboards-header").boundingBox())!;
            const card = (await gallery
              .locator(".dashboard-row, .dashboard-card")
              .first()
              .boundingBox())!;
            return { headerHeight: header.height, cardY: card.y, cardHeight: card.height };
          };
          await gallery.locator(".dashboards-loading").waitFor();
          const loading = await geometry();
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              path: path.join(suite.artifactDir, `phone-${view}-loading.png`),
            });
          }
          await gateway.resolveDeferred("sessions.list");
          await gallery.locator("[data-dashboard-session]").first().waitFor();
          await gallery.locator("[data-dashboard-session]").waitFor();
          const loaded = await geometry();
          console.log("phone gallery geometry", view, { loading, loaded });
          if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
            await page.screenshot({
              path: path.join(suite.artifactDir, `phone-${view}-loaded.png`),
            });
          }
          expect(loaded.headerHeight).toBeCloseTo(loading.headerHeight, 0);
          expect(loaded.cardY).toBeCloseTo(loading.cardY, 0);
          expect(loaded.cardHeight).toBeCloseTo(loading.cardHeight, 0);
        },
      );
    },
  );

  it("bounds mounted dashboards across list and small author groups", async () => {
    const rows = Array.from({ length: 1_000 }, (_, index) => ({
      ...dashboardRows[index % dashboardRows.length]!,
      key: `agent:main:dashboard:volume-${index}`,
      displayName: `Volume ${String(index).padStart(4, "0")}`,
      hasBoard: true,
      createdActor: {
        type: "human",
        id: `author-${Math.floor(index / 2)}`,
        label: `Author ${Math.floor(index / 2)}`,
      },
    }));
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, { sessions: rows });
      await page.goto(`${suite.server.baseUrl}dashboards`);
      const gallery = page.locator("openclaw-dashboards-page");
      const entries = gallery.locator("[data-dashboard-session]");
      await entries.first().waitFor();
      const counts: number[] = [];
      for (const [view, group] of [
        ["Grid", "none"],
        ["List", "none"],
        ["List", "author"],
        ["Grid", "author"],
      ] as const) {
        await gallery.getByRole("button", { name: "Display", exact: true }).click();
        const menu = page.locator("#dashboards-display");
        await menu.getByRole("button", { name: view, exact: true }).click();
        await menu.getByLabel("Grouping").selectOption(group);
        await menu.getByLabel("Ordering").selectOption("title");
        await page.keyboard.press("Escape");
        await menu.waitFor({ state: "hidden" });
        await entries.first().waitFor();
        await expect
          .poll(() =>
            entries
              .first()
              .locator(view === "List" ? ".dashboard-row__thumb" : ".dashboard-preview")
              .count(),
          )
          .toBe(1);
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        counts.push(await entries.count());
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await page.screenshot({
            path: path.join(suite.artifactDir, `volume-${view}-${group}.png`),
          });
        }
        const second = gallery.locator(
          '[data-dashboard-session="agent:main:dashboard:volume-1"] a',
        );
        const third = gallery.locator('[data-dashboard-session="agent:main:dashboard:volume-2"] a');
        await second.focus();
        await page.keyboard.press("Tab");
        expect(await third.evaluate((element) => element.matches(":focus"))).toBe(true);
        await page.keyboard.press("Shift+Tab");
        expect(await second.evaluate((element) => element.matches(":focus"))).toBe(true);
        await page.locator(".content").evaluate((element) => {
          element.scrollTop = element.scrollHeight / 2;
        });
        await expect
          .poll(() =>
            entries.evaluateAll((elements) =>
              elements.some((element) => {
                const index = Number(
                  element.getAttribute("data-dashboard-session")?.split("-").at(-1),
                );
                const box = element.getBoundingClientRect();
                return index > 400 && index < 600 && box.top < innerHeight && box.bottom > 0;
              }),
            ),
          )
          .toBe(true);
        const last = gallery.locator('[data-dashboard-session="agent:main:dashboard:volume-999"]');
        await last.scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            last.evaluate((element) => {
              const box = element.getBoundingClientRect();
              return box.top < innerHeight && box.bottom > 0;
            }),
          )
          .toBe(true);
        expect(await entries.count()).toBeLessThanOrEqual(100);
        await page.locator(".content").evaluate((element) => {
          element.scrollTop = 0;
        });
      }
      console.log("mounted dashboards for grid, list, grouped list, grouped grid:", counts);
      for (const count of counts) {
        expect.soft(count).toBeLessThanOrEqual(100);
      }
    });
  });

  it("opens a responsive gallery card without restarting its retained dashboard widgets", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 }, hasTouch: true },
      async ({ page }) => {
        await page.route("**/dashboard-gallery-widget.html", (route) =>
          route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: widgetMarkup,
          }),
        );
        const gateway = await installMockGateway(page, {
          sessionKey: selectedSessionKey,
          sessions: dashboardRows,
          featureMethods: [
            "board.get",
            "board.widget.appView",
            "chat.metadata",
            "chat.startup",
            "sessions.resolve",
          ],
          methodResponses: {
            "sessions.resolve": {
              cases: [responseCase(resolveMatch, selectedResolution)],
            },
            "board.get": {
              cases: boardSnapshots.map((snapshot) =>
                responseCase({ sessionKey: snapshot.sessionKey }, snapshot),
              ),
            },
            "board.widget.appView": {
              status: "ready",
              viewId: "release-tools-view",
              expiresAtMs: now + 60_000,
            },
            "chat.startup": {
              cases: [
                responseCase(resolveMatch, {
                  resolution: selectedResolution,
                  messages: [],
                  sessionInfo: dashboardRows[0],
                }),
              ],
            },
          },
        });

        await page.goto(suite.server.baseUrl);
        await openSidebarPages(page);
        await page.getByRole("link", { name: "Dashboards", exact: true }).click();
        await page.waitForURL(`${suite.server.baseUrl}dashboards`);
        const gallery = page.locator("openclaw-dashboards-page");
        const releaseCard = gallery.locator("[data-dashboard-session]", {
          hasText: "Release health",
        });
        await releaseCard.waitFor();
        expect(await gallery.locator("[data-dashboard-session]").count()).toBe(12);
        expect(
          await gallery
            .locator(".dashboard-card__author")
            .getByText("Mira", { exact: true })
            .count(),
        ).toBe(6);
        await waitForPreview(releaseCard);
        expect(await releaseCard.locator('[data-widget-name="release-tools"]').count()).toBe(0);
        expect(await gateway.getRequests("board.widget.appView")).toHaveLength(0);
        const capacityRequested = async () =>
          (await gateway.getRequests("board.get", { sessionKey: capacityKey })).length > 0;
        expect(await capacityRequested()).toBe(false);
        const capacityCard = gallery.locator(`[data-dashboard-session="${capacityKey}"]`);
        await capacityCard.scrollIntoViewIfNeeded();
        await expect.poll(capacityRequested).toBe(true);
        await waitForPreview(capacityCard);
        expect(await releaseCard.locator("a").getAttribute("href")).toBe(
          "/dashboard/main/release-health-1234567890abcdef1234567890abcdef",
        );

        await releaseCard.locator("a").click();
        await page.waitForURL(
          /\/dashboard\/main\/release-health-1234567890abcdef1234567890abcdef$/u,
        );
        const task = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
        await page.locator(".board-session-surface").waitFor();
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
        await expect.poll(() => task.locator(".chat-thread").isHidden()).toBe(true);
        const widget = page
          .locator('.board-session-surface iframe[title="Live Gateway Pulse"]')
          .contentFrame();
        const noteInput = widget.getByRole("textbox", { name: "Notes" });
        const widgetRows = widget.locator("li");
        const notes = "Release notes: café 雪 🦞";
        await noteInput.fill(notes);
        expect(await noteInput.inputValue()).toBe(notes);
        await clickBoardWidgetControl(page, widget.getByRole("button", { name: "Reverse rows" }));
        expect(await widgetRows.allTextContents()).toEqual(["🦞", "雪", "café"]);
        const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
        await openSidebarPages(page);
        await page.getByRole("link", { name: "Dashboards", exact: true }).click();
        await searchDashboards(gallery, "Release health");
        await releaseCard.locator("a").click();
        await page.waitForURL(
          /\/dashboard\/main\/release-health-1234567890abcdef1234567890abcdef(?:\?.*)?$/u,
        );
        await page.locator('a.nav-item[href="/dashboards"]:not([aria-current])').waitFor();
        await noteInput.waitFor();
        expect(await noteInput.inputValue()).toBe(notes);
        expect(await widgetRows.allTextContents()).toEqual(["🦞", "雪", "café"]);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
        // A cold route must resolve without the gallery's navigation handoff.
        await page.reload();
        await page.locator(".board-session-surface").waitFor();
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
        await expect.poll(() => task.locator(".chat-thread").isHidden()).toBe(true);

        await selectChatLayoutAction(page, "Restore split");
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
        await task.locator(".chat-thread").waitFor();
        await selectChatLayoutAction(page, "Minimize side panel");
        await page.locator(".board-session-surface").waitFor();
        await task.locator(".chat-thread").waitFor({ state: "hidden" });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${suite.server.baseUrl}dashboards`);
        await gallery.getByText("Release health", { exact: true }).waitFor();
        await expect
          .poll(() =>
            gallery.locator(".dashboards-grid").evaluate((element) => ({
              documentWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth,
              columns: getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean)
                .length,
            })),
          )
          .toEqual({ documentWidth: 390, viewportWidth: 390, columns: 1 });

        const cards = gallery.locator("[data-dashboard-session]");
        const filter = gallery.getByRole("button", { name: "Filter by author", exact: true });
        expect(await filter.getAttribute("class")).not.toContain("active");
        await filter.click();
        const popover = page.locator("#dashboards-author-filter");
        const riley = popover.getByRole("checkbox", { name: /Riley/ });
        const mira = popover.getByRole("checkbox", { name: /Mira/ });
        await riley.check();
        await expect.poll(() => cards.count()).toBe(6);
        await mira.check();
        await expect.poll(() => cards.count()).toBe(12);
        expect(await filter.getAttribute("class")).toContain("active");
        await popover.getByRole("button", { name: "Clear", exact: true }).click();
        await expect.poll(() => cards.count()).toBe(12);
        expect(await filter.getAttribute("class")).not.toContain("active");
        await page.keyboard.press("Escape");

        const display = gallery.getByRole("button", { name: "Display", exact: true });
        const displayMenu = page.locator("#dashboards-display");
        await display.click();
        await displayMenu.getByLabel("Ordering").selectOption("title");
        await expect.poll(() => cards.first().locator("h2").textContent()).toBe("Dashboard 1");
        await displayMenu.getByRole("button", { name: "List", exact: true }).click();
        await displayMenu.getByLabel("Grouping").selectOption("author");
        await expect.poll(() => gallery.locator(".dashboard-row").count()).toBe(12);
        await expect.poll(() => gallery.locator(".dashboards-group__heading").count()).toBe(2);
        await page.keyboard.press("Escape");
        await page.reload();
        await expect.poll(() => gallery.locator(".dashboard-row").count()).toBe(12);
        await expect.poll(() => gallery.locator(".dashboards-group__heading").count()).toBe(2);
        await expect.poll(() => cards.first().locator("h2").textContent()).toBe("Dashboard 1");
        await display.click();
        await displayMenu.getByRole("button", { name: "Grid", exact: true }).click();
        await displayMenu.getByLabel("Grouping").selectOption("none");
        await displayMenu.getByLabel("Ordering").selectOption("updated");
        await page.keyboard.press("Escape");

        // Native checkboxes remain reachable and toggle author selection with Space.
        await filter.click();
        await riley.focus();
        await page.keyboard.press("Space");
        await expect.poll(() => cards.count()).toBe(6);
        expect(await riley.evaluate((input) => input.matches(":focus"))).toBe(true);
        await page.keyboard.press("Space");
        await expect.poll(() => cards.count()).toBe(12);

        // An outside tap only closes the popover; the next one opens the card.
        const galleryUrl = page.url();
        const card = cards.nth(1);
        await card.locator("a").tap();
        await popover.waitFor({ state: "hidden" });
        expect(page.url()).toBe(galleryUrl);
        await card.locator("a").tap();
        await expect.poll(() => page.url()).not.toBe(galleryUrl);
      },
    );
  });
});
