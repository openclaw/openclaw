import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createBoardWidget } from "../lib/board/widget.test-support.ts";
import {
  ensureSidebarConversation,
  openSlot,
  toggleSidebarPanelExpanded,
} from "../pages/chat/sidebar-layout.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { board as createBoardSnapshot } from "./chat-layout-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectText, seedStorage } from "./sidebar-assertions.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session progress dashboard widget",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:progress-dashboard";
const dashboardFeatureMethods = [
  "board.get",
  "chat.metadata",
  "chat.startup",
  "progressCard.get",
  "sessions.list",
  "sessions.patch",
];
const widgetKinds = [{ pluginId: "session", kind: "session:progress", label: "Session progress" }];

function seedDashboard(page: Page, key: string, extra: Record<string, unknown> = {}) {
  return seedStorage(page, {
    [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
      boardSessionViews: { [key]: { activeTabId: "main" } },
      ...extra,
    }),
  });
}

function boardResponse(key: string) {
  return createBoardSnapshot(key, [
    createBoardWidget({
      name: "session-progress",
      title: "Session progress",
      contentKind: "plugin",
      pluginKind: "session:progress",
      sizeH: 5,
    }),
  ]);
}

suite.define(() => {
  it.each([
    { height: 844, name: "mobile", width: 390, routeKey: sessionKey },
    { height: 900, name: "bare-route", width: 1440, routeKey: "progress-dashboard" },
    { height: 900, name: "expanded-side", width: 1440, routeKey: sessionKey },
  ])("keeps unowned progress paused on $name", async (viewport) => {
    await suite.withPage({ locale: "en-US", viewport }, async ({ page }) => {
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        sessionKey,
        controlUiWidgetKinds: widgetKinds,
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(sessionKey),
          "progressCard.get": {
            card: {
              sessionKey,
              revision: 3,
              updatedAt: now - 5 * 60_000,
              markdown: "**Earlier task** remains available for reference.",
              steps: [
                { step: "Finish the earlier task", status: "completed" },
                { step: "Archive the earlier checklist", status: "in_progress" },
                { step: "Start unrelated work", status: "pending" },
              ],
            },
          },
          "sessions.list": chatSessionListResponse([
            {
              hasActiveRun: true,
              key: sessionKey,
              kind: "direct",
              label: "Later active run",
              startedAt: now - 60_000,
              status: "running",
              updatedAt: now,
            },
          ]),
        },
      });
      const expanded = viewport.name === "expanded-side";
      const dashboardLayout = expanded
        ? toggleSidebarPanelExpanded(
            openSlot(ensureSidebarConversation({ columns: [] }), "dashboard"),
            "dashboard",
          )
        : openSlot({ columns: [] }, "dashboard");
      const split = viewport.routeKey !== sessionKey || expanded;
      // Each split pane owns its presentation independently of the current route.
      await seedDashboard(
        page,
        sessionKey,
        split
          ? {
              sidebarSessionLayouts: { [viewport.routeKey]: dashboardLayout },
              chatSplitLayout: {
                activePaneId: "p1",
                columns: [sessionKey, viewport.routeKey].map((key, index) => ({
                  id: `c${index + 1}`,
                  panes: [{ id: `p${index + 1}`, sessionKey: key }],
                  paneWeights: [1],
                })),
                columnWeights: [0.5, 0.5],
              },
            }
          : {},
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const surface =
        viewport.routeKey === sessionKey && viewport.name !== "expanded-side"
          ? page
          : page.locator(".chat-split-view__column").nth(1);
      const card = surface.locator('[data-progress-card-placement="board"]');
      if (viewport.routeKey !== sessionKey) {
        await expect
          .poll(() =>
            surface
              .locator("openclaw-chat-pane")
              .evaluate((element) => (element as HTMLElement & { sessionKey: string }).sessionKey),
          )
          .toBe(viewport.routeKey);
        await gateway.waitForRequest("board.get", { match: { sessionKey: viewport.routeKey } });
        await surface.locator("openclaw-session-progress-widget").waitFor();
        await expect
          .poll(() =>
            surface
              .locator("openclaw-board-view")
              .evaluate((element) => (element as HTMLElement & { session: unknown }).session),
          )
          .toEqual({ sessionKey: viewport.routeKey, agentId: "main" });
      }
      await card.waitFor();
      expect(await card.locator("iframe").count()).toBe(0);
      await expectText(card, "Earlier task");
      await expectText(card, "Archive the earlier checklist");
      await expectText(card.locator(".session-progress-card__heading"), "1/3");
      await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

      expect(await card.locator(".session-run-spinner").count()).toBe(0);
      const paused = card.locator(".session-progress-card__step--paused");
      expect(await paused.count()).toBe(1);
      expect(await paused.getAttribute("aria-label")).toBe("Archive the earlier checklist, paused");

      const visibility = await card
        .locator(".session-progress-card__heading")
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const body = element.closest(".board-widget__body")!.getBoundingClientRect();
          return (
            bounds.top >= Math.max(0, body.top) &&
            bounds.bottom <= Math.min(window.innerHeight, body.bottom) &&
            bounds.left >= Math.max(0, body.left) &&
            bounds.right <= Math.min(window.innerWidth, body.right)
          );
        });
      expect(visibility).toBe(true);
      await page.waitForURL((url) => url.pathname.startsWith("/dashboard/"));
      await surface.locator("openclaw-board-view").waitFor({ state: "visible" });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);
      if (viewport.name === "expanded-side") {
        const mainChat = surface.locator('.sidebar-region__primary[data-region="main"]');
        await mainChat.waitFor({ state: "hidden" });
        await selectChatLayoutAction(surface, "Restore split");
        await mainChat.waitFor({ state: "visible" });
        await surface.locator('[data-panel-slot="dashboard"]').waitFor({ state: "visible" });
      }
    });
  });
});
