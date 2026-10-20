import { beforeEach, expect, it, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics as metrics,
  createBrowserPanelTestTab as tab,
  createView,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanelHost } from "./browser-panel-owner.ts";

setupBrowserPanelTestCleanup();

const dashboardTarget = {
  sessionKey: "agent:main:dashboard",
  name: "status",
  instanceId: "instance",
};
const fixedTab = { target: "host" as const, profile: "openclaw", targetId: "kept-tab" };

const handle = vi.fn<Parameters<typeof createBrowserClient>[0]>();
let host: TestBrowserPanelHost & { fixedTab: BrowserPanelHost["fixedTab"] };
let controller: ReturnType<TestBrowserPanelHost["createPanel"]>;
let request: ReturnType<typeof createBrowserClient>["request"];
beforeEach(() => {
  handle.mockImplementation(async () => {
    throw new Error("Unexpected dashboard request");
  });
  const browser = createBrowserClient(handle);
  request = browser.request;
  host = Object.assign(new TestBrowserPanelHost(browser.client), { fixedTab, dashboardTarget });
  controller = host.createPanel();
  controller.activeTargetId = fixedTab.targetId;
  controller.view = createView(controller.activeTargetId);
});

it("does not download a document through a session-scoped dashboard", async () => {
  host.fixedTab = undefined;
  host.dashboardTarget = { ...dashboardTarget, name: "preview", sessionScoped: true };
  expect(controller.download.available).toBe(false);
  await controller.download.save();
  expect(request).not.toHaveBeenCalled();
});

it("clears a missing dashboard target without showing another tab", async () => {
  handle.mockResolvedValue({
    running: true,
    tabs: [tab("other-tab", "https://other.example", "Other")],
  });
  await controller.refreshAll();

  expect(controller).toMatchObject({ tabs: [], activeTargetId: null, view: null });
  expect(request.mock.calls.map(([, envelope]) => envelope)).toEqual([
    { method: "GET", path: "/tabs", dashboard: host.dashboardTarget },
  ]);
});

it("keeps dashboard ownership through ordinary tab controls", async () => {
  host.dashboardTarget = undefined;
  controller.beginNewTab();
  await controller.closeTab("kept-tab");
  await controller.selectTab("other-tab");
  await controller.openUrl("https://other.example", { newTab: true });

  expect(controller).toMatchObject({
    activeTargetId: "kept-tab",
    view: { targetId: "kept-tab" },
    pendingNewTab: false,
  });
  expect(request).not.toHaveBeenCalled();
});

it("captures its fixed native target when the browser list supplies a friendly alias", async () => {
  stubScreenshotMedia();
  const url = "http://service.example/";
  const id = "native-dashboard-tab";
  handle.mockImplementation(async (envelope) => {
    if (envelope.path === "/tabs") {
      return { running: true, tabs: [{ tabId: "t1", targetId: id, title: "Service", url }] };
    }
    expect(envelope.body?.targetId ?? envelope.query?.targetId).toBe(id);
    if (envelope.path === "/screenshot") {
      return { path: "/fresh.png", targetId: id, url };
    }
    if (envelope.path === "/act") {
      return metrics(url, "Service");
    }
    throw new Error(`Unexpected browser route: ${envelope.path}`);
  });
  host.fixedTab = { ...fixedTab, targetId: id };
  controller.activeTargetId = id;
  controller.view = null;
  await controller.refreshAll();
  expect(controller).toMatchObject({
    errorText: null,
    activeTargetId: id,
    view: { targetId: id },
  });
  expect(controller.tabs.map((entry) => entry.id)).toEqual([id]);
});
