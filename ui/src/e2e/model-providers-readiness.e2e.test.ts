import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { emptyUsage } from "./model-catalog-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Models provider inventory readiness" });
suite.define(() => {
  it("does not claim no configured providers after their inventory read fails", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 1000 },
        locale: "en-US",
        colorScheme: "light",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          models: [],
          featureMethods: defaultControlUiFeatureMethods.filter(
            (method) => method !== "acpx.agents.list",
          ),
          deferredMethods: ["models.authStatus"],
          methodResponses: {
            "config.get": sourceConfigSnapshot({}, "provider-readiness"),
            "models.list": { models: [], pendingProviders: [], providerOutcomes: [] },
            "models.authStatus": { ts: 1, providers: [] },
            ...emptyUsage(Date.now()),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        await gateway.waitForRequest("models.authStatus");
        const surface = page.locator("openclaw-model-providers-page");
        const empty = surface.getByText("No model providers configured", { exact: true });
        expect(await empty.count()).toBe(0);
        await gateway.rejectDeferred("models.authStatus", {
          code: "UNAVAILABLE",
          message: "Synthetic provider inventory unavailable",
        });
        const error = surface
          .getByRole("alert")
          .filter({ hasText: "Synthetic provider inventory unavailable" });
        await error.waitFor();
        const falseEmpty = await empty.count();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const section = surface.locator(".model-providers__provider-list");
          const frame = await takeControlUiScreenshotFrame(page, section, [error], {
            animations: "disabled",
            scrollTo: section,
          });
          await writeFile(path.join(suite.artifactDir, "inventory-read-error.png"), frame.png);
        }
        await surface.getByRole("button", { name: "Retry", exact: true }).click();
        await expect.poll(() => error.count()).toBe(0);
        await empty.waitFor();
        await gateway.setMethodResponse("models.authStatus", {
          ts: 2,
          providers: [{ provider: "openai", profiles: [], apiKey: { source: "config" } }],
          providerCapabilities: [
            { provider: "openai", apiKeySupported: true, quickApiKeySetup: true },
          ],
        });
        await surface.getByRole("button", { name: "Refresh", exact: true }).click();
        await surface.locator('[data-provider-id="openai"]').waitFor();
        expect(await empty.count()).toBe(0);
        expect(await gateway.getRequests("config.patch")).toHaveLength(0);
        expect(falseEmpty, "A failed provider read cannot establish an empty inventory").toBe(0);
      },
    );
  });
});
