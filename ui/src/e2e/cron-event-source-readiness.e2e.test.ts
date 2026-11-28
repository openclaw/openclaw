import { expect, it } from "vitest";
import {
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { configSnapshot } from "./config-composer-fixtures.test-support.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { chooseScheduleKind, cronList, cronRuns } from "./cron-fixtures.test-support.ts";

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
  it("shows how to retry loading events and restores the choices without saving", async () => {
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: [...defaultControlUiFeatureMethods, "mcp.events.list", "mcp-events.status"],
        methodResponses: {
          "config.get": configSnapshot(config, "mcp-config"),
          "cron.list": cronList([], "event-readiness"),
          "cron.runs": cronRuns([]),
          "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          "mcp.events.list": {
            __mockError: {
              code: "UNAVAILABLE",
              message: "Event catalog is temporarily unavailable",
            },
          },
        },
      });
      await page.goto(new URL("/cron?new", suite.server.baseUrl).toString());
      await chooseScheduleKind(page, "event");
      await page.locator("#cron-event-server").click();
      await page.getByRole("option", { name: "deployments", exact: true }).click();
      const method = "mcp.events.list";
      const match = { serverName: "deployments" };
      await gateway.waitForRequest(method, { match });
      const alert = page
        .getByRole("alert")
        .filter({ hasText: "Event catalog is temporarily unavailable" });
      const before = (await alert.textContent())?.trim();
      const after = (await gateway.getRequests(method)).length;
      await gateway.setMethodResponse(method, {
        serverName: "deployments",
        events: [
          {
            name: "deployment.changed",
            delivery: ["webhook"],
            inputSchema: {},
            payloadSchema: true,
          },
        ],
      });
      await page.getByRole("button", { name: "Refresh events and status", exact: true }).click();
      await gateway.waitForRequest(method, { after, match });
      await alert.waitFor({ state: "hidden" });
      await page.locator("#cron-event-name").click();
      await page.getByRole("option", { name: "deployment.changed", exact: true }).click();
      expect(await gateway.getRequests("cron.add")).toHaveLength(0);
      expect(await gateway.getRequests("cron.update")).toHaveLength(0);
      expect(before).toBe(
        "Couldn’t load events. Try Refresh events and status. Details: Event catalog is temporarily unavailable",
      );
    });
  });

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
      await page.goto(new URL("/cron?new", suite.server.baseUrl).toString());
      await chooseScheduleKind(page, "event");
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
      await page.goto(new URL("/cron?new", suite.server.baseUrl).toString());
      await chooseScheduleKind(page, "event");
      await gateway.waitForRequest("config.get");
      const refresh = page.locator('[data-test-id="cron-events-refresh"]');
      await refresh.waitFor();
      await refresh.click();
      expect(await gateway.getRequests("config.get")).toHaveLength(1);
      const hint = page.getByText("No enabled MCP servers yet. Add one in Settings → MCP.", {
        exact: true,
      });
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
