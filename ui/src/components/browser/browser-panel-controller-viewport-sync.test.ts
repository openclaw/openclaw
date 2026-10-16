import { describe, expect, it, vi } from "vitest";
import { resizeBrowserViewport } from "./browser-client.ts";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  createView,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";

setupBrowserPanelTestCleanup();

function actionRequests(request: ReturnType<typeof createBrowserClient>["request"], kind: string) {
  return request.mock.calls
    .map(([, envelope]) => envelope as BrowserRequestEnvelope)
    .filter((envelope) => envelope.path === "/act" && envelope.body?.kind === kind);
}

describe("BrowserPanel viewport sync", () => {
  it.each([false, true, undefined])(
    "only auto-fits a browser whose owner allows it (canAutoResizeViewport=%s)",
    async (canAutoResizeViewport) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      stubScreenshotMedia();
      const { client, request } = createBrowserClient(async (envelope) => {
        if (envelope.path === "/tabs") {
          return {
            running: true,
            canAutoResizeViewport,
            tabs: [{ targetId: "tab-a", title: "A", url: "https://example.test/a" }],
          };
        }
        if (envelope.path === "/screenshot") {
          return { path: "/fresh.png", targetId: "tab-a", url: "https://example.test/a" };
        }
        if (envelope.path === "/act" && envelope.body?.kind === "evaluate") {
          return {
            result: { cssWidth: 1200, cssHeight: 800, title: "A", url: "https://example.test/a" },
          };
        }
        if (
          envelope.path === "/act" &&
          (envelope.body?.kind === "resize" || envelope.body?.kind === "clickCoords")
        ) {
          return { ok: true };
        }
        throw new Error(`Unexpected browser route: ${envelope.path}`);
      });
      const host = new TestBrowserPanelHost(client);
      const controller = host.createPanel();
      controller.handleViewportResize(600, 400);
      await controller.refreshAll();
      await vi.advanceTimersByTimeAsync(300);
      expect(controller.view?.metrics).toMatchObject({ cssWidth: 1200, cssHeight: 800 });
      expect(actionRequests(request, "resize")).toHaveLength(canAutoResizeViewport ? 1 : 0);

      controller.handleViewportResize(300, 200);
      await vi.advanceTimersByTimeAsync(300);
      expect(actionRequests(request, "resize")).toHaveLength(canAutoResizeViewport ? 2 : 0);

      // Local scaling still maps a quarter-frame click to the original CSS viewport.
      const stage = host.renderRoot.querySelector<HTMLElement>(".bp-stage")!;
      vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 200));
      controller.input.handleStageClick(new MouseEvent("click", { clientX: 75, clientY: 50 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(actionRequests(request, "clickCoords").map((envelope) => envelope.body)).toEqual([
        { kind: "clickCoords", targetId: "tab-a", x: 300, y: 200 },
      ]);

      // The preview policy must not suppress an intentional resize command.
      request.mockClear();
      await resizeBrowserViewport(client, { targetId: "tab-a", width: 900, height: 600 });
      expect(actionRequests(request, "resize").map((envelope) => envelope.body)).toEqual([
        { kind: "resize", targetId: "tab-a", width: 900, height: 600 },
      ]);
      controller.suspendView();
    },
  );

  it("drops a debounced resize when the dock closes before it fires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { client, request } = createBrowserClient(async () => ({ ok: true }));
    const host = new TestBrowserPanelHost(client);
    const controller = host.createPanel();
    controller.canAutoResizeViewport = true;
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
    controller.canAutoResizeViewport = true;

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
