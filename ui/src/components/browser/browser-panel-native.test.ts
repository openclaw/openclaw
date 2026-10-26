import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { startNativeLinkRouting } from "../../app/native-link-routing.ts";
import { acquireNativeOverlayOcclusion } from "../../lib/native-overlay-occlusion.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { promoteToPopoverTopLayer } from "../menu-surface.ts";
import {
  createInspectedNode,
  createPointer,
  flushBrowserResponses,
  openBrowserActions,
  type BrowserRequestEnvelope,
} from "./browser-panel-controller-test-support.ts";
import { screencastFrame, TestScreencastSocket } from "./browser-screencast-test-support.ts";
import {
  fakeNativeBrowser,
  mountSessionPanel,
  nativeTab,
  setupNativeBrowserPanelTests,
} from "./test-helpers/native-browser.ts";

const { controllerFixture, flushFrames, setHit } = setupNativeBrowserPanelTests();
type Native = ReturnType<typeof fakeNativeBrowser>;
type Controller = ReturnType<typeof controllerFixture>["controller"];
const address = (panel: HTMLElement) => panel.querySelector<HTMLInputElement>(".bp-url");
const tabIds = (controller: Controller) => controller.tabs.map((tab) => tab.id);
function toggle(panel: HTMLElementTagNameMap["openclaw-browser-panel"], url: string) {
  panel.handleToggleRequest(
    new CustomEvent("openclaw:browser-panel-toggle", {
      detail: { open: true, url, native: true },
    }),
  );
}
function expectPresent(native: Native, visible: boolean, tabId?: string) {
  expect(native.messages().at(-1)).toMatchObject({
    type: "present",
    visible,
    ...(tabId === undefined ? {} : { tabId }),
  });
}
function openMessage(native: Native) {
  const message = native.messages().find((candidate) => candidate.type === "open");
  if (message?.type !== "open") {
    throw new Error("Expected a native open request");
  }
  return message;
}
function addressInput(controller: Controller) {
  const input = document.createElement("input");
  input.className = "bp-url";
  controller.host.renderRoot.append(input);
  controller.addressInput = input;
  return vi.spyOn(input, "focus");
}
function nativeStage(panel: HTMLElement) {
  const stage = panel.querySelector<HTMLElement>(".bp-stage--native")!;
  vi.spyOn(stage, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 500, 300));
  setHit(panel);
}
function fixture(tabs = [nativeTab("mac-one")]) {
  const native = fakeNativeBrowser(tabs);
  return { native, ...controllerFixture() };
}

describe("native Browser panel ownership", () => {
  it("keeps a typed address when Go takes focus before a native state publication", async () => {
    const sessionKey = "agent:main:go";
    const tab = nativeTab("mac-go", "https://example.test/current", sessionKey);
    const native = fakeNativeBrowser([tab]);
    const panel = await mountSessionPanel(sessionKey);
    const input = address(panel)!;
    input.focus();
    input.value = "https://example.test/typed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await panel.updateComplete;
    const go = panel.querySelector<HTMLButtonElement>('button[aria-label="Go"]')!;
    expect(go).not.toBeNull();
    go.focus();
    native.publish([{ ...tab, title: "Updated native title" }]);
    await panel.updateComplete;
    go.click();
    await flushBrowserResponses();
    expect(native.messages()).toContainEqual({
      type: "navigate",
      tabId: "mac-go",
      url: "https://example.test/typed",
    });
    expect(native.messages().some((message) => message.type === "reload")).toBe(false);
    native.publish([{ ...tab, url: "https://example.test/typed", canGoBack: true }]);
    await panel.updateComplete;
    panel.mobilePresentation = true;
    await panel.updateComplete;
    expect(panel.querySelector(".bp-url")).toBe(input);
    input.focus();
    input.value = "https://example.test/cancelled";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await panel.updateComplete;
    expect(input.value).toBe("https://example.test/typed");
    input.focus();
    input.value = "https://example.test/abandoned";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const back = panel.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!;
    back.focus();
    back.click();
    native.publish([{ ...tab, url: "https://example.test/current" }]);
    await panel.updateComplete;
    expect(input.value).toBe("https://example.test/current");
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
    expect(tabIds(first.controller)).toEqual(["mac-legacy", "mac-popup"]);
    expect(tabIds(second.controller)).toEqual(["mac-legacy", "mac-popup"]);
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
    toggle(panel, "https://example.test/slow");
    const opening = openMessage(native);
    expect(opening.sessionKey).toBe("agent:main:first");
    panel.sessionKey = "agent:main:second";
    await panel.updateComplete;
    native.publish([nativeTab(opening.tabId, opening.url, opening.sessionKey)]);
    reply.resolve({ ok: true, tabId: opening.tabId });
    await flushBrowserResponses();
    await panel.updateComplete;
    expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(address(panel)?.value).toBe("");
    panel.sessionKey = "agent:main:first";
    await panel.updateComplete;
    await panel.updateComplete;
    expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(address(panel)?.value).toBe(opening.url);
    panel.remove();
    const restored = await mountSessionPanel("agent:main:first");
    expect(restored.querySelectorAll('[role="tab"]')).toHaveLength(1);
    expect(address(restored)?.value).toBe(opening.url);
  });

  it("releases pending download feedback when the panel changes sessions", async () => {
    const native = fakeNativeBrowser([
      nativeTab("mac-first", "https://example.test/first", "agent:main:first"),
      nativeTab("mac-second", "https://example.test/second", "agent:main:second"),
    ]);
    const panel = await mountSessionPanel("agent:main:first");
    const reply = createDeferred<{ ok: true; cancelled: boolean }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    (await openBrowserActions(panel))
      .querySelector<HTMLElement>('[aria-label="Download file"]')!
      .click();
    await panel.updateComplete;
    await openBrowserActions(panel);
    expect(document.querySelector('[aria-label="Downloading…"]')?.getAttribute("aria-busy")).toBe(
      "true",
    );

    panel.sessionKey = "agent:main:second";
    await panel.updateComplete;
    await panel.updateComplete;
    expect(address(panel)?.value).toBe("https://example.test/second");
    await openBrowserActions(panel);
    expect(document.querySelector('[aria-label="Download file"]')?.getAttribute("aria-busy")).toBe(
      "false",
    );
    reply.reject(new Error("The old session's save failed"));
    await flushBrowserResponses();
    await panel.updateComplete;
    expect(panel.querySelector(".bp-note--error")).toBeNull();
    (await openBrowserActions(panel))
      .querySelector<HTMLElement>('[aria-label="Download file"]')!
      .click();
    await flushBrowserResponses();
    expect(native.messages().filter((message) => message.type === "download")).toEqual([
      { type: "download", tabId: "mac-first" },
      { type: "download", tabId: "mac-second" },
    ]);
  });

  it.each([false, true])(
    "activates popups only in the opener's scope (hidden session: %s)",
    async (hidden) => {
      const firstTab = nativeTab("mac-first", undefined, hidden ? "agent:main:first" : "");
      const secondTab = nativeTab("mac-second", undefined, hidden ? "agent:main:second" : "");
      const native = fakeNativeBrowser([firstTab, secondTab]);
      const first = controllerFixture(false, firstTab.sessionKey);
      flushFrames();
      const second = controllerFixture(false, secondTab.sessionKey);
      await second.controller.selectTab(secondTab.id);
      flushFrames();
      if (hidden) {
        first.host.open = false;
        first.controller.suspendView();
      }
      native.publish([
        firstTab,
        secondTab,
        {
          ...nativeTab("mac-popup", undefined, firstTab.sessionKey),
          openedBy: "native",
          openerTabId: firstTab.id,
        },
      ]);
      expect(first.controller.activeTargetId).toBe("mac-popup");
      expect(second.controller.activeTargetId).toBe(secondTab.id);
      if (hidden) {
        expect(tabIds(first.controller)).toEqual(["mac-first", "mac-popup"]);
        expect(tabIds(second.controller)).toEqual(["mac-second"]);
      }
    },
  );

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
    expectPresent(native, true, "mac-one");
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

  it.each([
    ["reused", "state-first"],
    ["reused", "reply-first"],
    ["selected", "state-first"],
    ["selected", "reply-first"],
    ["selected", "reused-tab"],
    ["draft", "current"],
    ["draft", "superseded"],
  ] as const)("settles native %s opens without stealing newer intent: %s", async (kind, order) => {
    const tabs = [nativeTab("mac-one"), nativeTab("mac-two", "https://example.test/two")];
    const { native, controller } = fixture(tabs);
    const focus = kind === "draft" ? addressInput(controller) : null;
    const reply = createDeferred<{ ok: true; tabId: string }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    const opening =
      kind === "draft"
        ? controller.native.beginNewTab()
        : controller.openUrl("https://example.test/short", { newTab: true, native: true });
    const message = openMessage(native);
    const superseded = kind === "selected" || order === "superseded";
    if (superseded) {
      await controller.selectTab("mac-two");
    }
    const opened =
      kind === "reused"
        ? nativeTab("mac-existing", "https://example.test/final")
        : order === "reused-tab"
          ? tabs[0]!
          : nativeTab(message.tabId, kind === "draft" ? "about:blank" : message.url);
    const nextTabs = order === "reused-tab" ? tabs : [...tabs, opened];
    const stateFirst = order !== "reply-first" && order !== "reused-tab";
    if (stateFirst) {
      native.publish(nextTabs);
      if (superseded) {
        expect(controller.activeTargetId).toBe("mac-two");
      }
    }
    reply.resolve({ ok: true, tabId: opened.id });
    await opening;
    if (!stateFirst) {
      if (!superseded) {
        expect(controller.activeTargetId).toBe("mac-one");
      }
      native.publish(nextTabs);
    }
    expect(controller.activeTargetId).toBe(superseded ? "mac-two" : opened.id);
    if (kind === "draft") {
      expect(controller.urlDraft).toBe(superseded ? tabs[1]!.url : "");
      expect(focus).toHaveBeenCalledTimes(superseded ? 0 : 1);
      if (!superseded) {
        expect(opened.id).toMatch(/^mac-[0-9a-f-]{36}$/);
      }
    } else if (kind === "reused") {
      expect(controller.urlDraft).toBe(opened.url);
      expect(tabIds(controller)).toEqual(["mac-one", "mac-two", "mac-existing"]);
    }
    if (superseded) {
      flushFrames();
      expectPresent(native, true, "mac-two");
    }
  });

  it("opens and presents a user link through the actual panel when the old preference is off", async () => {
    const native = fakeNativeBrowser();
    const panel = document.createElement("openclaw-browser-panel");
    panel.available = true;
    panel.remoteAvailable = false;
    mountSolid(() => panel);
    await panel.updateComplete;
    const routing = startNativeLinkRouting({ shouldOpenInControlUiBrowser: () => false });
    const link = document.createElement("a");
    link.href = "https://example.test/article";
    document.body.append(link);
    try {
      link.click();
      await flushBrowserResponses();
      await panel.updateComplete;
      nativeStage(panel);
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
      expect(panel.querySelector(".bp-shot")).toBeNull();
    } finally {
      routing.dispose();
      panel.remove();
    }
  });

  it("hides the embedded native view when suppression changes", async () => {
    const native = fakeNativeBrowser([nativeTab("mac-one")]);
    const panel = await mountSessionPanel("");
    nativeStage(panel);
    window.dispatchEvent(new Event("resize"));
    flushFrames();
    expect(native.messages().at(-1)).toMatchObject({
      type: "present",
      visible: true,
      scope: panel.dataset.nativeBrowserScope,
    });
    expect(panel.dataset.nativeBrowserScope).toBeTruthy();
    panel.suppressed = true;
    await panel.updateComplete;
    expectPresent(native, false);
    panel.remove();
    await waitForSolid(() =>
      expect(native.messages().at(-1)).toMatchObject({ type: "release-scope" }),
    );
    expect(panel.hasAttribute("data-native-browser-scope")).toBe(false);
  });

  it("closes native and remote tabs, selects a live successor, and clears the last address", async () => {
    const { native, controller } = fixture([nativeTab("mac-one"), nativeTab("mac-two")]);
    await controller.refreshAll();
    await controller.selectTab("mac-two");
    await controller.closeTab("mac-two");
    expect(controller.activeTargetId).toBe("mac-one");
    expect(tabIds(controller)).toEqual(["mac-one", "remote"]);

    await controller.selectTab("remote");
    expect(controller.urlDraft).toBe("https://remote.test/");
    await controller.closeTab("remote");
    expect(controller).toMatchObject({
      activeTargetId: "mac-one",
      urlDraft: "https://example.test/page",
      view: null,
    });
    expect(tabIds(controller)).toEqual(["mac-one"]);
    flushFrames();
    expectPresent(native, true, "mac-one");

    await controller.closeTab("mac-one");
    expect(controller).toMatchObject({ activeTargetId: null, tabs: [], urlDraft: "" });
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

  it("keeps a native tab visible beside a hovercard and tracks overlap as either surface moves", async () => {
    const { native, host, controller } = fixture();
    const stage = host.renderRoot.querySelector<HTMLElement>(".bp-stage")!;
    let stageRect = new DOMRect(600, 100, 500, 600);
    vi.spyOn(stage, "getBoundingClientRect").mockImplementation(() => stageRect);
    flushFrames();
    native.postMessage.mockClear();
    const card = document.createElement("div");
    let cardRect = new DOMRect(200, 200, 300, 200);
    vi.spyOn(card, "getBoundingClientRect").mockImplementation(() => cardRect);
    document.body.append(card);
    promoteToPopoverTopLayer(card, () => [card]);
    flushFrames();
    expect(native.postMessage).not.toHaveBeenCalled();

    // Only the edge overlaps; center-point hit testing alone cannot catch it.
    cardRect = new DOMRect(400, 200, 300, 200);
    flushFrames();
    expectPresent(native, false);
    stageRect = new DOMRect(700, 100, 500, 600);
    controller.native.presentation.update();
    flushFrames();
    flushFrames();
    expectPresent(native, true);

    cardRect = new DOMRect(650, 200, 300, 200);
    flushFrames();
    expectPresent(native, false);
    card.remove();
    await Promise.resolve();
    flushFrames();
    expectPresent(native, true);
  });

  it("deduplicates presentations, hides a covered stage, and restores after occlusion", () => {
    const { native, controller } = fixture();
    flushFrames();
    native.postMessage.mockClear();
    controller.native.presentation.update();
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("scroll"));
    flushFrames();
    expect(native.postMessage).not.toHaveBeenCalled();
    const release = acquireNativeOverlayOcclusion();
    expectPresent(native, false);
    release();
    flushFrames();
    expectPresent(native, true);
    setHit(document.body);
    window.dispatchEvent(new Event("resize"));
    flushFrames();
    expectPresent(native, false);
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
      setHit(first.host.renderRoot.querySelector(".bp-stage"));

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

  it("discards an inspect reply from the document preceding a native URL change", async () => {
    vi.useFakeTimers();
    const { native, controller, request } = fixture();
    controller.setMode("inspect");
    await flushBrowserResponses();
    controller.handleOverlayPointerMove(createPointer(25, 50));
    await vi.advanceTimersByTimeAsync(120);
    expect(native.messages()).toContainEqual({ type: "inspect", tabId: "mac-one", x: 25, y: 50 });
    expect(controller.inspected?.name).toBe("Save");
    expect(request).not.toHaveBeenCalled();
    const reply = createDeferred<{ ok: true; node: ReturnType<typeof createInspectedNode> }>();
    native.postMessage.mockImplementationOnce(() => reply.promise);
    controller.handleOverlayPointerMove(createPointer(25, 50));
    await vi.advanceTimersByTimeAsync(120);
    expect(native.messages().at(-1)).toMatchObject({ type: "inspect" });
    native.publish([nativeTab("mac-one", "https://example.test/new")]);
    expect(controller.mode).toBe("interact");
    expect(controller.view).toBeNull();
    expect(controller.urlDraft).toBe("https://example.test/new");
    reply.resolve({ ok: true, node: createInspectedNode("Old document") });
    await flushBrowserResponses();
    expect(controller.inspected).toBeNull();
    expect(controller.inspectPointer).toBeNull();
  });

  it("releases a slow remote download immediately when another tab is selected", async () => {
    const { native, controller } = fixture();
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
    expectPresent(native, true, "mac-one");
  });
});
