import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { cronList, cronRuns } from "./cron-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Automation event source readiness",
  startServerBeforeBrowser: true,
});
const config = {
  mcp: {
    servers: {
      deployments: { transport: "streamable-http", url: "https://events.example.test/mcp" },
    },
  },
};
suite.define(() => {
  it("keeps setup advice for a confirmed empty server inventory", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "mcp.events.list", "mcp-events.status"],
        methodResponses: {
          "config.get": configSnapshot({}, "empty-config"),
          "cron.list": cronList([], "empty-inventory"),
          "cron.runs": cronRuns([]),
          "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
        },
      });
      await page.goto(new URL("/cron", suite.server.baseUrl).toString());
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator('[data-test-id="cron-schedule-kind-event"]').getByRole("radio").click();
      await gateway.waitForRequest("config.get");
      await page
        .getByText("No enabled MCP servers yet. Add one in Settings → MCP.", { exact: true })
        .waitFor();
      expect(await gateway.getRequests("cron.add")).toHaveLength(0);
    });
  });
  it("does not suggest adding MCP servers before configuration answers", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "mcp.events.list", "mcp-events.status"],
        heldMethods: ["config.get"],
        methodResponses: {
          "cron.list": cronList([], "event-readiness"),
          "cron.runs": cronRuns([]),
          "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          "config.get": configSnapshot(config, "mcp-config"),
          "mcp.events.list": { serverName: "deployments", events: [] },
          "mcp-events.status": { subscriptions: [] },
        },
      });
      await page.goto(new URL("/cron", suite.server.baseUrl).toString());
      await page.locator('[data-test-id="cron-new-task"]').click();
      await page.locator('[data-test-id="cron-schedule-kind-event"]').getByRole("radio").click();
      await gateway.waitForRequest("config.get");
      const section = page.locator("openclaw-cron-page");
      const refresh = page.locator('[data-test-id="cron-events-refresh"]');
      await refresh.waitFor();
      await refresh.click();
      expect(await gateway.getRequests("config.get")).toHaveLength(1);
      const hint = page.getByText("No enabled MCP servers yet. Add one in Settings → MCP.", {
        exact: true,
      });
      const frame = await takeControlUiScreenshotFrame(page, section, [refresh], {
        animations: "disabled",
        scrollTo: refresh,
      });
      await writeFile(path.join(suite.artifactDir, "config-pending.png"), frame.png);
      expect(await hint.count()).toBe(0);
      await gateway.rejectDeferred("config.get", {
        message: "Cannot read event server configuration",
      });
      const error = page
        .getByRole("alert")
        .filter({ hasText: "Cannot read event server configuration" });
      await error.waitFor();
      expect(await hint.count()).toBe(0);
      const reads = await gateway.deferNext("config.get");
      await refresh.click();
      await gateway.waitForRequest("config.get", { after: reads });
      await gateway.resolveDeferred("config.get", configSnapshot(config, "mcp-config"));
      await error.waitFor({ state: "hidden" });
      await page.locator("#cron-event-server").click();
      await page.getByRole("option", { name: "deployments", exact: true }).click();
      await page
        .getByText("This server advertises no supported events.", { exact: true })
        .waitFor();
      expect(await hint.count()).toBe(0);
      expect(await gateway.getRequests("cron.add")).toHaveLength(0);
    });
  });
});
