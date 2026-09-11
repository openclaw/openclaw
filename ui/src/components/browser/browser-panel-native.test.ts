import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type {
  NativeBrowserMessage,
  NativeBrowserState,
  NativeBrowserTab,
} from "../../app/native-browser-bridge.ts";
import { startNativeLinkRouting } from "../../app/native-link-routing.ts";
import { acquireNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  createBrowserClient,
  createInspectedNode,
  createPointer,
  flushBrowserResponses,
  stubScreenshotMedia,
  TestBrowserPanelHost,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { BrowserPanelController } from "./browser-panel-controller.ts";
import { screencastFrame, TestScreencastSocket } from "./browser-screencast-test-support.ts";
import "./browser-panel.ts";

const nativeTab = (
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

function fakeNativeBrowser(tabs: NativeBrowserTab[] = [], legacy = false) {
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

async function mountSessionPanel(sessionKey: string) {
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

describe("native Browser panel ownership", () => {
  it("keeps tabs local when opening Browser in another chat session", async () => {
    fakeNativeBrowser();
    const first = await mountSessionPanel("agent:main:first");
    first.handleToggleRequest(
      new CustomEvent("openclaw:browser-panel-toggle", {
        detail: { open: true, url: "https://example.test/first", native: true },
      }),
    );
    await flushBrowserResponses();
    await first.updateComplete;
    expect(first.shadowRoot?.querySelectorAll('[role="tab"]')).toHaveLength(1);
    first.presented = false;
    await first.updateComplete;

    const second = await mountSessionPanel("agent:main:second");
    expect(second.shadowRoot?.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(second.shadowRoot?.querySelector<HTMLInputElement>(".bp-url")?.value).toBe("");

    second.handleToggleRequest(
      new CustomEvent("openclaw:browser-panel-toggle", {
        detail: { open: true, url: "https://example.test/second", native: true },
      }),
    );
    await flushBrowserResponses();
    await second.updateComplete;
    expect(second.shadowRoot?.querySelectorAll('[role="tab"]')).toHaveLength(1);
    first.presented = true;
    await first.updateComplete;
    expect(first.shadowRoot?.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(first.shadowRoot?.querySelector<HTMLInputElement>(".bp-url")?.value).toBe(
      "https://example.test/first",
    );
    first.remove();
    const restored = await mountSessionPanel("agent:main:first");
    expect(restored.shadowRoot?.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(restored.shadowRoot?.querySelector<HTMLInputElement>(".bp-url")?.value).toBe(
      "https://example.test/first",
    );
  });

  it("keeps released Mac tabs and popups usable through a Gateway-only update", async () => {
    const { sessionKey: _sessionKey, ...legacyTab } = nativeTab("mac-legacy");
    const native = fakeNativeBrowser([legacyTab], true);
    const first = controllerFixture(false, "agent:main:first");
    flushFrames();
    const second = controllerFixture(false, "agent:main:second");
    flushFrames();
    expect(first.controller.activeTargetId).toBe(legacyTab.id);
    expect(second.controller.activeTargetId).toBe(legacyTab.id);
    native.publish([
      legacyTab,
      { ...legacyTab, id: "mac-popup", openedBy: "native", openerTabId: legacyTab.id },
    ]);
    expect(first.controller.tabs.map((tab) => tab.id)).toEqual(["mac-legacy", "mac-popup"]);
    expect(second.controller.tabs.map((tab) => tab.id)).toEqual(["mac-legacy", "mac-popup"]);
    expect(second.controller.activeTargetId).toBe("mac-popup");
    expect(first.controller.activeTargetId).toBe(legacyTab.id);
    await second.controller.native.open("https://example.test/new", true);
    const opening = native.messages().find((message) => message.type === "open");
    expect(opening).toMatchObject({ sessionKey: "agent:main:second" });
    expect(second.controller.native.activeTab).toMatchObject({ url: "https://example.test/new" });
    expect(second.controller.native.activeTab?.sessionKey).toBeUndefined();
  });

  it("does not publish a pending open into a panel rebound to another session", async () => {
    const native = fakeNativeBrowser();
    const panel = await mountSessionPanel("agent:main:first");
    const reply = createDeferred<{ ok: true; tabId: string }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    panel.handleToggleRequest(
      new CustomEvent("openclaw:browser-panel-toggle", {
        detail: { open: true, url: "https://example.test/slow", native: true },
      }),
    );
    const opening = native.messages().find((message) => message.type === "open");
    if (opening?.type !== "open") {
      throw new Error("Expected an open request");
    }
    expect(opening.sessionKey).toBe("agent:main:first");
    panel.sessionKey = "agent:main:second";
    await panel.updateComplete;
    native.publish([nativeTab(opening.tabId, opening.url, opening.sessionKey)]);
    reply.resolve({ ok: true, tabId: opening.tabId });
    await flushBrowserResponses();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(panel.shadowRoot?.querySelector<HTMLInputElement>(".bp-url")?.value).toBe("");
    panel.sessionKey = "agent:main:first";
    await panel.updateComplete;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(panel.shadowRoot?.querySelector<HTMLInputElement>(".bp-url")?.value).toBe(opening.url);
  });

  it("releases pending download feedback when the panel changes sessions", async () => {
    const native = fakeNativeBrowser([
      nativeTab("mac-first", "https://example.test/first", "agent:main:first"),
      nativeTab("mac-second", "https://example.test/second", "agent:main:second"),
    ]);
    const panel = await mountSessionPanel("agent:main:first");
    const reply = createDeferred<{ ok: true; cancelled: boolean }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Download file"]')?.click();
    await panel.updateComplete;
    expect(
      panel.shadowRoot?.querySelector('[aria-label="Downloading…"]')?.getAttribute("aria-busy"),
    ).toBe("true");

    panel.sessionKey = "agent:main:second";
    await panel.updateComplete;
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector<HTMLInputElement>(".bp-url")?.value).toBe(
      "https://example.test/second",
    );
    expect(
      panel.shadowRoot?.querySelector('[aria-label="Download file"]')?.getAttribute("aria-busy"),
    ).toBe("false");
    reply.reject(new Error("The old session's save failed"));
    await flushBrowserResponses();
    await panel.updateComplete;
    expect(panel.shadowRoot?.querySelector(".bp-note--error")).toBeNull();
    panel.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Download file"]')?.click();
    await flushBrowserResponses();
    expect(native.messages().filter((message) => message.type === "download")).toEqual([
      { type: "download", tabId: "mac-first" },
      { type: "download", tabId: "mac-second" },
    ]);
  });

  it("keeps popup tabs and their fallback activation in the opener's session", async () => {
    const firstTab = nativeTab("mac-first", "https://example.test/first", "agent:main:first");
    const secondTab = nativeTab("mac-second", "https://example.test/second", "agent:main:second");
    const native = fakeNativeBrowser([firstTab, secondTab]);
    const first = controllerFixture(false, firstTab.sessionKey);
    flushFrames();
    const second = controllerFixture(false, secondTab.sessionKey);
    flushFrames();
    // The popup arrives after the first presenter hides; the fallback must not
    // choose the more recently presented, unrelated session.
    first.host.open = false;
    first.controller.suspendView();
    native.publish([
      firstTab,
      secondTab,
      {
        ...nativeTab("mac-popup", "https://example.test/popup", firstTab.sessionKey),
        openedBy: "native",
        openerTabId: firstTab.id,
      },
    ]);
    expect(first.controller.tabs.map((tab) => tab.id)).toEqual(["mac-first", "mac-popup"]);
    expect(first.controller.activeTargetId).toBe("mac-popup");
    expect(second.controller.tabs.map((tab) => tab.id)).toEqual(["mac-second"]);
    expect(second.controller.activeTargetId).toBe("mac-second");
  });

  it("keeps native tabs off the screencast and streams only the selected remote tab", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const sockets: TestScreencastSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends TestScreencastSocket {
        constructor(url: string) {
          super(url);
          sockets.push(this);
        }
      },
    );
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:remote-frame");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, host, request } = controllerFixture(true);
    const mintRequests = () =>
      request.mock.calls.filter(([, params]) => {
        const envelope = params as BrowserRequestEnvelope;
        return envelope.method === "POST" && envelope.path === "/screencast";
      });

    await controller.refreshAll();
    await controller.refreshView("mac-one");
    controller.handleViewportResize(200, 200);
    await vi.advanceTimersByTimeAsync(500);
    expect(mintRequests()).toHaveLength(0);
    expect(sockets).toHaveLength(0);

    const selecting = controller.selectTab("remote");
    await flushBrowserResponses();
    await flushBrowserResponses();
    await flushBrowserResponses();
    expect(mintRequests()).toHaveLength(1);
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    socket.receive(
      JSON.stringify({
        type: "ready",
        targetId: "remote",
        url: "https://remote.test/",
        title: "Remote",
      }),
    );
    socket.receive(screencastFrame("https://remote.test/"));
    await selecting;
    expect(controller.view?.dataUrl).toBe("blob:remote-frame");

    await controller.selectTab("mac-one");
    expect(socket.close).toHaveBeenCalledOnce();
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      tabId: "mac-one",
      visible: true,
    });
    await controller.refreshAll();
    await controller.refreshView("mac-one");
    controller.handleViewportResize(300, 300);
    await vi.advanceTimersByTimeAsync(1000);
    controller.setMode("annotate");
    await flushBrowserResponses();
    expect(native.messages()).toContainEqual({ type: "snapshot", tabId: "mac-one" });
    const capture = controller.view;
    expect(capture?.dataUrl).toMatch(/^data:image\/png/);
    socket.receive(screencastFrame("https://remote.test/late"));
    await flushBrowserResponses();
    expect(controller.view).toBe(capture);
    expect(mintRequests()).toHaveLength(1);
    expect(sockets).toHaveLength(1);

    controller.exitCaptureModes();
    Object.defineProperty(host, "remoteAvailable", { value: false });
    request.mockClear();
    await controller.refreshAll();
    await controller.refreshView("mac-one");
    controller.setMode("inspect");
    await flushBrowserResponses();
    expect(request).not.toHaveBeenCalled();
    expect(controller.errorText).toBeNull();
    expect(sockets).toHaveLength(1);
  });

  it.each([true, false])(
    "selects a reused tab from the open reply when state arrives before the reply: %s",
    async (stateBeforeReply) => {
      const native = fakeNativeBrowser([nativeTab("mac-other", "https://example.test/other")]);
      const { controller } = controllerFixture();
      const existing = nativeTab("mac-existing", "https://example.test/final");
      const state = [nativeTab("mac-other", "https://example.test/other"), existing];
      native.postMessage.mockImplementationOnce(async () => {
        if (stateBeforeReply) {
          native.publish(state);
        }
        return { ok: true, tabId: existing.id };
      });

      await controller.openUrl("https://example.test/short", { newTab: true, native: true });
      if (!stateBeforeReply) {
        expect(controller.activeTargetId).toBe("mac-other");
        native.publish(state);
      }

      expect(controller.activeTargetId).toBe(existing.id);
      expect(controller.urlDraft).toBe(existing.url);
      expect(controller.tabs.map((tab) => tab.id)).toEqual(["mac-other", "mac-existing"]);
    },
  );

  it.each(["state-first", "reply-first", "reused-tab"] as const)(
    "keeps an explicit tab selection when a pending open completes: %s",
    async (completion) => {
      const tabs = [nativeTab("mac-one"), nativeTab("mac-two")];
      const native = fakeNativeBrowser(tabs);
      const { controller } = controllerFixture();
      const reply = createDeferred<{ ok: true; tabId: string }>();
      native.postMessage.mockImplementationOnce(() => reply.promise);
      const opening = controller.openUrl("https://example.test/new", {
        newTab: true,
        native: true,
      });
      const message = native.messages().find((candidate) => candidate.type === "open");
      expect(message?.type).toBe("open");
      if (message?.type !== "open") {
        throw new Error("Expected a native open request");
      }
      await controller.selectTab("mac-two");
      const openedId = completion === "reused-tab" ? "mac-one" : message.tabId;
      const nextTabs = completion === "reused-tab" ? tabs : [...tabs, nativeTab(openedId)];
      if (completion === "state-first") {
        native.publish(nextTabs);
        expect(controller.activeTargetId).toBe("mac-two");
      }
      reply.resolve({ ok: true, tabId: openedId });
      await opening;
      if (completion !== "state-first") {
        native.publish(nextTabs);
      }
      expect(controller.activeTargetId).toBe("mac-two");
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({
        type: "present",
        tabId: "mac-two",
        visible: true,
      });
    },
  );

  it("opens and presents a user link through the actual panel when the old preference is off", async () => {
    const native = fakeNativeBrowser();
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.remoteAvailable = false;
    document.body.append(panel);
    const routing = startNativeLinkRouting({ shouldOpenInControlUiBrowser: () => false });
    const link = document.createElement("a");
    link.href = "https://example.test/article";
    document.body.append(link);
    try {
      link.click();
      await flushBrowserResponses();
      await panel.updateComplete;
      const stage = panel.shadowRoot?.querySelector<HTMLElement>(".bp-stage--native");
      expect(stage).not.toBeNull();
      vi.spyOn(stage!, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 500, 300));
      hit = panel;
      flushFrames();
      expect(native.messages()).toContainEqual(
        expect.objectContaining({ type: "open", url: link.href }),
      );
      expect(native.messages()).toContainEqual(
        expect.objectContaining({
          type: "present",
          visible: true,
          rect: { x: 10, y: 20, width: 500, height: 300 },
        }),
      );
      expect(panel.shadowRoot?.querySelector(".bp-shot")).toBeNull();
    } finally {
      routing.dispose();
      panel.remove();
    }
  });

  it.each(["presented", "suppressed"] as const)(
    "hides the embedded native view when %s changes",
    async (property) => {
      const native = fakeNativeBrowser([nativeTab("mac-one")]);
      const panel = document.createElement("openclaw-browser-panel");
      panel.available = true;
      panel.remoteAvailable = false;
      panel.embedded = true;
      panel.presented = true;
      document.body.append(panel);
      await panel.updateComplete;
      const stage = panel.shadowRoot?.querySelector<HTMLElement>(".bp-stage--native");
      expect(stage).not.toBeNull();
      vi.spyOn(stage!, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 500, 300));
      hit = panel;
      window.dispatchEvent(new Event("resize"));
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({
        type: "present",
        visible: true,
        scope: panel.dataset.nativeBrowserScope,
      });
      expect(panel.dataset.nativeBrowserScope).toBeTruthy();
      if (property === "presented") {
        panel.presented = false;
      } else {
        panel.suppressed = true;
      }
      await panel.updateComplete;
      expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
      panel.remove();
      expect(native.messages().at(-1)).toMatchObject({ type: "release-scope" });
      expect(panel.hasAttribute("data-native-browser-scope")).toBe(false);
    },
  );

  it("lists window tabs before remote tabs and closes only the requested native tab", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one"), nativeTab("mac-two")]);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    expect(controller.tabs.map((tab) => [tab.id, tab.kind])).toEqual([
      ["mac-one", "native"],
      ["mac-two", "native"],
      ["remote", "remote"],
    ]);
    await controller.selectTab("mac-two");
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      tabId: "mac-two",
      visible: true,
    });
    await controller.closeTab("mac-two");
    expect(controller.activeTargetId).toBe("mac-one");
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["mac-one", "remote"]);
  });

  it("builds panels and opens Mac tabs without crypto.randomUUID (insecure origins)", async () => {
    vi.stubGlobal("crypto", {
      // Insecure origins still expose getRandomValues; randomUUID is absent.
      getRandomValues: (array: Uint8Array) => array.fill(0x5a),
    });
    const native = fakeNativeBrowser();
    const { controller } = controllerFixture();
    await controller.openUrl("https://example.test/new", { newTab: true, native: true });
    const message = native.messages().find((candidate) => candidate.type === "open");
    expect(message?.type).toBe("open");
    if (message?.type !== "open") {
      throw new Error("Expected a native open request");
    }
    expect(message.tabId).toMatch(/^mac-[0-9a-f-]{36}$/);
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", tabId: message.tabId });
  });

  it("focuses a cleared address field once a new tab becomes the selection", async () => {
    fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    const input = document.createElement("input");
    input.className = "bp-url";
    controller.host.renderRoot.append(input);
    const focus = vi.spyOn(input, "focus");
    await controller.native.beginNewTab();
    expect(controller.activeTargetId).toMatch(/^mac-[0-9a-f-]{36}$/);
    expect(controller.urlDraft).toBe("");
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("keeps the selected tab's address when a new-tab request is superseded", async () => {
    const tabs = [
      nativeTab("mac-one", "https://example.test/one"),
      nativeTab("mac-two", "https://example.test/two"),
    ];
    const native = fakeNativeBrowser(tabs);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    const input = document.createElement("input");
    input.className = "bp-url";
    controller.host.renderRoot.append(input);
    const focus = vi.spyOn(input, "focus");
    const reply = createDeferred<{ ok: true; tabId: string }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    const opening = controller.native.beginNewTab();
    const message = native.messages().find((candidate) => candidate.type === "open");
    if (message?.type !== "open") {
      throw new Error("Expected a native open request");
    }
    await controller.selectTab("mac-two");
    native.publish([...tabs, nativeTab(message.tabId, "about:blank")]);
    reply.resolve({ ok: true, tabId: message.tabId });
    await opening;
    expect(controller.activeTargetId).toBe("mac-two");
    expect(controller.urlDraft).toBe("https://example.test/two");
    expect(focus).not.toHaveBeenCalled();
  });

  it("lets a newer pending open win over the automatic fallback selection", async () => {
    const native = fakeNativeBrowser();
    const { controller } = controllerFixture();
    await controller.refreshAll();
    await controller.closeTab("remote");
    expect(controller.activeTargetId).toBeNull();
    const firstReply = createDeferred<{ ok: true; tabId: string }>();
    const secondReply = createDeferred<{ ok: true; tabId: string }>();
    native.postMessage
      .mockImplementationOnce(() => firstReply.promise)
      .mockImplementationOnce(() => secondReply.promise);
    const firstOpen = controller.openUrl("https://example.test/first", {
      newTab: true,
      native: true,
    });
    const secondOpen = controller.openUrl("https://example.test/second", {
      newTab: true,
      native: true,
    });
    const opens = native.messages().filter((candidate) => candidate.type === "open");
    if (opens[0]?.type !== "open" || opens[1]?.type !== "open") {
      throw new Error("Expected two native open requests");
    }
    // The first tab's state lands while the second request is still pending.
    native.publish([nativeTab(opens[0].tabId, "https://example.test/first")]);
    firstReply.resolve({ ok: true, tabId: opens[0].tabId });
    await firstOpen;
    expect(controller.activeTargetId).toBeNull();
    native.publish([
      nativeTab(opens[0].tabId, "https://example.test/first"),
      nativeTab(opens[1].tabId, "https://example.test/second"),
    ]);
    secondReply.resolve({ ok: true, tabId: opens[1].tabId });
    await secondOpen;
    expect(controller.activeTargetId).toBe(opens[1].tabId);
    expect(controller.urlDraft).toBe("https://example.test/second");
  });

  it("clears the address bar when the last tab closes without a successor", async () => {
    fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    await controller.refreshAll();
    await controller.closeTab("remote");
    await controller.selectTab("mac-one");
    expect(controller.urlDraft).toBe("https://example.test/page");
    await controller.closeTab("mac-one");
    expect(controller.activeTargetId).toBeNull();
    expect(controller.tabs).toEqual([]);
    expect(controller.urlDraft).toBe("");
  });

  it("deduplicates presentations, hides a covered stage, and restores only after every occluder closes", () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    flushFrames();
    native.postMessage.mockClear();
    controller.hostUpdated();
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(native.postMessage).not.toHaveBeenCalled();
    const first = acquireNativeOverlayOcclusion();
    const second = acquireNativeOverlayOcclusion();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
    first();
    flushFrames();
    expect(
      native.messages().filter((message) => message.type === "present" && message.visible),
    ).toHaveLength(0);
    second();
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: true });
    hit = document.body;
    window.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
  });

  it.each(["select", "reused-open"] as const)(
    "renews ownership when the first panel reselects a tab presented by another scope: %s",
    async (action) => {
      const native = fakeNativeBrowser([nativeTab("mac-one")]);
      const first = controllerFixture();
      flushFrames();
      const firstPresentation = native.messages().at(-1);
      expect(firstPresentation).toMatchObject({ type: "present", tabId: "mac-one", visible: true });
      const second = controllerFixture();
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({
        type: "present",
        scope: second.controller.native.presentation.scope,
        tabId: "mac-one",
        visible: true,
      });
      expect(second.controller.native.presentation.scope).not.toBe(
        first.controller.native.presentation.scope,
      );
      native.postMessage.mockClear();
      hit = first.host.renderRoot.querySelector(".bp-stage");

      if (action === "select") {
        await first.controller.selectTab("mac-one");
      } else {
        native.postMessage.mockImplementationOnce(async () => ({ ok: true, tabId: "mac-one" }));
        await first.controller.openUrl("https://example.test/page", { newTab: true, native: true });
      }
      flushFrames();

      expect(native.messages().filter((message) => message.type === "present")).toEqual([
        firstPresentation,
      ]);
    },
  );

  it("hides on presentation loss and releases its scope without closing window tabs", () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, host } = controllerFixture();
    flushFrames();
    host.open = false;
    controller.hostUpdated();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
    host.open = true;
    controller.hostUpdated();
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: true });
    controller.hostDisconnected();
    expect(native.messages().at(-1)).toMatchObject({ type: "release-scope" });
    expect(native.messages().some((message) => message.type === "close")).toBe(false);
  });

  it("keeps remote screenshots, viewport resizing, and forwarded input off a native tab", async () => {
    vi.useFakeTimers();
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, request } = controllerFixture();
    await controller.refreshAll();
    controller.handleViewportResize(800, 600);
    controller.handleStageClick(new MouseEvent("click", { clientX: 10, clientY: 20 }));
    controller.handleWheel(new WheelEvent("wheel", { deltaY: 50 }));
    controller.handleViewportKeydown(new KeyboardEvent("keydown", { key: "Enter" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(request.mock.calls.map(([, envelope]) => (envelope as { path: string }).path)).toEqual([
      "/tabs",
    ]);
    await controller.selectTab("remote");
    expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
    expect(
      request.mock.calls.some(
        ([, envelope]) => (envelope as { path: string }).path === "/screenshot",
      ),
    ).toBe(true);
  });

  it.each(["annotate", "inspect"] as const)(
    "captures native %s without a Gateway route, then restores the live view",
    async (mode) => {
      const native = fakeNativeBrowser([nativeTab("mac-one")]);
      const { controller } = controllerFixture();
      flushFrames();
      controller.setMode(mode);
      await flushBrowserResponses();
      expect(controller.mode).toBe(mode);
      expect(controller.view).toMatchObject({
        kind: "native",
        targetId: "mac-one",
        metrics: {
          cssWidth: 100,
          cssHeight: 100,
          title: "Example page",
          url: "https://example.test/page",
        },
      });
      expect(controller.view?.browserTab).toBeUndefined();
      expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: false });
      controller.exitCaptureModes();
      flushFrames();
      expect(controller.view).toBeNull();
      expect(native.messages().at(-1)).toMatchObject({ type: "present", visible: true });
    },
  );

  it.each(["annotate", "inspect"] as const)(
    "invalidates a held %s capture when its tab URL changes",
    async (mode) => {
      const native = fakeNativeBrowser([nativeTab("mac-one"), nativeTab("mac-two")]);
      const { controller } = controllerFixture();
      flushFrames();
      controller.setMode(mode);
      await flushBrowserResponses();
      const capture = controller.view;
      expect(capture?.url).toBe("https://example.test/page");
      native.publish([nativeTab("mac-one"), nativeTab("mac-two", "https://example.test/other")]);
      expect(controller.view).toBe(capture);
      expect(controller.mode).toBe(mode);
      native.publish([nativeTab("mac-one", "https://example.test/new"), nativeTab("mac-two")]);
      expect(controller.mode).toBe("interact");
      expect(controller.view).toBeNull();
      expect(controller.urlDraft).toBe("https://example.test/new");
      flushFrames();
      expect(native.messages().at(-1)).toMatchObject({
        type: "present",
        tabId: "mac-one",
        visible: true,
      });
    },
  );

  it("discards an inspect reply from the document preceding a native URL change", async () => {
    vi.useFakeTimers();
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    controller.setMode("inspect");
    await flushBrowserResponses();
    const reply = createDeferred<{ ok: true; node: ReturnType<typeof createInspectedNode> }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    controller.handleOverlayPointerMove(createPointer(25, 50));
    await vi.advanceTimersByTimeAsync(120);
    expect(native.messages().at(-1)).toMatchObject({ type: "inspect" });
    native.publish([nativeTab("mac-one", "https://example.test/new")]);
    reply.resolve({ ok: true, node: createInspectedNode("Old document") });
    await flushBrowserResponses();
    expect(controller.inspected).toBeNull();
    expect(controller.inspectPointer).toBeNull();
  });

  it("releases a slow remote download immediately when another tab is selected", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller } = controllerFixture();
    await controller.selectTab("remote");
    const body = createDeferred<Blob>();
    const response = new Response();
    vi.spyOn(response, "blob").mockReturnValue(body.promise);
    vi.mocked(fetch).mockResolvedValueOnce(response);
    const saving = controller.download.save();
    await flushBrowserResponses();
    expect(controller.download.pending).toBe(true);
    await controller.selectTab("mac-one");
    expect(controller.download.available).toBe(true);
    await controller.download.save();
    expect(native.messages()).toContainEqual({ type: "download", tabId: "mac-one" });
    expect(controller.noticeText).toBeNull();
    expect(controller.download.pending).toBe(false);
    body.resolve(new Blob(["late bytes"]));
    await saving;
    expect(controller.noticeText).toBeNull();
    expect(controller.download.pending).toBe(false);
  });

  it.each([false, true])(
    "saves the native asset without navigation (cancelled: %s)",
    async (cancelled) => {
      const native = fakeNativeBrowser([
        nativeTab("mac-one", "https://assets.example.test/video.mp4"),
      ]);
      const { controller, request } = controllerFixture();
      flushFrames();
      controller.urlDraft = "https://example.test/unfinished";
      const reply = createDeferred<{ ok: true; cancelled: boolean }>();
      native.postMessage.mockImplementationOnce(() => reply.promise);
      const before = request.mock.calls.length;
      const saving = controller.download.save();
      expect(controller.download.pending).toBe(true);
      expect(controller.download.available).toBe(false);
      expect(controller.noticeText).toBeNull();
      reply.resolve({ ok: true, cancelled });
      await saving;
      expect(native.messages().at(-1)).toEqual({ type: "download", tabId: "mac-one" });
      expect(request.mock.calls).toHaveLength(before);
      expect(controller.activeTargetId).toBe("mac-one");
      expect(controller.urlDraft).toBe("https://example.test/unfinished");
      expect(controller.noticeText).toBeNull();
      expect(controller.errorText).toBeNull();
      expect(controller.download.pending).toBe(false);
    },
  );

  it.each([
    { mode: "annotate", action: "reload" },
    { mode: "inspect", action: "back" },
    { mode: "annotate", action: "forward" },
    { mode: "inspect", action: "stop" },
  ] as const)("leaves $mode capture before native $action", async ({ mode, action }) => {
    const native = fakeNativeBrowser([{ ...nativeTab("mac-one"), loading: action === "stop" }]);
    const { controller } = controllerFixture();
    flushFrames();
    controller.setMode(mode);
    await flushBrowserResponses();
    expect(controller.mode).toBe(mode);
    controller.strokes = [{ points: [{ x: 0.25, y: 0.5 }] }];
    if (action === "back" || action === "forward") {
      controller.goHistory(action === "back" ? -1 : 1);
    } else {
      controller.reloadPage();
    }
    expect(native.messages()).toContainEqual({ type: action, tabId: "mac-one" });
    expect(controller.mode).toBe("interact");
    expect(controller.view).toBeNull();
    expect(controller.strokes).toEqual([]);
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      tabId: "mac-one",
      visible: true,
    });
  });

  it("selects the native successor's URL and live view after closing the active remote tab", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, request } = controllerFixture();
    await controller.refreshAll();
    await controller.selectTab("remote");
    expect(controller.urlDraft).toBe("https://remote.test/");
    request.mockClear();
    await controller.closeTab("remote");
    expect(controller.activeTargetId).toBe("mac-one");
    expect(controller.urlDraft).toBe("https://example.test/page");
    expect(controller.view).toBeNull();
    expect(controller.tabs.map((tab) => tab.id)).toEqual(["mac-one"]);
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      tabId: "mac-one",
      visible: true,
    });
    expect(request.mock.calls.map(([, envelope]) => (envelope as { path: string }).path)).toEqual([
      "/tabs/remote",
      "/tabs",
    ]);
  });

  it("inspects a native snapshot through the native message with CSS coordinates", async () => {
    vi.useFakeTimers();
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const { controller, request } = controllerFixture();
    controller.setMode("inspect");
    await flushBrowserResponses();
    controller.handleOverlayPointerMove(createPointer(25, 50));
    await vi.advanceTimersByTimeAsync(120);
    expect(native.messages()).toContainEqual({ type: "inspect", tabId: "mac-one", x: 25, y: 50 });
    expect(controller.inspected?.name).toBe("Save");
    expect(request).not.toHaveBeenCalled();
  });

  it("activates a page popup only in the scope presenting its opener", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one"), nativeTab("mac-two")]);
    const first = controllerFixture();
    flushFrames();
    const second = controllerFixture();
    await second.controller.selectTab("mac-two");
    flushFrames();
    native.publish([
      nativeTab("mac-one"),
      nativeTab("mac-two"),
      {
        ...nativeTab("mac-popup"),
        openedBy: "native",
        openerTabId: "mac-one",
      },
    ]);
    expect(first.controller.activeTargetId).toBe("mac-popup");
    expect(second.controller.activeTargetId).toBe("mac-two");
  });
});
