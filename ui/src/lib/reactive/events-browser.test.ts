import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserHistory } from "../../app/browser.ts";
import {
  readNativeBrowserState,
  subscribeNativeBrowserState,
} from "../../app/native-browser-bridge.ts";
import { recordLobsterVisit } from "../../components/lobster-dex.ts";
import { publishTranscriptScroll } from "../../pages/chat/components/chat-transcript-scroll-events.ts";
import { acquireNativeOverlayOcclusion } from "../native-overlay-occlusion.ts";
import {
  projectBrowserHistory,
  projectLobsterdex,
  projectNativeBrowserState,
  projectNativeOverlayOcclusion,
  projectTranscriptScroll,
  type NativeBrowserSource,
} from "./events-browser.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState({}, "", "/");
});

function nativeBridge() {
  vi.stubGlobal("webkit", { messageHandlers: { openclawBrowser: { postMessage: vi.fn() } } });
}

describe("browser projections", () => {
  it("rejects late native deliveries before they can replace admitted current state", () => {
    const callbacks: Array<Parameters<NativeBrowserSource["subscribe"]>[0]> = [];
    const createSource = (): NativeBrowserSource => ({
      read: () => ({ revision: 1, tabs: [] }),
      subscribe: (listener) => {
        callbacks.push(listener);
        return () => {};
      },
    });
    const first = createSource();
    const second = createSource();
    const projection = projectNativeBrowserState(first);
    cleanups.push(projection.dispose);
    const release = projection.subscribe(() => {});
    projection.replaceSource(second);
    callbacks[1]!({ revision: 3, tabs: [] });
    expect(projection.read()?.revision).toBe(3);
    callbacks[0]!({ revision: 2, tabs: [] });
    expect(projection.read()?.revision).toBe(3);
    release();
    callbacks[1]!({ revision: 4, tabs: [] });
    expect(projection.read()?.revision).toBe(1);
  });

  it("reads actual history and shares a popstate listener across consumers", () => {
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const projection = projectBrowserHistory(createBrowserHistory());
    cleanups.push(projection.dispose);
    expect(projection.read().pathname).toBe("/");
    expect(add.mock.calls.filter(([event]) => event === "popstate")).toHaveLength(0);
    const first = vi.fn();
    const releaseFirst = projection.subscribe(first);
    const releaseSecond = projection.subscribe(() => {});
    expect(add.mock.calls.filter(([event]) => event === "popstate")).toHaveLength(1);
    window.history.replaceState({}, "", "/chat?pane=one#message");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(projection.read()).toEqual({ pathname: "/chat", search: "?pane=one", hash: "#message" });
    expect(first).toHaveBeenCalledOnce();
    releaseFirst();
    expect(remove.mock.calls.filter(([event]) => event === "popstate")).toHaveLength(0);
    releaseSecond();
    expect(remove.mock.calls.filter(([event]) => event === "popstate")).toHaveLength(1);
    projection.replaceSource(createBrowserHistory());
    projection.dispose();
    window.history.replaceState({}, "", "/late");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(projection.read().pathname).toBe("/chat");
  });

  it("uses admitted native notifications even before the host rewrites its cached global", () => {
    nativeBridge();
    vi.stubGlobal("__OPENCLAW_NATIVE_BROWSER__", { revision: 1, tabs: [] });
    const projection = projectNativeBrowserState();
    cleanups.push(projection.dispose);
    expect(projection.read()?.revision).toBe(1);
    const receive = vi.fn();
    const release = projection.subscribe(receive);
    window.dispatchEvent(
      new CustomEvent("openclaw:native-browser-state", { detail: { revision: 2, tabs: [] } }),
    );
    expect(projection.read()?.revision).toBe(2);
    window.dispatchEvent(
      new CustomEvent("openclaw:native-browser-state", { detail: { revision: 2, tabs: [] } }),
    );
    expect(receive).toHaveBeenCalledOnce();
    projection.replaceSource({
      read: readNativeBrowserState,
      subscribe: subscribeNativeBrowserState,
    });
    expect(projection.read()?.revision).toBe(1);
    release();
    projection.dispose();
    window.dispatchEvent(
      new CustomEvent("openclaw:native-browser-state", { detail: { revision: 3, tabs: [] } }),
    );
    expect(projection.read()?.revision).toBe(1);
  });

  it("samples native occlusion and retains one observer while consumers remain", () => {
    nativeBridge();
    const releaseOverlay = acquireNativeOverlayOcclusion();
    cleanups.push(releaseOverlay);
    const projection = projectNativeOverlayOcclusion({ getBounds: () => null });
    cleanups.push(projection.dispose);
    expect(projection.read()).toBe(true);
    const receive = vi.fn();
    const releaseFirst = projection.subscribe(receive);
    const releaseSecond = projection.subscribe(() => {});
    receive.mockClear();
    releaseOverlay();
    expect(projection.read()).toBe(false);
    expect(receive).toHaveBeenCalledOnce();
    releaseFirst();
    projection.replaceSource({ getBounds: () => new DOMRect(0, 0, 10, 10) });
    const nextOverlay = acquireNativeOverlayOcclusion();
    expect(projection.read()).toBe(true);
    releaseSecond();
    projection.dispose();
    nextOverlay();
    expect(projection.read()).toBe(true);
  });

  it("reads the browser-local dex and retires both storage and local event observers", () => {
    const projection = projectLobsterdex();
    cleanups.push(projection.dispose);
    expect(projection.read().size).toBe(0);
    const changed = vi.fn();
    const release = projection.subscribe(changed);
    recordLobsterVisit("synthetic-red", { name: "Red" });
    expect(projection.read().get("synthetic-red")?.name).toBe("Red");
    expect(changed).toHaveBeenCalledOnce();
    localStorage.setItem(
      "openclaw.control.lobsterdex.v1",
      JSON.stringify({ "synthetic-blue": { name: "Blue" } }),
    );
    const storageEvent = new StorageEvent("storage", { key: "openclaw.control.lobsterdex.v1" });
    // The shared runner installs memory storage rather than a jsdom Storage instance.
    Object.defineProperty(storageEvent, "storageArea", { value: localStorage });
    window.dispatchEvent(storageEvent);
    expect(projection.read().get("synthetic-blue")?.name).toBe("Blue");
    release();
    projection.dispose();
    changed.mockClear();
    recordLobsterVisit("synthetic-green");
    expect(changed).not.toHaveBeenCalled();
    expect(projection.read().has("synthetic-green")).toBe(false);
  });

  it("keeps transcript observations as ordered element-scoped events", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    const projection = projectTranscriptScroll(first);
    cleanups.push(projection.dispose);
    const receive = vi.fn();
    const release = projection.subscribe(receive);
    const event = { type: "composer-input" } as const;
    publishTranscriptScroll(first, event);
    publishTranscriptScroll(first, event);
    expect(receive.mock.calls).toEqual([[event], [event]]);
    projection.replaceSource(second);
    receive.mockClear();
    publishTranscriptScroll(first, event);
    expect(receive).not.toHaveBeenCalled();
    publishTranscriptScroll(second, event);
    expect(receive).toHaveBeenCalledOnce();
    release();
    projection.dispose();
    publishTranscriptScroll(second, event);
    expect(receive).toHaveBeenCalledOnce();
  });
});
