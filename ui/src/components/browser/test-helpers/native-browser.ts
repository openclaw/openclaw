import { afterEach, beforeEach, vi } from "vitest";
import type {
  NativeBrowserMessage,
  NativeBrowserState,
  NativeBrowserTab,
} from "../../../app/native-browser-bridge.ts";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createInspectedNode,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "../browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "../browser-panel-controller.ts";
import "../browser-panel.ts";

export const nativeTab = (
  id: string,
  url = "https://example.test/page",
  sessionKey = "",
): NativeBrowserTab => ({
  id,
  sessionKey,
  url,
  title: "Example page",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  openedBy: "web",
});

export function fakeNativeBrowser(tabs: NativeBrowserTab[] = [], legacy = false) {
  let state: NativeBrowserState = { revision: 0, tabs };
  const publish = (nextTabs: NativeBrowserTab[]) => {
    state = { revision: state.revision + 1, tabs: nextTabs };
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
    window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", { detail: state }));
  };
  const postMessage = vi.fn(async (message: NativeBrowserMessage) => {
    switch (message.type) {
      case "open": {
        const tab = nativeTab(message.tabId, message.url, message.sessionKey);
        if (legacy) {
          delete tab.sessionKey;
        }
        publish([...state.tabs, tab]);
        return { ok: true, tabId: message.tabId };
      }
      case "close":
        publish(state.tabs.filter((tab) => tab.id !== message.tabId));
        break;
      case "snapshot":
        return {
          ok: true,
          dataUrl: "data:image/png;base64,c2NyZWVuc2hvdA==",
          cssWidth: 100,
          cssHeight: 100,
        };
      case "inspect":
        return { ok: true, node: createInspectedNode("Save") };
      case "download":
        return { ok: true, cancelled: false };
      case "back":
      case "forward":
      case "navigate":
      case "present":
      case "release-scope":
      case "reload":
      case "stop":
        break;
    }
    return { ok: true };
  });
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage } } });
  vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
  return {
    publish,
    postMessage,
    messages: () => postMessage.mock.calls.map(([message]) => message),
  };
}

export function setupNativeBrowserPanelTests() {
  const controllers: BrowserPanelController[] = [];
  let hit: Element | null;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  function controllerFixture(screencast = false, sessionKey = "") {
    let remoteOpen = true;
    const { client, request } = createBrowserClient(
      async (envelope) => {
        if (envelope.method === "DELETE" && envelope.path === "/tabs/remote") {
          remoteOpen = false;
          return { ok: true };
        }
        if (envelope.path === "/tabs" && !remoteOpen) {
          return { running: true, tabs: [] };
        }
        if (envelope.path === "/tabs") {
          return {
            running: true,
            tabs: [
              { tabId: "remote", targetId: "remote", title: "Remote", url: "https://remote.test/" },
            ],
          };
        }
        if (envelope.path === "/screencast") {
          return {
            token: "token",
            wsPath: "/browser/screencast?token=token",
            targetId: "remote",
            url: "https://remote.test/",
          };
        }
        if (envelope.path === "/screenshot") {
          return { path: "/fresh.png", targetId: "remote", url: "https://remote.test/" };
        }
        if (envelope.path === "/download") {
          return { download: { path: "/managed/remote.png", suggestedFilename: "remote.png" } };
        }
        if (envelope.path === "/act") {
          return {
            result: { cssWidth: 100, cssHeight: 100, title: "Remote", url: "https://remote.test/" },
          };
        }
        return { ok: true };
      },
      { screencast },
    );
    const host = new TestBrowserPanelHost(client);
    host.sessionKey = sessionKey;
    document.body.append(host.renderRoot);
    hit = host.renderRoot.querySelector(".bp-stage");
    const controller = new BrowserPanelController(host);
    controllers.push(controller);
    controller.hostConnected();
    return { controller, host, request };
  }

  function flushFrames() {
    const pending = [...frames.values()];
    frames.clear();
    for (const frame of pending) {
      frame(0);
    }
  }

  beforeEach(() => {
    frames = new Map();
    nextFrame = 0;
    hit = null;
    vi.stubGlobal("localStorage", createStorageMock());
    vi.stubGlobal("ResizeObserver", undefined);
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    stubScreenshotMedia();
  });

  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      controller.hostDisconnected();
    }
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  return {
    controllerFixture,
    flushFrames,
    setHit: (element: Element | null) => {
      hit = element;
    },
  };
}

export async function mountSessionPanel(sessionKey: string) {
  const panel = document.createElement("openclaw-browser-panel");
  panel.sessionKey = sessionKey;
  panel.available = true;
  panel.remoteAvailable = false;
  panel.embedded = true;
  panel.presented = true;
  document.body.append(panel);
  await panel.updateComplete;
  return panel;
}
