import { createRoot, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import {
  createDocumentVisibility,
  createMediaQuery,
  createMediaQuerySource,
  subscribeDocumentVisibility,
} from "./platform.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function owned<T>(create: () => T) {
  const root = createRoot((dispose) => ({ value: create(), dispose }));
  onTestFinished(root.dispose);
  return root;
}

it.each([false, true])("uses fallback %s without matchMedia", (fallback) => {
  vi.stubGlobal("matchMedia", undefined);
  const { value: matches } = owned(() => createMediaQuery("(pointer: fine)", fallback));
  flush();
  expect(matches()).toBe(fallback);
});

it("shares exact media queries while preserving fallback and independent lifetimes", () => {
  const reduced = Object.assign(new EventTarget(), { matches: true });
  const pointer = Object.assign(new EventTarget(), { matches: false });
  const matchMedia = vi.fn((query: string) => (query === "(pointer: fine)" ? pointer : reduced));
  vi.stubGlobal("matchMedia", matchMedia);
  const subscribe = vi.spyOn(reduced, "addEventListener");
  const unsubscribe = vi.spyOn(reduced, "removeEventListener");
  function reader(query: string, fallback: boolean) {
    const { value: read, dispose } = owned(() => createMediaQuery(query, fallback));
    return { read, dispose };
  }
  const first = reader("(prefers-reduced-motion: reduce)", false);
  const second = reader("(prefers-reduced-motion: reduce)", true);
  const separate = reader("(pointer: fine)", true);
  expect([first.read(), second.read(), separate.read()]).toEqual([false, true, true]);
  flush();
  expect([first.read(), second.read(), separate.read()]).toEqual([true, true, false]);
  expect(matchMedia).toHaveBeenCalledTimes(2);
  expect(subscribe).toHaveBeenCalledOnce();
  first.dispose();
  reduced.matches = false;
  reduced.dispatchEvent(new Event("change"));
  flush();
  expect([first.read(), second.read(), separate.read()]).toEqual([true, false, false]);
  expect(unsubscribe).not.toHaveBeenCalled();
  second.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  reduced.matches = true;
  reduced.dispatchEvent(new Event("change"));
  flush();
  expect(second.read()).toBe(false);
  const replacement = reader("(prefers-reduced-motion: reduce)", false);
  flush();
  expect(replacement.read()).toBe(true);
  expect(matchMedia).toHaveBeenCalledTimes(3);
  expect(subscribe).toHaveBeenCalledTimes(2);
});

it("shares synchronous visibility events with reactive readers and independent registrations", () => {
  let state: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  const subscribe = vi.spyOn(document, "addEventListener");
  const unsubscribe = vi.spyOn(document, "removeEventListener");
  const notify = vi.fn();
  const stops = Array.from({ length: 100 }, () => subscribeDocumentVisibility(document, notify));
  onTestFinished(() => stops.forEach((stop) => stop()));
  expect(notify).not.toHaveBeenCalled();
  const retired = owned(createDocumentVisibility);
  const reactive = owned(createDocumentVisibility);
  // Sample again at settlement, not only when the reader was created.
  state = "visible";
  flush();
  expect(retired.value()).toBe(true);
  expect(reactive.value()).toBe(true);
  expect(subscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);

  retired.dispose();
  state = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(notify.mock.calls).toEqual(Array.from({ length: 100 }, () => [false]));
  flush();
  expect(retired.value()).toBe(true);
  expect(reactive.value()).toBe(false);
  notify.mockClear();
  stops.slice(0, 99).forEach((stop) => stop());
  reactive.dispose();
  expect(unsubscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
  // The native event remains observable even when its current value is unchanged.
  document.dispatchEvent(new Event("visibilitychange"));
  expect(notify).toHaveBeenCalledExactlyOnceWith(false);
  stops[99]!();
  expect(unsubscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  state = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  flush();
  expect(reactive.value()).toBe(false);
  const replacement = owned(createDocumentVisibility);
  flush();
  expect(replacement.value()).toBe(true);
  expect(subscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(2);
});

it("shares synchronous media reads without retaining an idle change listener", () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  const matchMedia = vi.fn(() => media);
  vi.stubGlobal("matchMedia", matchMedia);
  const subscribe = vi.spyOn(media, "addEventListener");
  const unsubscribe = vi.spyOn(media, "removeEventListener");
  const source = owned(() => createMediaQuerySource("(pointer: fine)"));
  const reactive = owned(() => createMediaQuery("(pointer: fine)"));
  expect([source.value.read(), reactive.value()]).toEqual([true, false]);
  expect(matchMedia).toHaveBeenCalledOnce();
  expect(subscribe).not.toHaveBeenCalled();
  flush();
  expect(reactive.value()).toBe(true);
  expect(subscribe).toHaveBeenCalledOnce();
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(source.value.read()).toBe(false);
  flush();
  expect(reactive.value()).toBe(false);
  reactive.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  media.matches = true;
  expect(source.value.read()).toBe(true);
  expect(subscribe).toHaveBeenCalledOnce();
  source.dispose();
  const replacement = owned(() => createMediaQuerySource("(pointer: fine)"));
  expect(replacement.value.read()).toBe(true);
  expect(matchMedia).toHaveBeenCalledTimes(2);
  expect(subscribe).toHaveBeenCalledOnce();
});

it("keeps duplicate synchronous media subscriptions independent and releases them on disposal", () => {
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  const subscribe = vi.spyOn(media, "addEventListener");
  const unsubscribe = vi.spyOn(media, "removeEventListener");
  const first = owned(() => createMediaQuerySource("(pointer: fine)"));
  const second = owned(() => createMediaQuerySource("(pointer: fine)"));
  const listener = vi.fn();
  const stopFirst = first.value.subscribe(listener);
  first.value.subscribe(listener);
  second.value.subscribe(listener);
  expect(subscribe).toHaveBeenCalledOnce();
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  expect(listener.mock.calls).toEqual([[true], [true], [true]]);
  listener.mockClear();
  stopFirst();
  first.dispose();
  expect(unsubscribe).not.toHaveBeenCalled();
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(listener.mock.calls).toEqual([[false]]);
  second.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  media.dispatchEvent(new Event("change"));
  expect(listener).toHaveBeenCalledOnce();
});

it("keeps media and visibility subscriptions scoped to their document", () => {
  const mainDocument = document;
  const iframe = mainDocument.body.appendChild(mainDocument.createElement("iframe"));
  onTestFinished(() => iframe.remove());
  const frameDocument = iframe.contentDocument!;
  const mainMedia = Object.assign(new EventTarget(), { matches: false });
  const frameMedia = Object.assign(new EventTarget(), { matches: true });
  const mainQuery = vi.fn(() => mainMedia);
  const frameQuery = vi.fn(() => frameMedia);
  vi.stubGlobal("matchMedia", mainQuery);
  Object.defineProperty(iframe.contentWindow!, "matchMedia", {
    configurable: true,
    value: frameQuery,
  });
  vi.spyOn(mainDocument, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(frameDocument, "visibilityState", "get").mockReturnValue("hidden");
  function reader() {
    const root = createRoot((dispose) => ({
      media: createMediaQuery("(pointer: fine)"),
      visible: createDocumentVisibility(),
      dispose,
    }));
    onTestFinished(root.dispose);
    return root;
  }
  const main = reader();
  vi.stubGlobal("document", frameDocument);
  const frame = reader();
  vi.stubGlobal("document", mainDocument);
  flush();
  const values = [main.media(), main.visible(), frame.media(), frame.visible()];
  expect(values).toEqual([false, true, true, false]);
  expect(mainQuery).toHaveBeenCalledOnce();
  expect(frameQuery).toHaveBeenCalledOnce();
  frameMedia.matches = false;
  frameMedia.dispatchEvent(new Event("change"));
  flush();
  expect(main.media()).toBe(false);
  expect(frame.media()).toBe(false);
});
