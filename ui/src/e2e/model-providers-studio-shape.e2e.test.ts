// Control UI E2E proves the Models page on studio-shaped data: plan windows, row order
// and the hand-off to the Usage page, which owns local session usage.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway, waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import studio from "./model-providers-studio-shape.fixture.json" with { type: "json" };
import { expandProvider } from "./model-providers.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Model providers studio-shaped data mocked Gateway E2E",
  startServerBeforeBrowser: true,
});
const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

suite.define(() => {
  it("shows plan headroom per provider and leaves local usage to the Usage page", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1_280, height: 1_000 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": { config: {}, hash: "studio-shape" },
            "models.authStatus": { ...studio.authStatus, ts: Date.now() },
            "models.list": studio.modelsList,
            "usage.status": { ...studio.usageStatus, updatedAt: Date.now() },
          },
        });
        await page.goto(`${suite.server.baseUrl}settings/model-providers`);
        const copilotRow = page.locator('li.provider-row[data-provider-id="github-copilot"]');
        await copilotRow.locator(".provider-usage__chip", { hasText: "Premium" }).waitFor();

        // An exhausted plan window reads as no headroom, beside the name and in the open row.
        expect(
          await copilotRow
            .locator(".provider-usage__chip", { hasText: "Premium" })
            .locator(".provider-usage__chip-value")
            .textContent(),
        ).toBe("0% left");
        const copilot = await expandProvider(page, "github-copilot");
        const premium = copilot.locator(".provider-usage__window", { hasText: "Premium" });
        expect(await premium.getByRole("meter").getAttribute("aria-valuenow")).toBe("0");
        expect(await premium.locator(".provider-usage__window-value").textContent()).toBe(
          "0% left",
        );
        // A used-up window names itself above the tiles.
        expect(await copilot.locator(".provider-usage__alert").textContent()).toContain(
          "Premium is used up",
        );
        // Copilot reports no reset time, so the row claims none.
        expect(await premium.locator(".provider-usage__reset").count()).toBe(0);
        expect(await page.locator('.provider-row[data-provider-id="xai"]').textContent()).toContain(
          "Prepaid balance",
        );
        // Usable providers lead, alphabetical. Anthropic has ready catalog models
        // without a credential OpenClaw holds.
        expect(
          await page
            .locator(".provider-list:not(.provider-list--quiet) > .provider-row")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-provider-id"))),
        ).toEqual(["anthropic", "github-copilot", "openai", "xai"]);
        expect(await page.locator(".provider-list--quiet").count()).toBe(0);
        expect(
          await page.locator('[data-provider-id="anthropic"] .provider-row__meta').textContent(),
        ).toContain("Credentials managed outside OpenClaw");
        expect(
          await page
            .locator('[data-provider-id="github-copilot"] .model-providers__profile-copy strong')
            .textContent(),
        ).toBe("Access token");

        if (recordVisuals) {
          const dir = path.join(suite.artifactDir, "model-providers-studio-shape");
          await mkdir(dir, { recursive: true });
          for (const scheme of ["dark", "light"] as const) {
            await page.emulateMedia({ colorScheme: scheme });
            await page
              .locator(".settings-section", { has: page.locator(".provider-list") })
              .screenshot({ path: path.join(dir, `providers-${scheme}.png`) });
            await copilotRow.screenshot({ path: path.join(dir, `provider-row-${scheme}.png`) });
          }
          await page.emulateMedia({ colorScheme: "dark" });
        }

        // Local session usage lives on the Usage page; the Models page never reads it.
        expect(await gateway.getRequests("sessions.usage")).toEqual([]);
        await page.getByRole("button", { name: "View usage", exact: true }).click();
        await waitForControlUiRoute(page, { routeId: "usage" });
        await expect.poll(async () => (await gateway.getRequests("sessions.usage")).length).toBe(1);
      },
    );
  });
});
