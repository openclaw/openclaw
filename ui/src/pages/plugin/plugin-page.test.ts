import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { getLogbookState } from "./logbook-controller.ts";
import { PluginPage } from "./plugin-page.ts";

describe("PluginPage", () => {
  it("stops a bundled view when its advertised descriptor disappears", async () => {
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [{ pluginId: "logbook", id: "logbook", label: "Logbook" }],
    };
    const client = {
      request: vi.fn(async (method: string) => {
        if (method === "logbook.status") {
          return {
            captureEnabled: true,
            capturePaused: false,
            captureIntervalSeconds: 30,
            analysisIntervalMinutes: 15,
            retentionDays: 30,
            pendingFrames: 0,
            analysisRunning: false,
            visionModelSource: "missing",
            today: "2026-07-05",
            todayCards: 0,
            timeZone: "UTC",
          };
        }
        if (method === "logbook.days") {
          return { days: [] };
        }
        return {
          day: "2026-07-05",
          cards: [],
          stats: { trackedMs: 0, distractionMs: 0, categories: [], apps: [] },
        };
      }),
    } as unknown as GatewayBrowserClient;
    const snapshot: ApplicationGatewaySnapshot = {
      client,
      connected: true,
      reconnecting: false,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const page = new PluginPage();
    page.pluginId = "logbook";
    page.tabId = "logbook";
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot, subscribe: () => () => undefined },
    } as unknown as ApplicationContext<RouteId>;

    document.body.append(page);
    try {
      await vi.waitFor(() => {
        expect(getLogbookState(page).pollTimer).not.toBeNull();
      });

      hello.controlUiTabs = [];
      page.requestUpdate();
      await page.updateComplete;

      expect(getLogbookState(page).pollTimer).toBeNull();
    } finally {
      page.remove();
    }
  });
});
