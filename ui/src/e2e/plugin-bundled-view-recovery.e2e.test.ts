import { expect, it } from "vitest";
import { createDeferredCore } from "../../../src/shared/deferred.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  controlUiE2eBuiltModuleRequest,
  failControlUiModuleForDocuments,
} from "./control-ui-built-module.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { openSidebarPages } from "./sidebar-customization.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI bundled plugin lazy-view recovery",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

suite.define(() => {
  it("stops automatic reloads after one failed recovery and keeps manual Reload", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
        methodResponses: {
          "logbook.days": { days: [] },
          "logbook.status": {
            analysisRunning: false,
            captureEnabled: true,
            captureIntervalSeconds: 30,
            capturePaused: false,
            pendingFrames: 0,
            timeZone: "UTC",
            today: "2026-08-12",
            visionModelSource: "missing",
          },
          "logbook.timeline": {
            cards: [],
            day: "2026-08-12",
            stats: { apps: [], categories: [], distractionMs: 0, trackedMs: 0 },
          },
        },
      });

      const response = await page.goto(`${suite.server.baseUrl}plugin?plugin=missing&id=missing`);
      expect(response?.status()).toBe(200);
      await page.getByText("Plugin panel unavailable").waitFor();
      const documentReachable = createDeferredCore();
      let documentProbes = 0;
      await page.route(new URL("index.html", suite.server.baseUrl).href, async (route) => {
        if (route.request().method() !== "HEAD") {
          await route.continue();
          return;
        }
        documentProbes += 1;
        await documentReachable.promise;
        await route.fulfill({ status: 200 });
      });
      const failure = await failControlUiModuleForDocuments(
        page,
        controlUiE2eBuiltModuleRequest("ui/src/pages/plugin/logbook-view.tsx"),
        2,
      );
      const pages = await openSidebarPages(page);
      await pages.getByRole("link", { name: "Logbook", exact: true }).click();
      await expect.poll(failure.documentCount).toBe(1);

      const alert = page.getByRole("alert");
      await alert.waitFor();
      expect(await alert.textContent()).toContain("This view could not load");
      expect(await alert.textContent()).not.toContain("updated in the background");
      expect(await alert.textContent()).toContain("Failed to fetch dynamically imported module");
      await alert.getByRole("button", { name: "Reload" }).waitFor();

      let documentRequestCount = 0;
      page.on("request", (request) => {
        if (request.resourceType() === "document") {
          documentRequestCount += 1;
        }
      });
      documentReachable.resolve();

      await expect.poll(failure.documentCount).toBe(2);
      await alert.waitFor();
      expect([documentProbes, await alert.count(), documentRequestCount]).toEqual([1, 1, 1]);

      await alert.getByRole("button", { name: "Reload" }).click();
      await page.locator(".logbook").waitFor();
      expect(await alert.count()).toBe(0);
      expect(failure.documentCount()).toBe(3);
      expect(documentRequestCount).toBe(2);
      expect(documentProbes).toBe(2);
      await gateway.waitForRequest("logbook.status");
      expect(new URL(page.url()).pathname).toBe("/plugin");
    });
  });
});
