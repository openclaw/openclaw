import { afterEach, beforeEach, vi } from "vitest";
import type * as Bridge from "../../../app/native-browser-bridge.ts";
import { createFrameClock } from "../../../test-helpers/animation-frame-clock.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { preserveDocumentStyle } from "../../../test-helpers/preserve-document-style.ts";
import { stubResizeObserver } from "../../../test-helpers/resize-observer.ts";
import { createStorageMock } from "../../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createBrowserPanelTestMetrics,
  createInspectedNode,
  stubScreenshotMedia,
  TestBrowserPanelHost,
} from "../browser-panel-controller-test-support.ts";
import type { BrowserPanel } from "../browser-panel-owner.ts";
import "../browser-panel.ts";

export const nativeTab = (
  id: string,
  url = "https://example.test/page",
  sessionKey = "",
): Bridge.NativeBrowserTab => ({
  id,
  sessionKey,
  url,
  title: "Example page",
  loading: false,
  canGoBack: true,
  canGoForward: false,
  openedBy: "web",
});

export function fakeNativeBrowser(tabs: Bridge.NativeBrowserTab[] = [], legacy = false) {
  let state: Bridge.NativeBrowserState = { revision: 0, tabs };
  const publish = (nextTabs: Bridge.NativeBrowserTab[]) => {
    state = { revision: state.revision + 1, tabs: nextTabs };
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", state);
    window.dispatchEvent(new CustomEvent("openclaw:native-browser-state", { detail: state }));
  };
  const postMessage = vi.fn(async (message: Bridge.NativeBrowserMessage) => {
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
        return { ok: true, dataUrl: "data:image/png;base64,AA==", cssWidth: 100, cssHeight: 100 };
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
  const messages = () => postMessage.mock.calls.map(([message]) => message);
  return { publish, postMessage, messages };
}

export function setupNativeBrowserPanelTests() {
  const controllers: BrowserPanel[] = [];
  const cleanups: (() => void)[] = [];
  let hit: Element | null;
  let clock: ReturnType<typeof createFrameClock>;

  function controllerFixture(screencast = false, sessionKey = "") {
    let remoteOpen = true;
    const remote = { targetId: "remote", url: "https://remote.test/" };
    const { client, request } = createBrowserClient(
      async ({ method, path }) => {
        if (method === "DELETE" && path === "/tabs/remote") {
          remoteOpen = false;
          return { ok: true };
        }
        const tabs = remoteOpen ? [{ ...remote, tabId: "remote", title: "Remote" }] : [];
        const replies: Record<string, unknown> = {
          "/tabs": { running: true, tabs },
          "/screencast": { ...remote, token: "token", wsPath: "/browser/screencast?token=token" },
          "/screenshot": { ...remote, path: "/fresh.png" },
          "/download": {
            download: { path: "/managed/remote.png", suggestedFilename: "remote.png" },
          },
          "/act": createBrowserPanelTestMetrics(remote.url, "Remote"),
        };
        return Object.hasOwn(replies, path) ? replies[path] : { ok: true };
      },
      { screencast },
    );
    const host = new TestBrowserPanelHost(client);
    host.sessionKey = sessionKey;
    document.body.append(host.renderRoot);
    hit = host.stage;
    const controller = host.createPanel();
    cleanups.push(controller.native.presentation.mountStage(host.stage));
    controllers.push(controller);
    const stopNative = controller.native.mount();
    if (stopNative) {
      cleanups.push(stopNative);
    }
    return { controller, host, request };
  }

  beforeEach(() => {
    preserveDocumentStyle();
    clock = createFrameClock();
    hit = null;
    vi.stubGlobal("localStorage", createStorageMock());
    // Geometry and hit testing below own this no-layout native presentation.
    stubResizeObserver();
    vi.stubGlobal("IntersectionObserver", ResizeObserver);
    vi.stubGlobal("requestAnimationFrame", clock.request);
    vi.stubGlobal("cancelAnimationFrame", clock.cancel);
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    stubScreenshotMedia();
  });

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    controllers.splice(0).forEach((controller) => controller.suspendView());
    document.body.replaceChildren();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  return {
    controllerFixture,
    flushFrames: () => clock.flush(0),
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
  mountSolid(() => panel);
  await panel.updateComplete;
  return panel;
}
