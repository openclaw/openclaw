import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  ensureSidebarConversation,
  openSlot,
  toggleSidebarPanelExpanded,
} from "../pages/chat/sidebar-layout.ts";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { expectText, expectCount, seedStorage } from "./sidebar-assertions.test-support.ts";

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
const englishDesktopPageOptions = {
  locale: "en-US",
  viewport: { height: 900, width: 1280 },
};
const widgetKinds = [{ pluginId: "session", kind: "session:progress", label: "Session progress" }];

async function openDashboard(page: Page, dashboardKey: string) {
  await seedDashboard(page, dashboardKey);
  await page.goto(controlUiSessionUrl(suite.server.baseUrl, dashboardKey, "dashboard"));
  const card = page.locator('[data-progress-card-placement="board"]');
  await card.waitFor();
  return card;
}

function seedDashboard(page: Page, key: string, extra: Record<string, unknown> = {}) {
  return seedStorage(page, {
    [controlUiBundledSettingsStorageKey(suite.server.baseUrl)]: JSON.stringify({
      boardSessionViews: { [key]: { activeTabId: "main" } },
      ...extra,
    }),
  });
}

function progressResponse(key: string, updatedAt: number, markdown: string, step: string) {
  const steps = [{ step, status: "in_progress" }];
  return {
    card: { sessionKey: key, revision: 1, updatedAt, markdown, steps },
  };
}

function boardResponse(key: string, widgetOverrides?: Record<string, unknown>) {
  return {
    sessionKey: key,
    revision: 1,
    tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
    widgets: [
      {
        name: "session-progress",
        tabId: "main",
        title: "Session progress",
        contentKind: "plugin",
        pluginKind: "session:progress",
        sizeW: 6,
        sizeH: 5,
        position: 0,
        grantState: "none",
        revision: 1,
        ...widgetOverrides,
      },
    ],
  };
}

function sessionListResponse(
  key: string,
  label: string,
  state: {
    endedAt?: number;
    hasActiveRun: boolean;
    startedAt?: number;
    status?: string;
    updatedAt: number;
  },
) {
  return chatSessionListResponse([{ key, kind: "direct", label, status: "running", ...state }]);
}

suite.define(() => {
  it.each([
    { height: 844, name: "mobile", width: 390, routeKey: sessionKey },
    { height: 900, name: "bare-route", width: 1440, routeKey: "progress-dashboard" },
    { height: 900, name: "expanded-side", width: 1440, routeKey: sessionKey },
    { height: 900, name: "inactive", width: 1440, routeKey: sessionKey },
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
              updatedAt: viewport.name === "inactive" ? now : now - 5 * 60_000,
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
              hasActiveRun: viewport.name !== "inactive",
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

      const progressReads = await gateway.getRequests("progressCard.get");
      await gateway.deferNext("progressCard.get");
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 4 });
      await gateway.waitForRequest("progressCard.get", { after: progressReads.length });
      await gateway.rejectDeferred("progressCard.get", {
        code: "UNAVAILABLE",
        message: "Refresh temporarily unavailable",
      });
      const error = surface.locator('[data-test-id="session-progress-error"]');
      await error.waitFor();
      await expectCount(card, 1);
      expect(await card.textContent()).toContain("Earlier task");
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
      expect(await error.getByRole("button", { name: "Retry", exact: true }).count()).toBe(1);

      await gateway.setMethodResponse("progressCard.get", {
        card: {
          sessionKey,
          revision: 4,
          updatedAt: now,
          markdown: "**Refreshed task** is available again.",
          steps: [{ step: "Recovered progress", status: "completed" }],
        },
      });
      await error.getByRole("button", { name: "Retry", exact: true }).click();
      await expectText(card, "Refreshed task");
      await expectCount(error, 0);
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

      const readsBeforeDenial = await gateway.getRequests("progressCard.get");
      await gateway.deferNext("progressCard.get");
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 5 });
      await gateway.waitForRequest("progressCard.get", { after: readsBeforeDenial.length });
      await gateway.rejectDeferred("progressCard.get", {
        code: "INVALID_REQUEST",
        message: "Participation required",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      });
      await expectText(
        error,
        "Select a session you can access or change sharing for this session.",
      );
      await expectCount(card, 0);
      expect(await error.getByRole("button").count()).toBe(0);
    });
  });

  it("keeps target liveness when the selected agent scope changes", async () => {
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      const now = Date.now();
      const mainSessions = sessionListResponse(sessionKey, "Main progress dashboard", {
        hasActiveRun: true,
        startedAt: now - 30_000,
        updatedAt: now,
      });
      const gateway = await installMockGateway(page, {
        sessionKey,
        heldMethods: ["sessions.describe"],
        // Describe and startup publish full snapshots of the same running session.
        sessions: mainSessions.sessions,
        controlUiWidgetKinds: widgetKinds,
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(sessionKey),
          "progressCard.get": progressResponse(
            sessionKey,
            now - 10_000,
            "**Scope-transition dashboard tile** follows the dashboard roster.",
            "Show the selected scope",
          ),
          "sessions.list": {
            cases: [
              {
                match: { agentId: "main" },
                response: mainSessions,
              },
              {
                match: { agentId: "writer" },
                response: sessionListResponse(sessionKey, "Writer progress dashboard", {
                  endedAt: now - 1_000,
                  hasActiveRun: false,
                  startedAt: now - 5_000,
                  status: "done",
                  updatedAt: now - 30_000,
                }),
              },
            ],
          },
        },
      });

      const card = await openDashboard(page, sessionKey);
      await expectCount(card.locator(".session-run-spinner"), 1);
      await expectCount(card.locator(".session-progress-card__step--paused"), 0);

      await evaluateControlUiContext(page, (context) => {
        context.agentSelection.setScope("writer");
      });
      await gateway.waitForRequest("sessions.describe", { match: { key: sessionKey } });
      // Reconcile the descriptor after the running roster and scope transition.
      await gateway.resolveDeferred("sessions.describe");
      // The target roster stays archive-inclusive and independent of the page filter.
      const hasTargetRoster = async (agentId: string) =>
        (await gateway.getRequests("sessions.list")).some(({ params }) => {
          const query = params as { agentId?: string; archived?: string; hasBoard?: boolean };
          return (
            query.agentId === agentId && query.archived === "all" && query.hasBoard === undefined
          );
        });
      await expect.poll(() => hasTargetRoster("main")).toBe(true);
      await expect.poll(() => hasTargetRoster("writer")).toBe(false);
      await expectCount(card.locator(".session-progress-card__step--paused"), 0);
      await expectCount(card.locator(".session-run-spinner"), 1);
    });
  });

  it.each([true, false])("shows target liveness (board-less: %s)", async (boardless) => {
    const title = boardless ? "Board-less target tile" : "Queued dashboard tile";
    const step = boardless ? "Run without a dashboard" : "Wait for the queued run";
    const ownerKey = boardless
      ? "agent:main:progress-board-owner"
      : "agent:main:progress-dashboard-queued";
    const targetKey = boardless ? "agent:main:progress-boardless-target" : ownerKey;
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      const now = Date.now();
      const targetRoster = sessionListResponse(targetKey, title, {
        hasActiveRun: true,
        status: boardless ? "running" : "queued",
        updatedAt: boardless ? now : 4,
        ...(boardless ? { startedAt: now - 30_000 } : {}),
      });
      const ownerRoster = sessionListResponse(ownerKey, "Progress board owner", {
        hasActiveRun: false,
        startedAt: 2,
        updatedAt: 3,
      });
      if (boardless) {
        targetRoster.sessions.unshift({ ...ownerRoster.sessions[0]!, status: "done", endedAt: 3 });
        targetRoster.count = 2;
      }
      await installMockGateway(page, {
        sessionKey: ownerKey,
        ...(boardless ? { sessions: targetRoster.sessions } : {}),
        controlUiWidgetKinds: widgetKinds,
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(
            ownerKey,
            boardless ? { props: { sessionKey: targetKey } } : {},
          ),
          "progressCard.get": progressResponse(
            targetKey,
            boardless ? now : 3,
            `**${title}**`,
            step,
          ),
          // A board-filtered roster omits the board-less target; its own roster must keep it live.
          "sessions.list": boardless
            ? {
                cases: [
                  { match: { hasBoard: true }, response: ownerRoster },
                  { match: {}, response: targetRoster },
                ],
              }
            : targetRoster,
        },
      });
      const card = await openDashboard(page, ownerKey);
      await expectText(card, title);
      await expectCount(card.locator(".session-run-spinner"), Number(boardless));
      await expectCount(card.locator(".session-progress-card__step--paused"), Number(!boardless));
    });
  });
});
