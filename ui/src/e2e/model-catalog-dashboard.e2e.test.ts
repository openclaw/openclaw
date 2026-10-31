/**
 * Dashboard request attribution. The default is a compact CI replay; for a real
 * ten-minute browser dwell use OPENCLAW_CATALOG_DASHBOARD_MS=600000 with the
 * focused ui-e2e runner. Each row records actual wire requests after its trigger.
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  controlUiSessionPath,
  installMockGateway,
  reconnectMockGateway,
  waitForControlUiRoute,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { navigationAgents } from "./new-session-page.navigation-fixtures.test-support.ts";

const suite = createControlUiE2eSuite({ name: "model catalog dashboard" });
const durationMs = Number(process.env.OPENCLAW_CATALOG_DASHBOARD_MS ?? 0);
const agentIds = ["main", "research"];
const sessionKeys = [
  "agent:main:dashboard-a",
  "agent:main:dashboard-b",
  "agent:research:dashboard-c",
];
const models = Array.from({ length: 320 }, (_, index) => ({
  id: `model-${index}`,
  provider: `provider-${index % 40}`,
  name: `Dashboard model ${index}`,
  contextWindow: 200_000,
  available: true,
}));

suite.define(() => {
  it(
    "attributes catalog reads to dashboard navigation and invalidation triggers",
    async () => {
      await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
        let configGeneration = 0;
        let surfaceGeneration = 0;
        const surfaceUrl = () =>
          `${suite.server.baseUrl}__openclaw__/cap/synthetic-${surfaceGeneration++}`;
        const config = () => ({ ui: { assistant: { name: `Dashboard ${configGeneration}` } } });
        const configResponse = () => ({
          raw: JSON.stringify(config()),
          hash: `config-${configGeneration}`,
          sourceConfig: config(),
          runtimeConfig: config(),
        });
        const features = [
          ...defaultControlUiFeatureMethods,
          "chat.metadata",
          "chat.startup",
          "plugins.uiDescriptors",
          "plugin.surface.refresh",
        ];
        const gateway = await installMockGateway(
          page,
          {
            defaultAgentId: "main",
            agentModel: "provider-0/model-0",
            sessionKey: sessionKeys[0],
            models,
            pluginSurfaceUrls: { canvas: surfaceUrl() },
            featureMethods: features,
            sessions: sessionKeys.map((key, index) =>
              createControlUiSessionRow(key, `Dashboard ${index + 1}`, Date.now() - index * 1000, {
                model: "model-0",
                modelProvider: "provider-0",
                sessionModelRevision: "models-1",
              }),
            ),
            historyMessages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Synthetic dashboard transcript." }],
              },
            ],
            methodResponses: {
              "agents.list": navigationAgents(agentIds, "per-sender", "provider-0/model-0"),
              "config.get": configResponse(),
              "models.list": {
                cases: agentIds.map((agentId, index) => ({
                  match: { agentId },
                  response: {
                    models: models.slice(index * 160, (index + 1) * 160),
                    sessionModelRevision: "models-1",
                  },
                })),
              },
            },
          },
          {
            requestHandlers: {
              "plugins.uiDescriptors": () => ({
                methods: features,
                controlUiTabs: [],
                controlUiWidgetKinds: [],
                controlUiLinkReaders: [],
                pluginSurfaceUrls: { canvas: surfaceUrl() },
              }),
              "plugin.surface.refresh": () => ({
                surface: "canvas",
                pluginSurfaceUrls: { canvas: surfaceUrl() },
                expiresAtMs: Date.now() + 15_000 + Math.max(durationMs, 60_000),
              }),
            },
          },
        );
        const rows: Array<{
          trigger: string;
          elapsedMs: number;
          models: unknown[];
          surfaceRefreshes: number;
        }> = [];
        let modelCursor = 0,
          surfaceCursor = 0;
        const started = Date.now();
        const steps: Array<[string, () => Promise<unknown>]> = [];
        const navigate = async (pathname: string, routeId: string) => {
          await page.evaluate((target) => {
            history.pushState(null, "", target);
            window.dispatchEvent(new PopStateEvent("popstate"));
          }, pathname);
          await waitForControlUiRoute(page, { pathname, routeId });
        };
        const openSession = (index: number) =>
          navigate(controlUiSessionPath(sessionKeys[index]!), "chat");
        const visibility = (state: "hidden" | "visible") =>
          page.evaluate((next) => {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: next });
            document.dispatchEvent(new Event("visibilitychange"));
          }, state);
        const configEvent = async (change: boolean) => {
          if (change) {
            configGeneration++;
            await gateway.setMethodResponse("config.get", configResponse());
          }
          await gateway.emitGatewayEvent("config.changed", {
            path: "/synthetic/openclaw.json",
            hash: `config-${configGeneration}`,
            ts: Date.now(),
          });
        };
        steps.push(
          ["startup-new", () => page.goto(`${suite.server.baseUrl}new?agent=main`)],
          ["open-main-a", () => openSession(0)],
          ["open-main-b", () => openSession(1)],
          ["open-research", () => openSession(2)],
          ["return-main-a", () => openSession(0)],
          [
            "plugin-ui-change",
            () => gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "plugins-1" }),
          ],
          ["tab-hidden", () => visibility("hidden")],
          ["ui-config-while-hidden", () => configEvent(true)],
          ["tab-visible", () => visibility("visible")],
          ["ui-config-change", () => configEvent(true)],
          ["same-config-notice", () => configEvent(false)],
          [
            "commands-only",
            () =>
              gateway.emitGatewayEvent("chat.metadata.changed", {
                modelCatalogChanged: false,
                authChanged: false,
              }),
          ],
          [
            "catalog-change",
            () =>
              gateway.emitGatewayEvent("chat.metadata.changed", {
                agentId: "main",
                modelCatalogChanged: true,
                commandsChanged: false,
                authChanged: false,
              }),
          ],
          [
            "plugin-generation-change",
            () => gateway.emitGatewayEvent("plugins.changed", { generation: 2 }),
          ],
          ["settings", () => navigate("/settings/model-providers", "model-providers")],
          ["return-new", () => navigate("/new", "new-session")],
          [
            "picker-open-close",
            async () => {
              await page.locator("[data-chat-model-select]:visible").click();
              await page.keyboard.press("Escape");
            },
          ],
          [
            "search-open-close",
            async () => {
              await page.keyboard.press("ControlOrMeta+K");
              await page
                .locator("openclaw-command-palette .cmd-palette__input")
                .fill("Dashboard model");
              await delay(500);
              await page.keyboard.press("Escape");
            },
          ],
          ["return-main-again", () => openSession(0)],
          ["reconnect", () => reconnectMockGateway(page, gateway)],
          ["revisit-main-b", () => openSession(1)],
          ["revisit-research", () => openSession(2)],
          [
            "plugin-ui-change-again",
            () => gateway.emitGatewayEvent("plugins.controlUi.changed", { revision: "plugins-3" }),
          ],
          ["ui-config-change-again", () => configEvent(true)],
        );
        for (const [index, [trigger, action]] of steps.entries()) {
          await action();
          // Allow the existing idle/background metadata coalescers to settle.
          await delay(
            Math.max(3000, started + (durationMs * (index + 1)) / steps.length - Date.now()),
          );
          const requests = await gateway.getRequests("models.list");
          const surfaces = await gateway.getRequests("plugin.surface.refresh");
          const row = {
            trigger,
            elapsedMs: Date.now() - started,
            models: requests.slice(modelCursor).map((request) => request.params),
            surfaceRefreshes: surfaces.length - surfaceCursor,
          };
          rows.push(row);
          modelCursor = requests.length;
          surfaceCursor = surfaces.length;
          console.log("catalog-dashboard", JSON.stringify(row));
          await writeFile(
            path.join(suite.artifactDir, "catalog-dashboard.json"),
            JSON.stringify({ durationMs, elapsedMs: Date.now() - started, rows }, null, 2),
          );
        }
        expect(await gateway.getRequests("connect")).toHaveLength(2);
        const counts = Object.fromEntries(rows.map((row) => [row.trigger, row.models.length]));
        expect(counts).toMatchObject({
          "startup-new": 1,
          "open-main-a": 1,
          "open-main-b": 1,
          "open-research": 1,
          "return-main-a": 0,
          "plugin-ui-change": 0,
          "tab-hidden": 0,
          "ui-config-while-hidden": 0,
          "tab-visible": 0,
          "ui-config-change": 0,
          "same-config-notice": 0,
          "commands-only": 0,
          "catalog-change": 1,
          "plugin-generation-change": 0,
          "picker-open-close": 0,
          "plugin-ui-change-again": 0,
          "ui-config-change-again": 0,
        });
        expect(counts.reconnect).toBeGreaterThan(0);
        expect(rows.reduce((total, row) => total + row.surfaceRefreshes, 0)).toBeGreaterThan(1);
      });
    },
    Math.max(120_000, durationMs + 120_000),
  );
});
