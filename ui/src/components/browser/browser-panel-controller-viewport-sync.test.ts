import { beforeEach, expect, it, vi } from "vitest";
import { resizeBrowserViewport } from "./browser-client.ts";
import {
  createBrowserClient,
  createView,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";

setupBrowserPanelTestCleanup();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  stubScreenshotMedia();
});

const url = "https://example.test/t";
const targetId = "tab-a";
const tab = { targetId, url };
const metrics = (cssWidth: number, cssHeight: number) => ({ result: { cssWidth, cssHeight, url } });
const screenshot = (id: string) => ({ path: "/fresh.png", targetId: id, url });

function scenario(
  routes: Record<string, (request: BrowserRequestEnvelope) => unknown>,
  activeTargetId?: string,
) {
  const gateway = createBrowserClient(async (request) => {
    const key = request.path === "/act" ? String(request.body?.kind) : request.path;
    const route = routes[key];
    if (!route) {
      throw new Error(`Unexpected browser route: ${request.path} (${key})`);
    }
    return route(request);
  });
  const host = new TestBrowserPanelHost(gateway.client);
  const controller = host.createPanel();
  if (activeTargetId) {
    controller.canAutoResizeViewport = true;
    controller.activeTargetId = activeTargetId;
    controller.view = createView(activeTargetId);
  }
  const actions = (kind: string) =>
    gateway.request.mock.calls
      .map(([, envelope]) => envelope as BrowserRequestEnvelope)
      .filter((envelope) => envelope.path === "/act" && envelope.body?.kind === kind)
      .map((envelope) => envelope.body);
  return { ...gateway, host, controller, actions };
}

it.each([false, true, undefined])(
  "only auto-fits a browser whose owner allows it (canAutoResizeViewport=%s)",
  async (canAutoResizeViewport) => {
    const { client, request, host, controller, actions } = scenario({
      "/tabs": () => ({ running: true, canAutoResizeViewport, tabs: [tab] }),
      "/screenshot": () => screenshot(targetId),
      evaluate: () => metrics(1200, 800),
      resize: () => ({ ok: true }),
      clickCoords: () => ({ ok: true }),
    });
    controller.handleViewportResize(600, 400);
    await controller.refreshAll();
    await vi.advanceTimersByTimeAsync(300);
    expect(controller.view?.metrics).toMatchObject({ cssWidth: 1200, cssHeight: 800 });
    expect(actions("resize")).toHaveLength(canAutoResizeViewport ? 1 : 0);

    controller.handleViewportResize(300, 200);
    await vi.advanceTimersByTimeAsync(300);
    expect(actions("resize")).toHaveLength(canAutoResizeViewport ? 2 : 0);

    // Local scaling still maps a quarter-frame click to the original CSS viewport.
    const stage = host.renderRoot.querySelector<HTMLElement>(".bp-stage")!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 200));
    controller.input.handleStageClick(new MouseEvent("click", { clientX: 75, clientY: 50 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(actions("clickCoords")).toEqual([{ kind: "clickCoords", targetId, x: 300, y: 200 }]);

    // The preview policy must not suppress an intentional resize command.
    request.mockClear();
    await resizeBrowserViewport(client, { targetId, width: 900, height: 600 });
    expect(actions("resize")).toEqual([{ kind: "resize", targetId, width: 900, height: 600 }]);
    controller.suspendView();
  },
);

it("drops a debounced resize when the dock closes before it fires", async () => {
  const { host, controller, actions } = scenario({ resize: () => ({ ok: true }) }, targetId);

  controller.handleViewportResize(640, 480);
  host.open = false;
  await vi.advanceTimersByTimeAsync(300);

  expect(actions("resize")).toHaveLength(0);
});

it("re-syncs a revisited tab after its document changed size elsewhere", async () => {
  let revisitedA = false;
  const { controller, actions } = scenario(
    {
      "/screenshot": (request) => screenshot(String(request.body?.targetId)),
      "/tabs/focus": () => ({ ok: true }),
      resize: () => ({ ok: true }),
      evaluate: (request) =>
        request.body?.targetId === targetId && revisitedA ? metrics(900, 600) : metrics(700, 500),
    },
    targetId,
  );

  controller.handleViewportResize(700, 500);
  await vi.advanceTimersByTimeAsync(300);
  expect(actions("resize")).toHaveLength(1);

  async function selectTab(id: string) {
    const pending = controller.selectTab(id);
    await vi.advanceTimersByTimeAsync(0);
    await pending;
    await vi.advanceTimersByTimeAsync(300);
  }
  await selectTab("tab-b");
  revisitedA = true;
  await selectTab(targetId);

  const resizes = actions("resize");
  expect(resizes.at(-1)).toEqual({ kind: "resize", targetId, width: 700, height: 500 });
  expect(resizes.filter((body) => body?.targetId === targetId)).toHaveLength(2);
});
