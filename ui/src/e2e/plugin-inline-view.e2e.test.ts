import { writeFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { PluginInlineViewBlock } from "../../../src/shared/plugin-inline-view.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  controlUiSessionUrl,
  defaultControlUiFeatureMethods,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { prepareNativeControlUiPluginFixtures } from "../test-helpers/control-ui-plugin-fixture.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Native inline plugin views" });
const sessionKey = "agent:main:incident-review";
const incident = {
  incidentId: "INC-42",
  title: "Elevated checkout latency",
  service: "Checkout API",
  severity: "SEV 2",
  status: "Investigating",
  acknowledged: false,
};
const now = Date.now();
const summary = "INC-42: Elevated checkout latency — Investigating.";
const view = (toolCallId: string): PluginInlineViewBlock => ({
  type: "plugin_view",
  pluginId: "incident-tools",
  viewId: "incident-dashboard",
  toolName: "show_incident",
  toolCallId,
  summary,
  status: "ok",
  label: "Incident dashboard",
  payload: { incidentId: "INC-42" },
});
const toolResult = (toolCallId: string, timestamp: number) => ({
  role: "toolResult",
  toolName: "show_incident",
  toolCallId,
  content: [{ type: "text", text: summary }],
  details: { pluginView: view(toolCallId) },
  timestamp,
});
const descriptor = {
  id: "incident-dashboard",
  label: "Incident dashboard",
  schema: {
    type: "object",
    properties: { incidentId: { type: "string" } },
    required: ["incidentId"],
  },
};

suite.define(() => {
  it("mounts during a live turn, shares panel state, and lazily reconstructs history without rerunning tools", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        const initial = [
          {
            role: "user",
            content: "Show the checkout incident and its current status.",
            timestamp: now,
          },
          {
            role: "assistant",
            content:
              "Here is the incident dashboard. You can acknowledge it or open the details alongside this conversation.",
            timestamp: now + 100,
          },
        ];
        const { catalog } = await prepareNativeControlUiPluginFixtures([
          {
            pluginId: "incident-tools",
            rootDir: path.resolve("examples/inline-incident"),
            source: "./control-ui.ts",
            inlineViews: [descriptor],
          },
        ]);
        const gateway = await installMockGateway(page, {
          deferredMethods: ["plugins.controlUi.list"],
          agentModel: "openai/gpt-4.1",
          sessionKey,
          historyMessages: initial,
          inFlightRun: { runId: "incident-run", startedAt: now + 100, events: [] },
          nativePlugins: [
            {
              pluginId: "incident-tools",
              rootDir: path.resolve("examples/inline-incident"),
              source: "./control-ui.ts",
              inlineViews: [descriptor],
            },
          ],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.uiDescriptors",
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "incident-tools.get": incident,
            "incident-tools.acknowledge": { ...incident, acknowledged: true },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        await page.getByText("Here is the incident dashboard.", { exact: false }).waitFor();
        await gateway.emitGatewayEvent("agent", {
          runId: "incident-run",
          sessionKey,
          agentId: "main",
          seq: 1,
          ts: now + 200,
          stream: "tool",
          data: {
            phase: "start",
            name: "show_incident",
            toolCallId: "live-incident",
            args: { incidentId: "INC-42" },
          },
        });
        await gateway.emitGatewayEvent("agent", {
          runId: "incident-run",
          sessionKey,
          agentId: "main",
          seq: 2,
          ts: now + 210,
          stream: "tool",
          data: {
            phase: "result",
            name: "show_incident",
            toolCallId: "live-incident",
            result: {
              content: [{ type: "text", text: summary }],
              details: { pluginView: view("live-incident") },
            },
            isError: false,
          },
        });
        const inline = page.locator('[data-plugin-inline-view="live-incident"]');
        await inline.getByText("Loading plugin view…").waitFor();
        await gateway.resolveDeferred("plugins.controlUi.list", catalog);
        await inline.getByRole("heading", { name: incident.title }).waitFor();
        expect((await gateway.getRequests("chat.send")).length).toBe(0);
        const order = await inline.evaluate((element) => {
          const bubble = element.closest(".chat-bubble");
          return bubble?.textContent?.indexOf("INC-42:") ?? -1;
        });
        expect(order).toBeGreaterThanOrEqual(0);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            inline,
            [inline.getByRole("heading", { name: incident.title })],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, "after-inline.png"), frame.png);
        }
        await inline.getByRole("button", { name: "Open incident panel" }).click();
        await expect.poll(() => page.locator(".incident-tools-card").count()).toBe(2);
        await inline.getByRole("button", { name: "Acknowledge", exact: true }).click();
        await expect
          .poll(() => page.getByRole("button", { name: "Acknowledged", exact: true }).count())
          .toBe(2);
        expect((await gateway.getRequests("incident-tools.acknowledge")).length).toBe(1);
        expect((await gateway.getRequests("chat.send")).length).toBe(0);
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            inline,
            [inline.getByRole("button", { name: "Acknowledged", exact: true })],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, "after-panel.png"), frame.png);
        }
      },
    );
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, serviceWorkers: "block" },
      async ({ page }) => {
        // A new page consumes persisted rows, not the live tool producer. Thirty independent calls
        // make eager whole-history hydration observable through actual plugin read requests.
        const history = Array.from({ length: 30 }, (_, index) => [
          {
            role: "assistant",
            content: "Incident review " + (index + 1),
            timestamp: now + 1000 + index * 10,
          },
          toolResult("history-" + index, now + 1001 + index * 10),
        ]).flat();
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4.1",
          sessionKey,
          historyMessages: history,
          nativePlugins: [
            {
              pluginId: "incident-tools",
              rootDir: path.resolve("examples/inline-incident"),
              source: "./control-ui.ts",
              inlineViews: [descriptor],
            },
          ],
          featureMethods: [
            ...defaultControlUiFeatureMethods,
            "plugins.uiDescriptors",
            "plugins.controlUi.list",
            "plugins.controlUi.report",
          ],
          methodResponses: {
            "incident-tools.get": incident,
            "incident-tools.acknowledge": { ...incident, acknowledged: true },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        await page.locator('[data-plugin-inline-view="history-29"] .incident-tools-card').waitFor();
        await page.reload();
        const last = page.locator('[data-plugin-inline-view="history-29"]');
        await last.getByRole("heading", { name: incident.title }).waitFor();
        const reads = (await gateway.getRequests("incident-tools.get")).length;
        expect(reads).toBeGreaterThan(0);
        expect(reads).toBeLessThan(15);
        expect(await page.locator(".incident-tools-card").count()).toBeLessThan(10);
        const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
        await thread.evaluate((element) => {
          element.scrollTop = 0;
          element.dispatchEvent(new Event("scroll"));
        });
        const first = page.locator('[data-plugin-inline-view="history-0"]');
        await first.getByRole("heading", { name: incident.title }).waitFor();
        expect(await last.locator(".incident-tools-card").count()).toBe(0);
        expect((await gateway.getRequests("chat.send")).length).toBe(0);
        expect((await gateway.getRequests("incident-tools.acknowledge")).length).toBe(0);
        // Keeping frontend code installed is insufficient after the current backend declaration is revoked.
        const requests = await gateway.getRequests("plugins.controlUi.list");
        expect(requests.length).toBeGreaterThan(0);
        const { catalog } = await prepareNativeControlUiPluginFixtures([
          {
            pluginId: "incident-tools",
            rootDir: path.resolve("examples/inline-incident"),
            source: "./control-ui.ts",
            inlineViews: [descriptor],
          },
        ]);
        await gateway.setMethodResponse("plugins.controlUi.list", {
          ...catalog,
          inlineViews: [{ ...descriptor, pluginId: "incident-tools", schema: { type: "number" } }],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "incompatible" });
        await first.getByText("This saved view is incompatible", { exact: false }).waitFor();
        await gateway.setMethodResponse("plugins.controlUi.list", {
          ...catalog,
          revision: "revoked",
          inlineViews: [],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "revoked" });
        await expect.poll(() => page.locator(".incident-tools-card").count()).toBe(0);
        await first.getByText("This view is unavailable.", { exact: false }).waitFor();
        expect(await page.getByText(summary, { exact: true }).count()).toBeGreaterThan(0);
      },
    );
  });
});
