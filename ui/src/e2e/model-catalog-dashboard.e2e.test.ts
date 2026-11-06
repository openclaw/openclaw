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
  pauseVirtualClock,
  type MockGatewayWindow,
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
const compact = durationMs === 0;
const expectedCounts: Record<string, number> = {
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
};

declare global {
  interface Window {
    catalogDashboardWork: { requests: Set<string>; idleCallbacks: Set<number> };
  }
}

// Observe the mock wire through delivery, including host-backed response bindings.
// Idle callbacks must also finish; UI readiness alone can precede background work.
function trackDashboardWork() {
  const work = { requests: new Set<string>(), idleCallbacks: new Set<number>() };
  window.catalogDashboardWork = work;
  const MockSocket = window.WebSocket;
  window.WebSocket = class extends MockSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      // The routed mock constructor returns its transport, without this subclass's prototype.
      const send = this.send.bind(this);
      this.addEventListener("message", (event: MessageEvent) => {
        const frame: { type: string; id: string } = JSON.parse(event.data);
        if (frame.type === "res") {
          work.requests.delete(frame.id);
        }
      });
      this.send = (data) => {
        if (typeof data === "string") {
          const frame: { type: string; id: string } = JSON.parse(data);
          if (frame.type === "req") {
            work.requests.add(frame.id);
          }
        }
        send(data);
      };
    }
  };
  const requestIdle = window.requestIdleCallback;
  const cancelIdle = window.cancelIdleCallback;
  window.requestIdleCallback = (callback, options) => {
    const id = requestIdle.call(
      window,
      (deadline) => {
        work.idleCallbacks.delete(id);
        callback(deadline);
      },
      options,
    );
    work.idleCallbacks.add(id);
    return id;
  };
  window.cancelIdleCallback = (id) => {
    work.idleCallbacks.delete(id);
    cancelIdle.call(window, id);
  };
}

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
        if (compact) {
          await page.clock.install();
        }
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
            afterInitScript: `;(() => { const __name = (target) => target; (${trackDashboardWork.toString()})(); })();`,
            requestHandlers: {
              "plugins.uiDescriptors": () => ({
                methods: features,
                controlUiTabs: [],
                controlUiWidgetKinds: [],
                controlUiLinkReaders: [],
                pluginSurfaceUrls: { canvas: surfaceUrl() },
              }),
              "plugin.surface.refresh": async () => ({
                surface: "canvas",
                pluginSurfaceUrls: { canvas: surfaceUrl() },
                expiresAtMs:
                  (await page.evaluate(() => Date.now())) + 15_000 + Math.max(durationMs, 60_000),
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
            ts: await page.evaluate(() => Date.now()),
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
            async () => {
              const match = { agentId: "main", sessionKey: sessionKeys[0] };
              const after = compact ? await gateway.deferNext("models.list", match) : undefined;
              await gateway.emitGatewayEvent("chat.metadata.changed", {
                agentId: "main",
                modelCatalogChanged: true,
                commandsChanged: false,
                authChanged: false,
              });
              if (compact) {
                const request = await gateway.waitForRequest("models.list", { after, match });
                // A held wire reply proves the observer is active before settlement relies on it.
                expect(
                  await page.evaluate(
                    (id) => window.catalogDashboardWork.requests.has(id),
                    request.id,
                  ),
                ).toBe(true);
                await gateway.resolveDeferred("models.list", undefined, { match });
              }
            },
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
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) => {
                    setTimeout(resolve, 500);
                  }),
              );
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
        const advanceUntil = <T>(read: () => T | Promise<T>, expected: T) =>
          expect
            .poll(
              async () => {
                await page.clock.runFor(50);
                return read();
              },
              { interval: 10 },
            )
            .toEqual(expected);
        for (const [index, [trigger, action]] of steps.entries()) {
          if (compact) {
            if (index === 0) {
              // Boot with the clock ticking; later actions run under the paused clock.
              await action();
              await pauseVirtualClock(page);
            } else {
              let completed = false;
              const actionDone = action();
              const finish = () => {
                completed = true;
              };
              void actionDone.then(finish, finish);
              await advanceUntil(() => completed, true);
              await actionDone;
            }
            const minimumReads =
              modelCursor + (expectedCounts[trigger] ?? (trigger === "reconnect" ? 1 : 0));
            const settle = () =>
              advanceUntil(
                () =>
                  page.evaluate(
                    (minimum) => ({
                      ready: window.openclawControlUi?.snapshot().ready === true,
                      requests: window.catalogDashboardWork.requests.size,
                      idleCallbacks: window.catalogDashboardWork.idleCallbacks.size,
                      catalogReady:
                        ((window as MockGatewayWindow).openclawControlUiE2eGateway?.findRequests(
                          "models.list",
                        ).length ?? 0) >= minimum,
                    }),
                    minimumReads,
                  ),
                { ready: true, requests: 0, idleCallbacks: 0, catalogReady: true },
              );
            await settle();
            // Cross the 2.5s metadata debounce, 750ms chat idle deadline (50ms
            // fallback), and 500ms shell idle delay, even for zero-read rows.
            await page.clock.runFor(4_000);
            await settle();
          } else {
            await action();
            await delay(
              Math.max(3000, started + (durationMs * (index + 1)) / steps.length - Date.now()),
            );
          }
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
        expect(counts).toMatchObject(expectedCounts);
        expect(counts.reconnect).toBeGreaterThan(0);
        expect(rows.reduce((total, row) => total + row.surfaceRefreshes, 0)).toBeGreaterThan(1);
      });
    },
    Math.max(120_000, durationMs + 120_000),
  );
});
