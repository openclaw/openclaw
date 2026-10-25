import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createInitializationContext } from "../../pages/chat/chat-pane.test-support.ts";
import { createApplicationContextProvider } from "../../test-helpers/application-context.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { BROWSER_PANEL_TOGGLE_EVENT } from "../panel-toggle-contract.ts";
import { flushBrowserResponses } from "./browser-panel-controller-test-support.ts";
import {
  fakeNativeBrowser,
  mountSessionPanel,
  nativeTab,
  setupNativeBrowserPanelTests,
} from "./test-helpers/native-browser.ts";

const { controllerFixture, flushFrames, setHit } = setupNativeBrowserPanelTests();
const urlOf = (panel: Element) => panel.querySelector<HTMLInputElement>(".bp-url")?.value;
const createPanel = () =>
  Object.assign(document.createElement("openclaw-browser-panel"), {
    available: true,
    remoteAvailable: false,
    embedded: true,
    presented: true,
  });
it.each(["reconnect", "context"])("rebinds publications after %s", async (transition) => {
  const native = fakeNativeBrowser([nativeTab("mac-first")]);
  const first = createInitializationContext();
  const provider = createApplicationContextProvider(first);
  const panel = createPanel();
  provider.append(panel);
  mountSolid(() => provider);
  await panel.updateComplete;
  const viewport = panel.querySelector(".bp-viewport");
  native.publish([nativeTab("mac-queued", "https://example.test/queued")]);
  const pending = panel.updateComplete;
  if (transition === "reconnect") {
    panel.remove();
    await pending;
    provider.append(panel);
  } else {
    provider.setContext({ ...first, basePath: "/replacement" });
    await pending;
  }
  await panel.updateComplete;
  expect(panel.querySelector(".bp-viewport")).not.toBe(viewport);
  expect(panel.activeHostedTabId).toBe("mac-queued");
  expect(urlOf(panel)).toBe("https://example.test/queued");
  native.publish([nativeTab("mac-current", "https://example.test/current")]);
  await panel.updateComplete;
  expect(panel.activeHostedTabId).toBe("mac-current");
  expect(urlOf(panel)).toBe("https://example.test/current");
});

it("retains a pre-mount native open and retires its subscription and replies on disposal", async () => {
  const native = fakeNativeBrowser();
  const panel = createPanel();
  panel.handleToggleRequest(
    new CustomEvent("openclaw:browser-panel-toggle", {
      detail: { open: true, url: "https://example.test/before-mount", native: true },
    }),
  );
  await flushBrowserResponses();
  const mounted = mountSolid(() => panel);
  await panel.updateComplete;
  expect(urlOf(panel)).toBe("https://example.test/before-mount");
  expect(panel.querySelectorAll('[role="tab"]')).toHaveLength(1);
  const reply = createDeferred<{ ok: true }>();
  native.postMessage.mockImplementationOnce(() => reply.promise);
  panel.querySelector<HTMLButtonElement>('[aria-label="Reload"]')!.click();
  expect(native.messages().at(-1)).toMatchObject({ type: "reload" });
  const released = { type: "release-scope", scope: panel.dataset.nativeBrowserScope };
  mounted.unmount();
  await waitForSolid(() => expect(native.messages().at(-1)).toEqual(released));
  native.postMessage.mockClear();
  native.publish([nativeTab("mac-replacement")]);
  window.dispatchEvent(new Event("resize"));
  flushFrames();
  reply.reject(new Error("The disposed reload failed"));
  await flushBrowserResponses();
  expect(native.postMessage).not.toHaveBeenCalled();
  mountSolid(() => panel);
  await panel.updateComplete;
  expect(panel.activeHostedTabId).toBe("mac-replacement");
  expect(panel.querySelector(".bp-note--error")).toBeNull();
});

it.each([
  ["command", "current"],
  ["command", "session"],
  ["command", "selection"],
  ["command", "newer-command"],
  ["command", "hide-and-show"],
  ["presentation", "current"],
  ["presentation", "selection"],
  ["presentation", "renew"],
  ["presentation", "hide-and-show"],
])("keeps native %s errors with their owner: %s", async (kind, owner) => {
  const native = fakeNativeBrowser(
    kind === "command"
      ? ["first", "other", "second"].map((id) =>
          nativeTab(`mac-${id}`, undefined, `agent:main:${id === "second" ? id : "first"}`),
        )
      : [nativeTab("mac-one"), nativeTab("mac-two")],
  );
  const panel = kind === "command" ? await mountSessionPanel("agent:main:first") : null;
  const fixture = panel ? null : controllerFixture();
  const reply = createDeferred<{ ok: true }>();
  native.postMessage.mockImplementationOnce(() => reply.promise);
  const reload = () => panel?.querySelector<HTMLButtonElement>('[aria-label="Reload"]')?.click();
  (panel ? reload : flushFrames)();
  expect(native.messages().at(-1)).toEqual(
    panel
      ? { type: "reload", tabId: "mac-first" }
      : expect.objectContaining({ type: "present", tabId: "mac-one" }),
  );
  if (panel && owner === "session") {
    panel.sessionKey = "agent:main:second";
    await panel.updateComplete;
  } else if (panel && owner === "selection") {
    panel.selectHostedTab("mac-other");
  } else if (owner === "newer-command") {
    reload();
  } else if (fixture && (owner === "selection" || owner === "renew")) {
    await fixture.controller.selectTab(owner === "selection" ? "mac-two" : "mac-one");
  } else if (owner === "hide-and-show") {
    for (const open of [false, true]) {
      if (panel) {
        panel.presented = open;
        await panel.updateComplete;
      } else if (fixture) {
        fixture.host.open = open;
        fixture.controller.native.presentation.update();
      }
    }
  }
  if (fixture) {
    flushFrames();
  }
  const message = `The earlier ${kind === "command" ? "reload" : kind} failed`;
  reply.reject(new Error(message));
  await flushBrowserResponses();
  await panel?.updateComplete;
  const error =
    panel?.querySelector(".bp-note--error")?.textContent ?? fixture?.controller.errorText;
  expect(error ?? null).toEqual(owner === "current" ? expect.stringContaining(message) : null);
});

it("shares geometry observers and global listeners across native stages", () => {
  fakeNativeBrowser([nativeTab("mac-one")]);
  const resize = vi.fn(function () {
    return { observe() {}, unobserve() {}, disconnect() {} };
  });
  const intersection = vi.fn(function () {
    return { observe() {}, unobserve() {}, disconnect() {} };
  });
  vi.stubGlobal("ResizeObserver", resize);
  vi.stubGlobal("IntersectionObserver", intersection);
  const addWindow = vi.spyOn(window, "addEventListener");
  const addDocument = vi.spyOn(document, "addEventListener");
  const fixtures = Array.from({ length: 20 }, () => controllerFixture());
  flushFrames();
  expect(resize).toHaveBeenCalledTimes(1);
  expect(intersection).toHaveBeenCalledTimes(1);
  expect(addWindow.mock.calls.filter(([type]) => type === "resize")).toHaveLength(1);
  expect(
    addWindow.mock.calls.filter(([type]) => type === "openclaw:native-browser-state"),
  ).toHaveLength(1);
  expect(
    addDocument.mock.calls.filter(([type, , capture]) => type === "scroll" && capture === true),
  ).toHaveLength(1);
  expect(new Set(fixtures.map(({ controller }) => controller.native.presentation.scope)).size).toBe(
    20,
  );
});

it("repositions native stages on non-bubbling ancestor scroll", () => {
  const native = fakeNativeBrowser([nativeTab("mac-one")]);
  const first = controllerFixture();
  const second = controllerFixture();
  const scroller = document.createElement("div");
  document.body.append(scroller);
  scroller.append(first.host.renderRoot);
  let bounds = new DOMRect(30, 40, 300, 200);
  vi.spyOn(first.host.stage, "getBoundingClientRect").mockImplementation(() => bounds);
  setHit(first.host.stage);
  flushFrames();
  native.postMessage.mockClear();
  bounds = new DOMRect(30, 10, 300, 200);
  scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
  flushFrames();
  expect(native.messages()).toContainEqual({
    type: "present",
    scope: first.controller.native.presentation.scope,
    tabId: "mac-one",
    rect: { x: 30, y: 10, width: 300, height: 200 },
    visible: true,
  });
  expect(
    native
      .messages()
      .some(
        (message) =>
          message.type === "present" &&
          message.scope === second.controller.native.presentation.scope &&
          message.visible,
      ),
  ).toBe(false);
});

it("omits embedded toggle listeners and synchronously follows changes to embedding", async () => {
  fakeNativeBrowser([nativeTab("mac-one")]);
  const resize = vi.fn();
  const intersection = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class extends ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        super(callback);
        resize();
      }
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class extends IntersectionObserver {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        super(callback, options);
        intersection();
      }
    },
  );
  const add = vi.spyOn(window, "addEventListener");
  const remove = vi.spyOn(window, "removeEventListener");
  const panels = [];
  for (let index = 0; index < 8; index += 1) {
    panels.push(await mountSessionPanel(""));
  }
  expect(resize).toHaveBeenCalledTimes(1);
  expect(intersection).toHaveBeenCalledTimes(1);
  expect(add.mock.calls.filter(([type]) => type === BROWSER_PANEL_TOGGLE_EVENT)).toHaveLength(0);
  const panel = panels[0]!;
  panel.embedded = false;
  expect(add.mock.calls.filter(([type]) => type === BROWSER_PANEL_TOGGLE_EVENT)).toHaveLength(1);
  window.dispatchEvent(new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, { detail: { open: true } }));
  expect(panel.browserPanelIsOpen()).toBe(true);
  panel.embedded = true;
  expect(remove.mock.calls.filter(([type]) => type === BROWSER_PANEL_TOGGLE_EVENT)).toHaveLength(1);
  window.dispatchEvent(new CustomEvent(BROWSER_PANEL_TOGGLE_EVENT, { detail: { open: false } }));
  expect(panel.browserPanelIsOpen()).toBe(true);
});
