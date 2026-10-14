import { describe, expect, it, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createView,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

function actionRequests(request: ReturnType<typeof createBrowserClient>["request"], kind: string) {
  return request.mock.calls
    .map(([, envelope]) => envelope as BrowserRequestEnvelope)
    .filter((envelope) => envelope.path === "/act" && envelope.body?.kind === kind);
}

describe("BrowserPanelController viewport sync", () => {
  it("drops a debounced resize when the dock closes before it fires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, request } = createBrowserClient(async () => ({ ok: true }));
    const host = new TestBrowserPanelHost(client);
    const controller = new BrowserPanelController(host);
    controller.activeTargetId = "tab-a";
    controller.view = createView("tab-a");

    controller.handleViewportResize(640, 480);
    host.open = false;
    await vi.advanceTimersByTimeAsync(300);

    expect(actionRequests(request, "resize")).toHaveLength(0);
  });

  it("re-syncs a revisited tab after its document changed size elsewhere", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    stubScreenshotMedia();
    // Tab A's viewport is changed remotely (e.g. by an agent) while B is
    // active; revisiting A must re-request the panel size even though it was
    // already requested once for A.
    let revisitedA = false;
    const metricsFor = (targetId: string) =>
      targetId === "tab-a" && revisitedA
        ? { result: { cssWidth: 900, cssHeight: 600, title: "A", url: "https://example.test/t" } }
        : { result: { cssWidth: 700, cssHeight: 500, title: "T", url: "https://example.test/t" } };
    const { client, request } = createBrowserClient(async (envelope) => {
      if (envelope.path === "/tabs/focus") {
        return { ok: true };
      }
      if (envelope.path === "/screenshot") {
        const targetId = String(envelope.body?.targetId);
        return { path: "/fresh.png", targetId, url: "https://example.test/t" };
      }
      if (envelope.path === "/act" && envelope.body?.kind === "resize") {
        return { ok: true };
      }
      if (envelope.path === "/act") {
        return metricsFor(String(envelope.body?.targetId));
      }
      throw new Error(`Unexpected browser route: ${envelope.path}`);
    });
    const controller = createBrowserPanelTestController(client, "tab-a");

    controller.handleViewportResize(700, 500);
    await vi.advanceTimersByTimeAsync(300);
    expect(actionRequests(request, "resize")).toHaveLength(1);

    const toB = controller.selectTab("tab-b");
    await vi.advanceTimersByTimeAsync(0);
    await toB;
    await vi.advanceTimersByTimeAsync(300);

    revisitedA = true;
    const backToA = controller.selectTab("tab-a");
    await vi.advanceTimersByTimeAsync(0);
    await backToA;
    await vi.advanceTimersByTimeAsync(300);

    const resizes = actionRequests(request, "resize").map((envelope) => envelope.body);
    expect(resizes.at(-1)).toEqual({ kind: "resize", targetId: "tab-a", width: 700, height: 500 });
    expect(resizes.filter((body) => body?.targetId === "tab-a")).toHaveLength(2);
  });
});
