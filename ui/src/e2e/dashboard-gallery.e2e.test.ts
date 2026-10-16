import path from "node:path";
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
const dashboardRows = (
  [
    [selectedSessionKey, selectedResolution.displayName, "mira", "Mira", 3_000, "running"],
    ["agent:main:dashboard:model-spend", "Model spend", "peter", "Peter", 8_000, "done"],
    ["agent:main:dashboard:support-radar", "Support radar", "mira", "Mira", 18_000, "done"],
    ["agent:main:dashboard:ci-signal", "CI signal", "peter", "Peter", 42_000, "done"],
    ["agent:main:dashboard:community-pulse", "Community pulse", "mira", "Mira", 75_000, "done"],
    ["agent:main:dashboard:gateway-fleet", "Gateway fleet", "peter", "Peter", 130_000, "done"],
    ["agent:main:dashboard:deployments", "Deployments", "mira", "Mira", 160_000, "done"],
    ["agent:main:dashboard:incidents", "Incidents", "peter", "Peter", 190_000, "done"],
    ["agent:main:dashboard:traffic", "Traffic", "mira", "Mira", 220_000, "done"],
    ["agent:main:dashboard:queues", "Queues", "peter", "Peter", 250_000, "done"],
    ["agent:main:dashboard:workers", "Workers", "mira", "Mira", 280_000, "done"],
    ["agent:main:dashboard:capacity", "Capacity", "peter", "Peter", 310_000, "done"],
  ] as const
).map(([key, displayName, actorId, actorLabel, age, status]) => ({
  key,
  kind: "direct",
  boardFace: "dashboard",
  boardPresentation: "expanded",
  displayName,
  updatedAt: now - age,
  status,
  createdActor: { type: "human", id: actorId, label: actorLabel },
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
suite.define(() => {
  it("opens a responsive gallery card without restarting its retained dashboard widgets", async () => {
    const proofDir = process.env.OPENCLAW_UI_E2E_RECORD === "1" ? suite.artifactDir : null;
    await suite.withPage(
      { colorScheme: "dark", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const screenshot = async (name: string) => {
          if (proofDir) {
            await page.screenshot({ path: path.join(proofDir, `${name}.png`) });
          }
        };
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
        const previewFrame = releaseCard.locator('iframe[title="Live Gateway Pulse"]');
        await previewFrame.waitFor();
        await previewFrame
          .contentFrame()
          .getByText("All systems nominal", { exact: true })
          .waitFor();
        expect(await releaseCard.locator('[data-widget-name="release-tools"]').count()).toBe(0);
        expect(await gateway.getRequests("board.widget.appView")).toHaveLength(0);
        const capacityKey = "agent:main:dashboard:capacity";
        const capacityRequested = async () =>
          (await gateway.getRequests("board.get", { sessionKey: capacityKey })).length > 0;
        expect(await capacityRequested()).toBe(false);
        const capacityCard = gallery.locator(`[data-dashboard-session="${capacityKey}"]`);
        await capacityCard.scrollIntoViewIfNeeded();
        await expect.poll(capacityRequested).toBe(true);
        const capacityFrame = capacityCard.locator('iframe[title="Live Gateway Pulse"]');
        await capacityFrame.waitFor();
        await capacityFrame
          .contentFrame()
          .getByText("All systems nominal", { exact: true })
          .waitFor();
        expect(await releaseCard.locator("a").getAttribute("href")).toBe(
          "/dashboard/main/release-health-1234567890abcdef1234567890abcdef",
        );
        await screenshot("01-gallery");

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
        await screenshot("02-gallery-return");
        expect(await noteInput.inputValue()).toBe(notes);
        expect(await widgetRows.allTextContents()).toEqual(["🦞", "雪", "café"]);
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStartedAt);
        // A cold route must resolve without the gallery's navigation handoff.
        await page.reload();
        await page.locator(".board-session-surface").waitFor();
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
        await expect.poll(() => task.locator(".chat-thread").isHidden()).toBe(true);
        await screenshot("02-expanded-dashboard");

        await selectChatLayoutAction(page, "Restore split");
        await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
        await task.locator(".chat-thread").waitFor();
        await screenshot("03-split-dashboard");
        await selectChatLayoutAction(page, "Minimize side panel");
        await page.locator(".board-session-surface").waitFor();
        await task.locator(".chat-thread").waitFor({ state: "hidden" });
        await screenshot("04-dashboard-only");

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${suite.server.baseUrl}dashboards`);
        await gallery.getByText("Release health", { exact: true }).waitFor();
        await expect
          .poll(() =>
            page.evaluate(() => ({
              documentWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth,
            })),
          )
          .toEqual({ documentWidth: 390, viewportWidth: 390 });
        expect(
          await gallery
            .locator(".dashboards-grid")
            .evaluate(
              (element) =>
                getComputedStyle(element).gridTemplateColumns.split(" ").filter(Boolean).length,
            ),
        ).toBe(1);
        await screenshot("05-gallery-mobile");
      },
    );
  });
});
