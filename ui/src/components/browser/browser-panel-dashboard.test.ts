import { describe, expect, it } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createView,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

describe("Browser dashboard panel target ownership", () => {
  it("clears a missing dashboard target without showing another tab", async () => {
    const { client, request } = createBrowserClient(async () => ({
      running: true,
      tabs: [createBrowserPanelTestTab("other-tab", "https://other.example", "Other")],
    }));
    const host = Object.assign(new TestBrowserPanelHost(client), {
      fixedTab: { target: "host" as const, profile: "openclaw", targetId: "kept-tab" },
      dashboardTarget: {
        sessionKey: "agent:main:dashboard",
        name: "status",
        instanceId: "instance",
      },
    });
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "kept-tab";
    controller.view = createView("kept-tab");

    await controller.refreshAll();

    expect(controller.tabs).toEqual([]);
    expect(controller.activeTargetId).toBeNull();
    expect(controller.view).toBeNull();
    expect(request.mock.calls.map(([, envelope]) => envelope)).toEqual([
      { method: "GET", path: "/tabs", dashboard: host.dashboardTarget },
    ]);
  });

  it("keeps dashboard ownership through ordinary tab controls", async () => {
    const { client, request } = createBrowserClient(async () => {
      throw new Error("Dashboard tab controls must not dispatch another tab operation");
    });
    const host = Object.assign(new TestBrowserPanelHost(client), {
      fixedTab: { target: "host" as const, profile: "openclaw", targetId: "kept-tab" },
    });
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "kept-tab";
    controller.view = createView("kept-tab");

    controller.beginNewTab();
    await controller.closeTab("kept-tab");
    await controller.selectTab("other-tab");
    await controller.openUrl("https://other.example", { newTab: true });

    expect(controller.activeTargetId).toBe("kept-tab");
    expect(controller.view?.targetId).toBe("kept-tab");
    expect(controller.pendingNewTab).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("captures its fixed native target when the browser list supplies a friendly alias", async () => {
    stubScreenshotMedia();
    const url = "http://service.example/";
    const targetId = "native-dashboard-tab";
    const { client } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs") {
        return { running: true, tabs: [{ tabId: "t1", targetId, title: "Service", url }] };
      }
      expect(envelope.body?.targetId ?? envelope.query?.targetId).toBe(targetId);
      if (envelope.path === "/screenshot") {
        return { path: "/fresh.png", targetId, url };
      }
      if (envelope.path === "/act") {
        return createBrowserPanelTestMetrics(url, "Service");
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const host = Object.assign(new TestBrowserPanelHost(client), {
      fixedTab: { target: "host" as const, profile: "openclaw", targetId },
      dashboardTarget: {
        sessionKey: "agent:main:dashboard",
        name: "status",
        instanceId: "instance",
      },
    });
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = targetId;
    await controller.refreshAll();
    expect(controller.errorText).toBeNull();
    expect(controller.activeTargetId).toBe(targetId);
    expect(controller.view?.targetId).toBe(targetId);
    expect(controller.tabs.map((tab) => tab.id)).toEqual([targetId]);
  });
});
