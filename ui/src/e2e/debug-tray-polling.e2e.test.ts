import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { deviceSystemInfo } from "../test-helpers/devices-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "System tray independent polling" });

suite.define(() => {
  it("keeps vitals live while the active-session read is pending", async () => {
    const proofDir =
      process.env.OPENCLAW_CAPTURE_UI_PROOF === "1"
        ? createControlUiE2eArtifactDir("tray-independent-polling")
        : undefined;
    await suite.withPage(
      { locale: "en-US", colorScheme: "dark", viewport: { width: 1280, height: 1100 } },
      async ({ page }) => {
        await page.clock.install();
        const info = (cpuCoreRatio: number) => ({
          ...deviceSystemInfo,
          eventLoop: {
            degraded: false,
            reasons: [],
            intervalMs: 1000,
            utilization: 0.2,
            cpuCoreRatio,
            delayP99Ms: 25,
            delayMaxMs: 30,
          },
          processMemory: {
            rssBytes: 432 * 1_048_576,
            heapUsedBytes: 210 * 1_048_576,
            heapTotalBytes: 256 * 1_048_576,
          },
        });
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "system.info": info(0.25),
            "diagnostics.lanes": { lanes: [], dynamic: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}debug`, { waitUntil: "domcontentloaded" });
        await page.getByRole("button", { name: /^Open overlay/u }).waitFor();
        // Hold only the tray's next list read, after the route has settled.
        await gateway.deferNext("sessions.list", { activeOnly: true });
        const listsBefore = (await gateway.getRequests("sessions.list", { activeOnly: true }))
          .length;
        await page.getByRole("button", { name: /^Open overlay/u }).click();
        const overlay = page.getByRole("complementary", { name: "System busyness" });
        const cpu = overlay.locator(".gateway-vital--cpu .sparkline-tile__value");
        await expect
          .poll(
            async () => (await gateway.getRequests("sessions.list", { activeOnly: true })).length,
          )
          .toBe(listsBefore + 1);
        await expect.poll(() => cpu.textContent()).toContain("25%");
        const vitalsBefore = (await gateway.getRequests("system.info")).length;
        await gateway.setMethodResponse("system.info", info(0.6));
        try {
          await page.clock.runFor(10_000);
          await expect.poll(() => cpu.textContent(), { timeout: 8_000 }).toContain("60%");
          expect((await gateway.getRequests("system.info")).length).toBeGreaterThan(vitalsBefore);
          expect((await gateway.getRequests("sessions.list", { activeOnly: true })).length).toBe(
            listsBefore + 1,
          );
        } finally {
          if (proofDir) {
            await page.screenshot({
              path: path.join(proofDir, "pending-list-live-vitals.png"),
              animations: "disabled",
            });
          }
          await gateway.resolveDeferred("sessions.list");
        }
      },
    );
  });
});
