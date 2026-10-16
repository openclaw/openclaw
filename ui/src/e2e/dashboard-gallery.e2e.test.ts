import type { Locator } from "playwright";
import { expect, it } from "vitest";
import type { SessionsResolveResult } from "../../../packages/gateway-protocol/src/index.js";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { clickBoardWidgetControl } from "../test-helpers/control-ui-e2e-widget.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

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
    id: index % 2 ? "peter" : "mira",
    label: index % 2 ? "Peter" : "Mira",
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
suite.define(() => {
  it("opens a responsive gallery card without restarting its retained dashboard widgets", async () => {
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
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
        expect(await gallery.getByText("By Mira", { exact: true }).count()).toBe(6);
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
        await gallery.getByRole("searchbox").fill("Release health");
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
      },
    );
  });
});
