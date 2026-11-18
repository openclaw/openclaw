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
const dashboardTarget = { sessionKey: "agent:main:dashboard", name: "status", instanceId: "i" };
const id = "kept-tab";
const fixedTab = { target: "host" as const, profile: "openclaw", targetId: id };
const handle = vi.fn<Parameters<typeof createBrowserClient>[0]>();
let host: TestBrowserPanelHost & { fixedTab: BrowserPanelHost["fixedTab"] };
let panel: ReturnType<TestBrowserPanelHost["createPanel"]>;
let request: ReturnType<typeof createBrowserClient>["request"];
beforeEach(() => {
  handle.mockRejectedValue(new Error("Unexpected dashboard request"));
  const browser = createBrowserClient(handle);
  request = browser.request;
  host = Object.assign(new TestBrowserPanelHost(browser.client), { fixedTab, dashboardTarget });
  panel = host.createPanel();
  panel.activeTargetId = fixedTab.targetId;
  panel.view = createView(panel.activeTargetId);
});

it("does not download a document through a session-scoped dashboard", async () => {
  host.fixedTab = undefined;
  host.dashboardTarget = { ...dashboardTarget, name: "preview", sessionScoped: true };
  expect(panel.download.available).toBe(false);
  await panel.download.save();
  expect(request).not.toHaveBeenCalled();
});

it("clears a missing dashboard target without showing another tab", async () => {
  handle.mockResolvedValue({
    running: true,
    tabs: [tab("other-tab", "https://other.example", "Other")],
  });
  await panel.refreshAll();
  expect(panel).toMatchObject({ tabs: [], activeTargetId: null, view: null });
  expect(request.mock.calls.map(([, envelope]) => envelope)).toEqual([
    { method: "GET", path: "/tabs", dashboard: host.dashboardTarget },
  ]);
});

it("keeps dashboard ownership through ordinary tab controls", async () => {
  host.dashboardTarget = undefined;
  panel.beginNewTab();
  await panel.closeTab("kept-tab");
  await panel.selectTab("other-tab");
  await panel.openUrl("https://other.example", { newTab: true });

  expect(panel).toMatchObject({ activeTargetId: id, view: { targetId: id }, pendingNewTab: false });
  expect(request).not.toHaveBeenCalled();
});

it("captures its fixed native target when the browser list supplies a friendly alias", async () => {
  stubScreenshotMedia();
  const url = "http://service.example/";
  const raw = "native-dashboard-tab";
  const responses: Record<string, unknown> = {
    "/tabs": { running: true, tabs: [{ tabId: "t1", targetId: raw, title: "Service", url }] },
    "/screenshot": { path: "/fresh.png", targetId: raw, url },
    "/act": metrics(url, "Service"),
  };
  handle.mockImplementation(async (envelope) => {
    if (envelope.path !== "/tabs") {
      expect(envelope.body?.targetId ?? envelope.query?.targetId).toBe(raw);
    }
    return responses[envelope.path] ?? Promise.reject(new Error("Unexpected browser route"));
  });
  host.fixedTab = { ...fixedTab, targetId: raw };
  panel.activeTargetId = raw;
  panel.view = null;
  await panel.refreshAll();
  expect(panel).toMatchObject({ errorText: null, activeTargetId: raw, view: { targetId: raw } });
  expect(panel.tabs.map((entry) => entry.id)).toEqual([raw]);
});
