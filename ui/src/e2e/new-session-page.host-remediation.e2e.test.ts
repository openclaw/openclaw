import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProofEnabled,
  createNewSessionPageE2eSuite,
  installMockGateway,
  openEnvironmentPicker,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("explains how to enable session hosting on an already-paired device", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "environments.list": {
          profiles: [],
          environments: [
            {
              id: "node:paired-device",
              type: "node",
              label: "Paired device",
              status: "available",
              sessionHost: false,
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("environments.list");
      await openEnvironmentPicker(page);
      const where = page.locator("wa-popover.new-session-page__where-popover");
      const row = where.locator('[data-value="device:paired-device"]');
      await row.hover();
      const details = row
        .locator("xpath=ancestor::openclaw-tooltip[1]")
        .locator('[slot="content"]');
      await details.waitFor({ state: "visible" });
      if (captureUiProofEnabled) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "paired-device.png"),
        });
      }
      const hint = await details.textContent();
      expect(hint).toContain("openclaw config set nodeHost.workerRuns.enabled true");
      expect(hint).toContain("openclaw node install --force");
      expect(hint).not.toContain("openclaw connect");
      expect(await gateway.getRequests("sessions.create")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });
});
