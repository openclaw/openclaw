import { describe, expect, it, vi } from "vitest";
import { GatewayRequestError } from "../../api/gateway.ts";
import {
  createBrowserClient,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

const PANEL = { width: 1198, height: 923 };
// A remote viewport that no longer matches the panel (new tab, lost emulation, other panel).
const STALE = { cssWidth: 945, cssHeight: 600 };
const PAGE_URL = "https://example.test/page";

function resizeRequests(request: ReturnType<typeof createBrowserClient>["request"]) {
  return request.mock.calls
    .map(([, envelope]) => envelope as BrowserRequestEnvelope)
    .filter((envelope) => envelope.path === "/act" && envelope.body?.kind === "resize")
    .map((envelope) => envelope.body);
}

// Streamed frames keep arriving with the remote size, as the screencast does on a live page.
function streamFrame(controller: BrowserPanelController, index: number, size = STALE) {
  controller.setState("view", {
    targetId: "tab-a",
    dataUrl: `blob:frame-${index}`,
    image: { naturalWidth: size.cssWidth, naturalHeight: size.cssHeight } as HTMLImageElement,
    url: PAGE_URL,
    metrics: { ...size, title: "Page", url: PAGE_URL },
  });
}

async function streamFor(controller: BrowserPanelController, ms: number, from = 0, step = 250) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    streamFrame(controller, from + elapsed);
    await vi.advanceTimersByTimeAsync(step);
  }
}

/** Starts a panel whose page keeps a stale size; `resize` answers each resize request. */
function setupStalePanel(resize: (call: number) => unknown) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  stubScreenshotMedia();
  const resizedAt: number[] = [];
  const { client, request } = createBrowserClient(async (envelope) => {
    if (envelope.path === "/act" && envelope.body?.kind === "resize") {
      resizedAt.push(Date.now());
      return resize(resizedAt.length);
    }
    if (envelope.path === "/screenshot") {
      return { path: "/fresh.png", targetId: "tab-a", url: PAGE_URL };
    }
    if (envelope.path === "/act") {
      return { result: { ...STALE, title: "Page", url: PAGE_URL } };
    }
    throw new Error(`Unexpected browser route: ${envelope.path}`);
  });
  const host = new TestBrowserPanelHost(client);
  const controller = new BrowserPanelController(host);
  controller.activeTargetId = "tab-a";
  streamFrame(controller, 0);
  controller.handleViewportResize(PANEL.width, PANEL.height);
  return { host, controller, request, resizedAt };
}

const unavailable = () => {
  // e.g. a Playwright connectOverCDP timeout while the browser connection is replaced.
  throw new GatewayRequestError({ code: "UNAVAILABLE", message: "connectOverCDP timeout" });
};
const failOnce = (call: number) => (call === 1 ? unavailable() : { ok: true });

describe("BrowserPanelController viewport sync retry", () => {
  it("retries a panel resize that failed transiently while the panel size is unchanged", async () => {
    const { controller, request } = setupStalePanel(failOnce);

    await streamFor(controller, 30_000, 1);

    // The panel still shows a 945x600 page in a 1198x923 viewport: it must try again.
    expect(resizeRequests(request).length).toBeGreaterThanOrEqual(2);
  });

  it("re-requests the panel size when an accepted resize never reached the page", async () => {
    // Accepted, but the emulation was lost (CDP session replaced) before a frame showed it.
    const { controller, request } = setupStalePanel(() => ({ ok: true }));

    await streamFor(controller, 30_000, 1);

    expect(resizeRequests(request).length).toBeGreaterThanOrEqual(2);
  });

  it("restores the panel size without a moved panel edge, which still applies at once", async () => {
    const { controller, request } = setupStalePanel(failOnce);

    await streamFor(controller, 30_000, 1);
    const beforeDrag = resizeRequests(request).length;

    controller.handleViewportResize(PANEL.width - 6, PANEL.height);
    await streamFor(controller, 1_000, 40_000);

    expect(beforeDrag).toBeGreaterThanOrEqual(2);
    expect(resizeRequests(request).at(-1)).toEqual({
      kind: "resize",
      targetId: "tab-a",
      width: PANEL.width - 6,
      height: PANEL.height,
    });
  });

  it("retries a failed resize on a static page that sends no new frames", async () => {
    const { request } = setupStalePanel(failOnce);

    await vi.advanceTimersByTimeAsync(300);
    expect(resizeRequests(request)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(resizeRequests(request)).toHaveLength(2);
  });

  it("settles without a request loop when the browser keeps accepting a size it never applies", async () => {
    const { controller, request } = setupStalePanel(() => ({ ok: true }));

    await streamFor(controller, 10 * 60_000, 1, 1_000);

    // The first request plus three retries, then the size counts as refused.
    expect(resizeRequests(request)).toHaveLength(4);
  });

  it("backs failed retries off to one request per 30 seconds", async () => {
    const { controller, resizedAt } = setupStalePanel(unavailable);

    await streamFor(controller, 10 * 60_000, 1, 1_000);

    const gaps = resizedAt.slice(1).map((at, index) => at - resizedAt[index]!);
    expect(gaps.slice(0, 4).map((gap) => Math.round(gap / 1_000))).toEqual([2, 4, 8, 16]);
    expect(gaps.slice(4).every((gap) => gap >= 30_000 && gap < 32_000)).toBe(true);
    expect(resizedAt.length).toBeLessThanOrEqual(25);
  });

  it.each([
    {
      name: "the panel is hidden",
      after: ({ host }: ReturnType<typeof setupStalePanel>) => {
        host.open = false;
      },
    },
    {
      name: "the page already fits",
      after: ({ controller }: ReturnType<typeof setupStalePanel>) =>
        streamFrame(controller, 1, { cssWidth: PANEL.width, cssHeight: PANEL.height }),
    },
  ])("drops a pending retry when $name", async ({ after }) => {
    const panel = setupStalePanel(unavailable);
    const { request } = panel;

    await vi.advanceTimersByTimeAsync(300);
    expect(resizeRequests(request)).toHaveLength(1);
    after(panel);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(resizeRequests(request)).toHaveLength(1);
  });
});
