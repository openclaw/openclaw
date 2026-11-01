import { expect, it } from "vitest";
import { createEmptyCostUsageTotals } from "../../../src/infra/session-cost-usage-totals.js";
import { usageMessages } from "../pages/usage/view.test-support.ts";
import { readControlUiE2eDownload } from "../test-helpers/control-ui-e2e-download.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { installUsageOverviewGateway as installMockGateway } from "./usage-overview-fixture.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Usage export connection recovery" });

suite.define(() => {
  it("reports an interrupted export and lets the operator retry after reconnect", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1440, height: 900 } },
      async ({ page }) => {
        const date = "2026-10-14";
        const totals = {
          ...createEmptyCostUsageTotals(),
          input: 100,
          output: 20,
          totalTokens: 120,
        };
        const messages = usageMessages();
        await page.clock.setFixedTime(new Date(`${date}T12:00:00Z`));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt: Date.parse(`${date}T12:00:00Z`),
              startDate: date,
              endDate: date,
              sessions: [{ key: "agent:main:export-proof", label: "Export proof", usage: totals }],
              totals,
              aggregates: {
                messages,
                tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                byModel: [],
                byProvider: [],
                byAgent: [],
                byChannel: [],
                daily: [],
                costDaily: [{ date, ...totals }],
              },
            },
            "usage.status": { providers: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await page.getByRole("button", { name: "Export proof", exact: true }).waitFor();
        const exportButton = page.getByRole("button", { name: "Export", exact: true });
        await exportButton.waitFor();
        const deferredAfter = await gateway.deferNext("sessions.usage");
        await exportButton.click();
        await page.getByRole("menuitem", { name: "Sessions CSV", exact: true }).click();
        await gateway.waitForRequest("sessions.usage", { after: deferredAfter });
        await page.locator('.usage-export-menu [aria-busy="true"]').waitFor();

        await gateway.setOnline(false);
        await exportButton.waitFor();

        await page.getByText(/^Export: /).waitFor();

        await gateway.setOnline(true);
        await waitForControlUiGatewayReady(page);
        const refreshMatch = { projection: "overview" };
        const refreshAfter = await gateway.deferNext("sessions.usage", refreshMatch);
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await gateway.waitForRequest("sessions.usage", {
          after: refreshAfter,
          match: refreshMatch,
        });
        await exportButton.click();
        const download = page.waitForEvent("download");
        await page.getByRole("menuitem", { name: "Sessions CSV", exact: true }).click();
        const exported = await download;
        expect(exported.suggestedFilename()).toBe(`openclaw-usage-sessions-${date}.csv`);
        expect((await readControlUiE2eDownload(exported)).toString("utf8")).toContain(
          "agent:main:export-proof",
        );
        await gateway.resolveDeferred("sessions.usage", undefined, { match: refreshMatch });
        await exportButton.waitFor();
      },
    );
  });
});
