import { afterEach, beforeEach, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createBrowserPanelTestTab,
  createView,
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

export async function receive(socket: TestScreencastSocket, data: string | ArrayBuffer) {
  socket.receive(data);
  await flush();
}

export async function decoded(image: EventTarget) {
  image.dispatchEvent(new Event("load"));
  await flush();
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

// Strict dispatch keeps each scenario's permitted requests explicit.
export function panelScenario(
  targetId: string | undefined,
  url: string | undefined,
  routes: Record<string, (request: Envelope) => unknown>,
) {
  const gateway = createBrowserClient(async (request) => {
    const route =
      routes[request.path] ??
      (request.path === "/act" ? routes[String(request.body?.kind)] : undefined);
    if (!route) {
      throw new Error(`Unexpected browser route: ${request.path}`);
    }
    return await route(request);
  });
  const host = new TestBrowserPanelHost(gateway.client);
  const controller = host.createPanel();
  if (targetId !== undefined) {
    controller.activeTargetId = targetId;
    controller.view = createView(targetId, url);
  }
  const calls = (path: string) =>
    gateway.request.mock.calls
      .map(([, envelope]) => envelope as Envelope)
      .filter((envelope) => envelope.path === path);
  const actions = (kind: string) =>
    calls("/act")
      .map(({ body }) => body)
      .filter((body) => body?.kind === kind);
  return { ...gateway, host, controller, calls, actions };
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
