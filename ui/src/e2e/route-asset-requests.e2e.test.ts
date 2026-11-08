import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Page } from "playwright";
import { expect, inject, it } from "vitest";
import { startControlUiBenchGatewayServer } from "../../../scripts/lib/control-ui-bench-gateway-server.ts";
// Scenario probes use the action-timing owner's optional Window hook.
import "../../../scripts/lib/control-ui-engine-action-timing.ts";
import { createEnginePageScenarios } from "../../../scripts/lib/control-ui-engine-page-scenarios.ts";
import { frames } from "../../../scripts/lib/control-ui-interaction-navigation.ts";
import {
  createScenarioFixture,
  installInteractionNavigationPreloadObserver,
  settleInteractionNavigationPreloads,
} from "../../../scripts/lib/control-ui-interaction-scenarios.ts";
import {
  finishControlUiPageObserver,
  installControlUiPageObserver,
  readControlUiPageObserver,
  resetControlUiPageObserver,
} from "../../../scripts/lib/control-ui-page-observer.ts";
import { waitForControlUiInitialRoster } from "../test-helpers/control-ui-e2e-readiness.ts";
import { installNativePluginMockGateway } from "../test-helpers/control-ui-plugin-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../test-helpers/control-ui-sidebar-list-fixture.ts";
import { controlUiE2eBuiltModuleRequest } from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const requestLatencyMs = 100;
const suite = createControlUiE2eSuite({
  name: "First-visit route asset requests",
  startServer: async () => {
    const root = inject("controlUiE2eBuildRoot");
    if (!root) {
      throw new Error("Route request proof requires the shared production UI build");
    }
    const server = await startControlUiBenchGatewayServer(root, 0, requestLatencyMs);
    server.setTerminalEnabled(true);
    return server;
  },
});
// First visits must not regain the removed request wave or eager Markdown reader.
const readyWindowRequestLimits = {
  skills: 28,
  "skill-settings": 28,
  plugins: 56,
  "plugin-settings": 59,
};
type Route = keyof typeof readyWindowRequestLimits;

async function visit(page: Page, route: Route) {
  const scenario = createEnginePageScenarios(requestLatencyMs).find(
    ({ id }) => id === `page-${route}-visit`,
  );
  if (!scenario) {
    throw new Error(`Missing first-visit scenario for ${route}`);
  }
  // The shared production E2E server owns build identity, as for ordinary mock callers.
  const {
    serverBuildId: _serverBuildId,
    serverVersion: _serverVersion,
    ...fixture
  } = createScenarioFixture("", "", scenario);
  const sessions = createTeamScaleSidebarListOwner({
    rows: fixture.sessions,
    viewerProfileId: "interaction-viewer",
    now: 1_800_000_000_000,
    defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
    owners: [],
  });
  const gateway = await installNativePluginMockGateway(
    page,
    { ...fixture, awaitInitialRoster: false },
    {
      nativeAssetLatencyMs: requestLatencyMs,
      afterInitScript: scenario.initScript,
      requestHandlers: {
        "sessions.list": (params) => {
          if (!isRecord(params)) {
            throw new Error("Expected sessions.list parameters");
          }
          return sessions.list(params).result;
        },
      },
    },
  );
  await page.addInitScript(installInteractionNavigationPreloadObserver);
  await installControlUiPageObserver(page);
  await page.goto(new URL(scenario.route, suite.server.baseUrl).href);
  await waitForControlUiInitialRoster(page);
  await scenario.prepare(page, gateway);
  await settleInteractionNavigationPreloads(page);
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await frames(page);
  await resetControlUiPageObserver(page);
  const timing = await scenario.run(page, gateway);
  if (
    !timing ||
    typeof timing.visitStartedAtMs !== "number" ||
    typeof timing.visitReadyAtMs !== "number"
  ) {
    throw new Error(`Missing browser-local readiness timing for ${route}`);
  }
  await finishControlUiPageObserver(page);
  return readControlUiPageObserver(
    page,
    timing.visitStartedAtMs,
    timing.visitReadyAtMs,
    timing.visitStartedAtMs,
  );
}

suite.define(() => {
  it.each(["skills", "skill-settings", "plugins", "plugin-settings"] as const)(
    "bounds %s ready-window asset requests at 100 ms from a settled New Session",
    (route) =>
      suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        const reader = controlUiE2eBuiltModuleRequest(
          "ui/src/pages/skills/skill-reader-dialog.tsx",
        );
        let readerRequests = 0;
        page.on("request", (request) => {
          if (reader.test(request.url())) {
            readerRequests += 1;
          }
        });

        const observation = await visit(page, route);
        const readyAssets = observation.assets.filter((asset) => asset.completedByReady);
        expect(readyAssets.length).toBeGreaterThan(0);
        expect(
          readyAssets.length,
          readyAssets.map((asset) => asset.name).join("\n"),
        ).toBeLessThanOrEqual(readyWindowRequestLimits[route]);

        if (route === "skills") {
          expect(readerRequests).toBe(0);
          const held = await holdModuleResponse(page, reader);
          try {
            await page
              .getByRole("button", { name: "Open Data skill 0000 details", exact: true })
              .click();
            await held.request;
            expect(held.requests()).toBeGreaterThan(0);
            expect(await page.locator(".skill-reader-dialog").count()).toBe(0);
            held.release();
            const dialog = page.locator("openclaw-modal-dialog .skill-reader-dialog");
            await dialog.waitFor({ state: "visible" });
            expect(await dialog.locator(".oc-dialog__title").textContent()).toBe("Data skill 0000");
          } finally {
            held.release();
          }
        }
      }),
  );
});
