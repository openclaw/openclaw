import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

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

function boardResponse(key: string) {
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
      },
    ],
  };
}

function sessionListResponse(
  key: string,
  label: string,
  state: { hasActiveRun: boolean; startedAt?: number; status?: string; updatedAt: number },
) {
  return {
    count: 1,
    defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
    path: "",
    sessions: [{ key, kind: "direct", label, status: "running", ...state }],
    ts: Date.now(),
  };
}

let proofDir: string;
beforeEach(() => {
  proofDir = createControlUiE2eArtifactDir("session-progress-widget");
});

suite.define(() => {
  it("renders the live session progress card through an advertised dashboard kind", async () => {
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(sessionKey),
          "progressCard.get": {
            card: {
              sessionKey,
              revision: 3,
              updatedAt: 3,
              markdown: "**Dashboard tile** follows the live session card.",
              steps: [
                { step: "Inspect dashboard seams", status: "completed" },
                { step: "Render the progress tile", status: "in_progress" },
                { step: "Capture browser proof", status: "pending" },
              ],
            },
          },
          "sessions.list": sessionListResponse(sessionKey, "Progress dashboard", {
            hasActiveRun: true,
            startedAt: 2,
            updatedAt: 3,
          }),
        },
      });
      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: sessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      expect(await card.locator("iframe").count()).toBe(0);
      await expect.poll(() => card.textContent()).toContain("Dashboard tile");
      await expect.poll(() => card.textContent()).toContain("Inspect dashboard seams");
      await expect.poll(() => card.textContent()).toContain("Render the progress tile");
      await expect.poll(() => card.textContent()).toContain("Capture browser proof");
      await expect
        .poll(() => card.locator(".session-progress-card__heading").textContent())
        .toContain("1/3");
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(1);
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(0);
      await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget.png"),
      });
    });
  });

  it("pauses a dashboard card when the session has no active run", async () => {
    const inactiveSessionKey = "agent:main:progress-dashboard-inactive";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: inactiveSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(inactiveSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: inactiveSessionKey,
              revision: 1,
              updatedAt: 3,
              markdown: "**Paused dashboard tile** is durable work.",
              steps: [{ step: "Resume the dashboard task", status: "in_progress" }],
            },
          },
          "sessions.list": sessionListResponse(inactiveSessionKey, "Inactive progress dashboard", {
            hasActiveRun: false,
            startedAt: 3,
            updatedAt: 3,
          }),
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: inactiveSessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, inactiveSessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-inactive.png"),
      });
    });
  });

  it("pauses a dashboard card that predates the current active run", async () => {
    const staleSessionKey = "agent:main:progress-dashboard-stale";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: staleSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(staleSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: staleSessionKey,
              revision: 1,
              updatedAt: 3,
              markdown: "**Stale dashboard tile** belongs to an earlier run.",
              steps: [{ step: "Show the current run", status: "in_progress" }],
            },
          },
          "sessions.list": sessionListResponse(staleSessionKey, "Stale progress dashboard", {
            hasActiveRun: true,
            startedAt: 4,
            updatedAt: 4,
          }),
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: staleSessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, staleSessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.textContent()).toContain("Stale dashboard tile");
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-stale.png"),
      });
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
    });
  });

  it("uses the dashboard roster when the target is absent from the primary roster", async () => {
    const splitRosterSessionKey = "agent:main:progress:dashboard:split-roster";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: splitRosterSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(splitRosterSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: splitRosterSessionKey,
              revision: 1,
              updatedAt: 3,
              markdown: "**Split roster dashboard tile** follows its target session.",
              steps: [{ step: "Read the dashboard roster", status: "in_progress" }],
            },
          },
          "sessions.list": {
            cases: [
              {
                match: { hasBoard: true },
                response: sessionListResponse(splitRosterSessionKey, "Split roster dashboard", {
                  hasActiveRun: false,
                  startedAt: 2,
                  updatedAt: 3,
                }),
              },
              {
                match: {},
                response: sessionListResponse(
                  "agent:main:primary-roster-only",
                  "Primary roster only",
                  { hasActiveRun: false, startedAt: 1, updatedAt: 1 },
                ),
              },
            ],
          },
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: splitRosterSessionKey, storage: storageKey },
      );

      await page.goto(
        controlUiSessionUrl(suite.server.baseUrl, splitRosterSessionKey, "dashboard"),
      );
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.textContent()).toContain("Split roster dashboard tile");
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-split-roster.png"),
      });
    });
  });

  it("pauses a dashboard card while the successor run is queued", async () => {
    const queuedSessionKey = "agent:main:progress-dashboard-queued";
    await suite.withPage(englishDesktopPageOptions, async ({ page }) => {
      await installMockGateway(page, {
        sessionKey: queuedSessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: dashboardFeatureMethods,
        methodResponses: {
          "board.get": boardResponse(queuedSessionKey),
          "progressCard.get": {
            card: {
              sessionKey: queuedSessionKey,
              revision: 1,
              updatedAt: 3,
              markdown: "**Queued dashboard tile** belongs to an earlier run.",
              steps: [{ step: "Wait for the queued run", status: "in_progress" }],
            },
          },
          "sessions.list": sessionListResponse(queuedSessionKey, "Queued progress dashboard", {
            hasActiveRun: true,
            status: "queued",
            updatedAt: 4,
          }),
        },
      });

      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: queuedSessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, queuedSessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      await expect.poll(() => card.textContent()).toContain("Queued dashboard tile");
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget-queued.png"),
      });
      await expect.poll(() => card.locator(".session-progress-card__step--paused").count()).toBe(1);
      await expect.poll(() => card.locator(".session-run-spinner").count()).toBe(0);
    });
  });
});
