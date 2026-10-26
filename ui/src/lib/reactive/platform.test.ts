import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
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

it("tracks media changes until its owner is disposed", async () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", () => media);
  const values: boolean[] = [];
  let matches!: () => boolean;
  const dispose = createRoot((stop) => {
    matches = createMediaQuery("(prefers-reduced-motion: reduce)");
    createEffect(matches, (value) => {
      values.push(value);
    });
    return stop;
  });
  onTestFinished(dispose);
  await waitForSolid(() => expect(values.at(-1)).toBe(true));
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  flush();
  expect(matches()).toBe(false);
  dispose();
  media.matches = true;
  media.dispatchEvent(new Event("change"));
  flush();
  expect(matches()).toBe(false);
  expect(values.at(-1)).toBe(false);
});

it.each([false, true])(
  "uses the %s fallback when media queries are unavailable",
  async (fallback) => {
    vi.stubGlobal("matchMedia", undefined);
    let matches!: () => boolean;
    const dispose = createRoot((stop) => {
      matches = createMediaQuery("(pointer: fine)", fallback);
      return stop;
    });
    onTestFinished(dispose);
    await waitForSolid(() => expect(matches()).toBe(fallback));
  },
);

it("tracks document visibility until its owner is disposed", async () => {
  let visibility: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  let visible!: () => boolean;
  const dispose = createRoot((stop) => {
    visible = createDocumentVisibility();
    return stop;
  });
  onTestFinished(dispose);
  // Visibility can change between component creation and listener setup.
  visibility = "visible";
  await waitForSolid(() => expect(visible()).toBe(true));
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  flush();
  await waitForSolid(() => expect(visible()).toBe(false));
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  flush();
  expect(visible()).toBe(true);
  dispose();
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  flush();
  expect(visible()).toBe(true);
});

it("shares exact media queries while preserving fallback and independent lifetimes", () => {
  const reduced = Object.assign(new EventTarget(), { matches: true });
  const pointer = Object.assign(new EventTarget(), { matches: false });
  const matchMedia = vi.fn((query: string) => (query === "(pointer: fine)" ? pointer : reduced));
  vi.stubGlobal("matchMedia", matchMedia);
  const subscribe = vi.spyOn(reduced, "addEventListener");
  const unsubscribe = vi.spyOn(reduced, "removeEventListener");
  function reader(query: string, fallback: boolean) {
    const root = createRoot((dispose) => ({ read: createMediaQuery(query, fallback), dispose }));
    onTestFinished(root.dispose);
    return root;
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
  const replacement = reader("(prefers-reduced-motion: reduce)", false);
  flush();
  expect(replacement.read()).toBe(true);
  expect(matchMedia).toHaveBeenCalledTimes(3);
  expect(subscribe).toHaveBeenCalledTimes(2);
});

it("shares visibility delivery without keeping disposed owners live", () => {
  let state: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  const subscribe = vi.spyOn(document, "addEventListener");
  const unsubscribe = vi.spyOn(document, "removeEventListener");
  function reader() {
    const root = createRoot((dispose) => ({ read: createDocumentVisibility(), dispose }));
    onTestFinished(root.dispose);
    return root;
  }
  const first = reader();
  const second = reader();
  state = "hidden";
  flush();
  expect([first.read(), second.read()]).toEqual([false, false]);
  expect(subscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  first.dispose();
  state = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  flush();
  expect([first.read(), second.read()]).toEqual([false, true]);
  expect(unsubscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
  second.dispose();
  expect(unsubscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
  state = "hidden";
  const replacement = reader();
  flush();
  expect(replacement.read()).toBe(false);
  expect(subscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(2);
});

it("shares synchronous visibility events with reactive readers and independent registrations", () => {
  let state: DocumentVisibilityState = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => state);
  const subscribe = vi.spyOn(document, "addEventListener");
  const unsubscribe = vi.spyOn(document, "removeEventListener");
  const notify = vi.fn();
  const stops = Array.from({ length: 100 }, () => subscribeDocumentVisibility(document, notify));
  onTestFinished(() => stops.forEach((stop) => stop()));
  expect(notify).not.toHaveBeenCalled();
  const reactive = createRoot((dispose) => ({ read: createDocumentVisibility(), dispose }));
  onTestFinished(reactive.dispose);
  flush();
  expect(reactive.read()).toBe(true);
  expect(subscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);

  state = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(notify.mock.calls).toEqual(Array.from({ length: 100 }, () => [false]));
  flush();
  expect(reactive.read()).toBe(false);
  notify.mockClear();
  stops.slice(0, 99).forEach((stop) => stop());
  reactive.dispose();
  expect(unsubscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(0);
  // The native event remains observable even when its current value is unchanged.
  document.dispatchEvent(new Event("visibilitychange"));
  expect(notify).toHaveBeenCalledExactlyOnceWith(false);
  stops[99]!();
  expect(unsubscribe.mock.calls.filter(([type]) => type === "visibilitychange")).toHaveLength(1);
});

it("shares synchronous media reads without retaining an idle change listener", () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  const matchMedia = vi.fn(() => media);
  vi.stubGlobal("matchMedia", matchMedia);
  const subscribe = vi.spyOn(media, "addEventListener");
  const unsubscribe = vi.spyOn(media, "removeEventListener");
  const source = createRoot((dispose) => ({
    ...createMediaQuerySource("(pointer: fine)"),
    dispose,
  }));
  onTestFinished(source.dispose);
  const reactive = createRoot((dispose) => ({
    read: createMediaQuery("(pointer: fine)"),
    dispose,
  }));
  onTestFinished(reactive.dispose);
  expect([source.read(), reactive.read()]).toEqual([true, false]);
  expect(matchMedia).toHaveBeenCalledOnce();
  expect(subscribe).not.toHaveBeenCalled();
  flush();
  expect(reactive.read()).toBe(true);
  expect(subscribe).toHaveBeenCalledOnce();
  media.matches = false;
  media.dispatchEvent(new Event("change"));
  expect(source.read()).toBe(false);
  flush();
  expect(reactive.read()).toBe(false);
  reactive.dispose();
  expect(unsubscribe).toHaveBeenCalledOnce();
  media.matches = true;
  expect(source.read()).toBe(true);
  expect(subscribe).toHaveBeenCalledOnce();
  source.dispose();
  const replacement = createRoot((dispose) => {
    expect(createMediaQuerySource("(pointer: fine)").read()).toBe(true);
    return dispose;
  });
  onTestFinished(replacement);
  expect(matchMedia).toHaveBeenCalledTimes(2);
  expect(subscribe).toHaveBeenCalledOnce();
});

it("keeps duplicate synchronous media subscriptions independent and releases them on disposal", () => {
  const media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  const subscribe = vi.spyOn(media, "addEventListener");
  const unsubscribe = vi.spyOn(media, "removeEventListener");
  const first = createRoot((dispose) => ({
    ...createMediaQuerySource("(pointer: fine)"),
    dispose,
  }));
  const second = createRoot((dispose) => ({
    ...createMediaQuerySource("(pointer: fine)"),
    dispose,
  }));
  onTestFinished(first.dispose);
  onTestFinished(second.dispose);
  const listener = vi.fn();
  const stopFirst = first.subscribe(listener);
  first.subscribe(listener);
  second.subscribe(listener);
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
  expect([main.media(), main.visible(), frame.media(), frame.visible()]).toEqual([
    false,
    true,
    true,
    false,
  ]);
  expect(mainQuery).toHaveBeenCalledOnce();
  expect(frameQuery).toHaveBeenCalledOnce();
  frameMedia.matches = false;
  frameMedia.dispatchEvent(new Event("change"));
  flush();
  expect(main.media()).toBe(false);
  expect(frame.media()).toBe(false);
});
