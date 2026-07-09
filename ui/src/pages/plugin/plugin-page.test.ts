import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayHelloOk } from "../../api/gateway.ts";
import type { RouteId } from "../../app-route-paths.ts";
import type { ApplicationContext, ApplicationGatewaySnapshot } from "../../app/context.ts";
import { getLogbookState } from "./logbook-controller.ts";
import { PluginPage } from "./plugin-page.ts";

type TestBundledView = {
  render: () => string;
  stop: (host: object) => void;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class DeferredPluginPage extends PluginPage {
  loads = new Map<string, Promise<TestBundledView>>();

  protected override loadBundledView(key: string): Promise<TestBundledView> {
    const load = this.loads.get(key);
    if (!load) {
      throw new Error(`Unexpected bundled view load: ${key}`);
    }
    return load;
  }
}

const deferredPluginPageTag = "openclaw-deferred-plugin-page-test";
if (!customElements.get(deferredPluginPageTag)) {
  customElements.define(deferredPluginPageTag, DeferredPluginPage);
}

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

  it("does not install a stale bundled view after switching tabs", async () => {
    const codexLoad = deferred<TestBundledView>();
    const logbookLoad = deferred<TestBundledView>();
    const hello: GatewayHelloOk = {
      type: "hello-ok",
      protocol: 3,
      auth: { role: "operator", scopes: ["operator.write"] },
      controlUiTabs: [
        { pluginId: "codex-supervisor", id: "sessions", label: "Codex Sessions" },
        { pluginId: "logbook", id: "logbook", label: "Logbook" },
      ],
    };
    const snapshot: ApplicationGatewaySnapshot = {
      client: null,
      connected: true,
      reconnecting: false,
      hello,
      assistantAgentId: null,
      sessionKey: "main",
      lastError: null,
      lastErrorCode: null,
    };
    const page = document.createElement(deferredPluginPageTag) as DeferredPluginPage;
    page.loads = new Map([
      ["codex-supervisor/sessions", codexLoad.promise],
      ["logbook/logbook", logbookLoad.promise],
    ]);
    page.pluginId = "codex-supervisor";
    page.tabId = "sessions";
    (page as unknown as { context: ApplicationContext<RouteId> }).context = {
      gateway: { snapshot, subscribe: () => () => undefined },
    } as unknown as ApplicationContext<RouteId>;

    document.body.append(page);
    try {
      await page.updateComplete;
      page.pluginId = "logbook";
      page.tabId = "logbook";
      await page.updateComplete;

      codexLoad.resolve({ render: () => "stale Codex view", stop: vi.fn() });
      await Promise.resolve();
      await page.updateComplete;
      expect(page.textContent).not.toContain("stale Codex view");

      logbookLoad.resolve({ render: () => "current Logbook view", stop: vi.fn() });
      await vi.waitFor(() => expect(page.textContent).toContain("current Logbook view"));
    } finally {
      page.remove();
    }
  });
});
