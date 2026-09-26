import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";
import { screencastFrame, TestScreencastSocket } from "./browser-screencast-test-support.ts";

const PAGE_URL = "https://example.test/page";
const minted = {
  token: "startup",
  wsPath: "/browser/screencast?token=startup",
  targetId: "raw-a",
  url: PAGE_URL,
};
const ready = JSON.stringify({ type: "ready", targetId: "raw-a", url: PAGE_URL, title: "Page" });
const controllers: BrowserPanelController[] = [];
let sockets: StartupSocket[];

class StartupSocket extends TestScreencastSocket {
  readyState = 0;

  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
}

setupBrowserPanelTestCleanup();
beforeEach(() => {
  vi.useFakeTimers();
  stubScreenshotMedia();
  sockets = [];
  vi.stubGlobal(
    "WebSocket",
    class extends StartupSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    },
  );
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:startup-frame");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  for (const controller of controllers.splice(0)) {
    controller.hostDisconnected();
  }
});

async function flush() {
  await flushBrowserResponses();
  await flushBrowserResponses();
  await flushBrowserResponses();
}

function setup(mint: Promise<unknown> = Promise.resolve(minted)) {
  const gateway = createBrowserClient(
    async (request) => {
      switch (request.path) {
        case "/tabs":
          return { running: true, tabs: [createBrowserPanelTestTab("tab-a", PAGE_URL, "Page")] };
        case "/screencast":
          return await mint;
        case "/screenshot":
          return { path: "/fresh.png", targetId: "raw-a", url: PAGE_URL };
        case "/act":
          return createBrowserPanelTestMetrics(PAGE_URL);
        default:
          return { ok: true };
      }
    },
    { screencast: true },
  );
  const controller = new BrowserPanelController(new TestBrowserPanelHost(gateway.client));
  controller.synchronizeClient();
  controllers.push(controller);
  const calls = (path: string) =>
    gateway.request.mock.calls.filter(
      ([, params]) => (params as BrowserRequestEnvelope).path === path,
    );
  return { controller, calls };
}

describe("Browser panel stream startup lifetime", () => {
  it.each(["mint", "connecting", "open", "ready"] as const)(
    "waits through slow %s, then retires it before one bounded fallback",
    async (phase) => {
      const mint = createDeferred<unknown>();
      const { controller, calls } = setup(phase === "mint" ? mint.promise : undefined);
      const pending = controller.refreshAll();
      await flush();
      const socket = sockets[0];
      if (phase === "open" || phase === "ready") {
        socket?.open();
      }
      if (phase === "ready") {
        socket?.receive(ready);
      }
      await vi.advanceTimersByTimeAsync(1501);
      expect(calls("/screenshot")).toHaveLength(0);
      expect(controller.loading).toBe(true);
      const signal = calls("/screencast")[0]?.[2]?.signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(28_499);
      await pending;
      expect(signal?.aborted).toBe(true);
      expect(calls("/screenshot")).toHaveLength(1);
      expect(controller.loading).toBe(false);
      const fallback = controller.view;
      if (phase === "mint") {
        mint.resolve(minted);
        await flush();
        expect(sockets).toHaveLength(0);
      } else {
        expect(socket?.close).toHaveBeenCalledOnce();
        socket?.receive(screencastFrame());
        await flush();
        expect(controller.view).toBe(fallback);
      }
      await vi.advanceTimersByTimeAsync(9999);
      expect(calls("/screencast")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls("/screencast")).toHaveLength(2);
    },
  );

  it("does not restart the total deadline when minting, socket opening, or ready advances", async () => {
    const mint = createDeferred<unknown>();
    const { controller, calls } = setup(mint.promise);
    const pending = controller.refreshAll();
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls("/screenshot")).toHaveLength(0);
    mint.resolve(minted);
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    sockets[0]!.open();
    await vi.advanceTimersByTimeAsync(9000);
    sockets[0]!.receive(ready);
    expect(calls("/screenshot")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(calls("/screenshot")).toHaveLength(1);
  });

  it("retires a mint immediately when its panel disconnects and ignores its late response", async () => {
    const mint = createDeferred<unknown>();
    const { controller, calls } = setup(mint.promise);
    const pending = controller.refreshAll();
    await flush();
    const signal = calls("/screencast")[0]?.[2]?.signal;
    controller.hostDisconnected();
    await pending;
    expect(signal?.aborted).toBe(true);
    mint.resolve(minted);
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(0);
    expect(calls("/screenshot")).toHaveLength(0);
    expect(calls("/screencast")).toHaveLength(1);
  });

  it("retires a first frame whose decode stalls without publishing it over fallback", async () => {
    const { controller, calls } = setup();
    const pending = controller.refreshAll();
    await flush();
    const images: EventTarget[] = [];
    vi.stubGlobal(
      "Image",
      class extends EventTarget {
        constructor() {
          super();
          images.push(this);
        }
        src = "";
      },
    );
    sockets[0]!.receive(screencastFrame());
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls("/screenshot")).toHaveLength(0);
    stubScreenshotMedia();
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[0]!.close).toHaveBeenCalledOnce();
    expect(calls("/screenshot")).toHaveLength(1);
    const fallback = controller.view;
    expect(fallback?.dataUrl).toMatch(/^data:/);
    images[0]!.dispatchEvent(new Event("load"));
    await flush();
    expect(controller.view).toBe(fallback);
  });

  it("keeps a usable static frame without a recurring frame watchdog", async () => {
    const { controller, calls } = setup();
    const pending = controller.refreshAll();
    await flush();
    sockets[0]!.open();
    sockets[0]!.receive(ready);
    sockets[0]!.receive(screencastFrame());
    await pending;
    const view = controller.view;
    await vi.advanceTimersByTimeAsync(120_000);
    await controller.refreshAll();
    expect(controller.view).toBe(view);
    expect(sockets[0]!.close).not.toHaveBeenCalled();
    expect(calls("/screenshot")).toHaveLength(0);
    expect(calls("/screencast")).toHaveLength(1);
  });
});
