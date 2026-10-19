import { afterEach, beforeEach, vi } from "vitest";
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
import type { BrowserPanel } from "./browser-panel-owner.ts";
import { TestScreencastSocket } from "./browser-screencast-test-support.ts";

export const PAGE_URL = "https://example.test/page";
export const minted = {
  token: "startup",
  wsPath: "/browser/screencast?token=startup",
  targetId: "raw-a",
  url: PAGE_URL,
};
export const ready = JSON.stringify({
  type: "ready",
  targetId: "raw-a",
  url: PAGE_URL,
  title: "Page",
});

export class StartupSocket extends TestScreencastSocket {
  readyState = 0;
  open() {
    this.readyState = 1;
    this.dispatchEvent(new Event("open"));
  }
}

export async function flush() {
  for (let turn = 0; turn < 3; turn++) {
    await flushBrowserResponses();
  }
}

export function deferImages() {
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
  return images;
}

export function streamFixture<Socket extends TestScreencastSocket>(
  SocketClass: new (url: string) => Socket,
  startup = false,
) {
  const controllers: BrowserPanel[] = [];
  const sockets: Socket[] = [];
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  setupBrowserPanelTestCleanup();
  beforeEach(() => {
    vi.useFakeTimers();
    stubScreenshotMedia();
    sockets.length = createdUrls.length = revokedUrls.length = 0;
    vi.stubGlobal("WebSocket", function (url: string) {
      const socket = new SocketClass(url);
      sockets.push(socket);
      return socket;
    });
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
      const url = startup ? "blob:startup-frame" : `blob:frame-${createdUrls.length}`;
      createdUrls.push(url);
      return url;
    });
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
      revokedUrls.push(url);
    });
  });
  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.suspendView();
    }
  });
  function setup(handle?: (envelope: BrowserRequestEnvelope) => Promise<unknown>) {
    const gateway = createBrowserClient(
      async (envelope) => {
        if (handle) {
          const result = await handle(envelope);
          if (result !== undefined) {
            return result;
          }
        }
        switch (envelope.path) {
          case "/tabs":
            return {
              running: true,
              ...(!startup ? { canAutoResizeViewport: true } : {}),
              tabs: [createBrowserPanelTestTab("tab-a", PAGE_URL, "Page")],
            };
          case "/screencast":
            return startup
              ? minted
              : { ...minted, token: "token", wsPath: "/browser/screencast?token=token" };
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
    const host = new TestBrowserPanelHost(gateway.client);
    const controller = host.createPanel();
    controller.synchronizeClient();
    controllers.push(controller);
    const calls = (path: string) =>
      gateway.request.mock.calls.filter(
        ([, params]) => (params as BrowserRequestEnvelope).path === path,
      );
    const resizes = () =>
      calls("/act").filter(
        ([, params]) => (params as BrowserRequestEnvelope).body?.kind === "resize",
      );
    return { ...gateway, host, controller, calls, resizes };
  }
  return { setup, sockets, createdUrls, revokedUrls };
}
