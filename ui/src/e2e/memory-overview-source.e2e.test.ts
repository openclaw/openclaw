import { expect } from "playwright/test";
import { it } from "vitest";
import {
  installMockGateway,
  startControlUiE2eServer,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const sourceSuite = createControlUiE2eSuite({
  name: "Source Memory overview",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});
sourceSuite.define(() => {
  it("loads the actual Memory route from a development server without runtime plugin activation", async () => {
    await sourceSuite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "plugins.controlUi.list": { plugins: [], diagnostics: [], revision: "empty" },
          "doctor.memory.status": {
            agentId: "main",
            provider: "local",
            embedding: { ok: false, checked: false },
          },
        },
      });
      await page.goto(`${sourceSuite.server.baseUrl}settings/memory`);
      await waitForControlUiRoute(page, { routeId: "memory" });
      const overview = page.locator(".memory-overview");
      await expect(overview.getByRole("heading", { name: "Memory is awake" })).toBeVisible();
      await expect(overview.locator(".settings-row", { hasText: "Embeddings" })).toHaveCSS(
        "border-top-width",
        "1px",
      );
      await expect(page.locator('link[href*="/assets/plugins/memory-core/"]')).toHaveCount(1);
      expect(await gateway.getRequests("doctor.memory.status")).toHaveLength(1);
      expect(await gateway.getRequests("plugins.controlUi.report")).toHaveLength(0);
      expect(errors).toEqual([]);
    });
  });
});
