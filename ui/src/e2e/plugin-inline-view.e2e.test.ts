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
import { incidentPluginFixture } from "./incident-plugin.test-support.ts";

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
  version: 1,
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
  version: 1,
};

suite.define(() => {
  it("filters inline views through the visible transcript search", async () => {
    await suite.withPage(
      { viewport: { width: 1280, height: 900 }, colorScheme: "light", serviceWorkers: "block" },
      async ({ page }) => {
        const prompt = "Review the incident and release checklist.";
        const match = "Release checklist: smoke tests passed; rollout is ready.";
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-4.1",
          sessionKey,
          historyMessages: [
            { role: "user", content: prompt, timestamp: now },
            toolResult("search-incident", now + 1),
            { role: "assistant", content: match, timestamp: now + 2 },
          ],
          nativePlugins: [incidentPluginFixture([descriptor])],
          methodResponses: { "incident-tools.get": incident },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "chat"));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const inline = pane.locator('[data-plugin-inline-view="search-incident"]');
        await inline.getByRole("heading", { name: incident.title }).waitFor();
        const composer = pane.locator(".agent-chat__composer-combobox textarea");
        await composer.focus();
        const shortcut = await page.evaluate(() =>
          /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "Meta+f" : "Control+f",
        );
        await page.keyboard.press(shortcut);
        const search = pane.getByRole("textbox", { name: "Search messages", exact: true });
        await search.fill("smoke tests");
        await expect.poll(() => pane.getByText(prompt, { exact: true }).count()).toBe(0);
        await pane.getByText(match, { exact: true }).waitFor();
        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const frame = await takeControlUiScreenshotFrame(
            page,
            search,
            [pane.getByText(match, { exact: true })],
            { animations: "disabled" },
          );
          writeFileSync(path.join(suite.artifactDir, "search-filter.png"), frame.png);
        }
        expect(await inline.count()).toBe(0);
        expect(await pane.getByText(summary, { exact: true }).count()).toBe(0);
        await search.fill("INC-42");
        await inline.getByRole("heading", { name: incident.title }).waitFor();
        await search.fill("   ");
        await inline.getByRole("heading", { name: incident.title }).waitFor();
        await pane.getByText(match, { exact: true }).waitFor();
        expect((await gateway.getRequests("chat.send")).length).toBe(0);
      },
    );
  });

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
          incidentPluginFixture([descriptor]),
        ]);
        const gateway = await installMockGateway(page, {
          deferredMethods: ["plugins.controlUi.list"],
          agentModel: "openai/gpt-4.1",
          sessionKey,
          historyMessages: initial,
          inFlightRun: { runId: "incident-run", startedAt: now + 100, events: [] },
          nativePlugins: [incidentPluginFixture([descriptor])],
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
          nativePlugins: [incidentPluginFixture([descriptor])],
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
          incidentPluginFixture([descriptor]),
        ]);
        await gateway.setMethodResponse("plugins.controlUi.list", {
          ...catalog,
          inlineViews: [{ ...descriptor, pluginId: "incident-tools", version: 2 }],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "incompatible" });
        await first.getByText("This view is unavailable.", { exact: false }).waitFor();
        await gateway.setMethodResponse("plugins.controlUi.list", {
          ...catalog,
          revision: "revoked",
          plugins: [],
          inlineViews: [],
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "revoked" });
        await expect.poll(() => page.locator(".incident-tools-card").count()).toBe(0);
        await first.getByText("This view is unavailable.", { exact: false }).waitFor();
        expect(await page.getByText(summary, { exact: true }).count()).toBeGreaterThan(0);
        // The saved payload survived unsupported/missing states; reavailability only hydrates the plugin.
        await gateway.setMethodResponse("plugins.controlUi.list", {
          ...catalog,
          revision: "restored",
        });
        await gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "restored" });
        await first.getByRole("heading", { name: incident.title }).waitFor();
        expect((await gateway.getRequests("chat.send")).length).toBe(0);
      },
    );
  });
});
