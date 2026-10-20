import { afterEach, beforeEach, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  flushBrowserResponses,
  setupBrowserPanelTestCleanup,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope as Envelope,
} from "./browser-panel-controller-test-support.ts";
import { TestScreencastSocket } from "./browser-screencast-test-support.ts";

export const PAGE_URL = "https://example.test/page";
const page = { targetId: "raw-a", url: PAGE_URL };
export const minted = {
  token: "startup",
  wsPath: "/browser/screencast?token=startup",
  ...page,
};
export const ready = JSON.stringify({ type: "ready", ...page, title: "Page" });

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
  vi.stubGlobal("Image", function () {
    const image = Object.assign(new EventTarget(), { src: "" });
    images.push(image);
    return image;
  });
  return images;
}

export function streamFixture<Socket extends TestScreencastSocket>(
  SocketClass: new (url: string) => Socket,
  startup = false,
) {
  const controllers: ReturnType<TestBrowserPanelHost["createPanel"]>[] = [];
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
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => void revokedUrls.push(url));
  });
  afterEach(() => controllers.splice(0).forEach((controller) => controller.suspendView()));
  function setup(handle?: (envelope: Envelope) => Promise<unknown>) {
    const responses: Record<string, () => unknown> = {
      "/tabs": () => ({
        running: true,
        ...(!startup ? { canAutoResizeViewport: true } : {}),
        tabs: [createBrowserPanelTestTab("tab-a", PAGE_URL, "Page")],
      }),
      "/screencast": () =>
        startup ? minted : { ...minted, token: "token", wsPath: "/browser/screencast?token=token" },
      "/screenshot": () => ({ path: "/fresh.png", ...page }),
      "/act": () => createBrowserPanelTestMetrics(PAGE_URL),
    };
    async function respond(envelope: Envelope) {
      const result = handle ? await handle(envelope) : undefined;
      return result === undefined ? (responses[envelope.path]?.() ?? { ok: true }) : result;
    }
    const { client, request } = createBrowserClient(respond, { screencast: true });
    const host = new TestBrowserPanelHost(client);
    const controller = host.createPanel();
    controller.synchronizeClient();
    controllers.push(controller);
    const calls = (path: string) =>
      request.mock.calls.filter(([, params]) => (params as Envelope).path === path);
    const resizes = () =>
      calls("/act").filter(([, params]) => (params as Envelope).body?.kind === "resize");
    return { client, request, host, controller, calls, resizes };
  }
  return { setup, sockets, createdUrls, revokedUrls };
}
