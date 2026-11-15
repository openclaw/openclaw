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
const suite = createControlUiE2eSuite({ name: "Installed agent model readiness" });
suite.define(() => {
  it("does not ask for sign-in before installed-agent model discovery answers", async () => {
    await suite.withPage(
      {
        viewport: { width: 1280, height: 1100 },
        locale: "en-US",
        colorScheme: "dark",
        serviceWorkers: "block",
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          models: [],
          heldMethods: ["models.list"],
          featureMethods: [...defaultControlUiFeatureMethods, "acpx.agents.list"],
          methodResponses: {
            "config.get": sourceConfigSnapshot(
              { plugins: { entries: { acpx: { config: { nativeAgents: { opencode: true } } } } } },
              "installed-readiness",
            ),
            "models.authStatus": { ts: 1, providers: [] },
            "models.list": { models: [], pendingProviders: [], providerOutcomes: [] },
            "acpx.agents.list": {
              agents: [
                {
                  id: "opencode",
                  name: "OpenCode",
                  runtimeId: "acp-opencode",
                  installation: "installed",
                  enabled: true,
                },
              ],
            },
            ...emptyUsage(Date.now()),
          },
        });
        await page.goto(suite.server.baseUrl + "settings/model-providers");
        await gateway.waitForRequest("models.list");
        const row = page.locator('[data-installed-agent="opencode"]');
        await row.waitFor();
        const before = await row.textContent();
        expect(before).toContain("Installed");
        expect(before).not.toContain("Discovering models");
        expect(
          await row.getByRole("switch", { name: "Use OpenCode", exact: true }).isEnabled(),
        ).toBe(true);
        const advice = row.locator(".settings-row__desc").filter({ hasText: "check its sign-in" });
        const premature = await advice.count();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            row,
            [row.getByText("OpenCode", { exact: true })],
            { animations: "disabled", scrollTo: row },
          );
          await writeFile(path.join(suite.artifactDir, "catalog-pending.png"), frame.png);
        }
        await gateway.resolveDeferred("models.list", {
          models: [],
          pendingProviders: [],
          providerOutcomes: [],
        });
        await advice.waitFor();
        const ready = {
          models: [{ provider: "acp-opencode", id: "cedar", name: "Cedar", available: true }],
          pendingProviders: [],
          providerOutcomes: [{ provider: "acp-opencode", status: "ready" }],
        };
        await gateway.setMethodResponse("models.list", ready);
        await page.locator(".model-providers__installed-agents").getByRole("button").click();
        await expect.poll(() => row.textContent()).toContain("Models available");
        expect(await advice.count()).toBe(0);
        expect(await gateway.getRequests("openclaw.setup.runtime.start")).toHaveLength(0);
        expect(premature, before ?? "Initial row must not demand sign-in before discovery").toBe(0);
      },
    );
  });
});
