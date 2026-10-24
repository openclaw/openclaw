import { createEffect, createRoot, flush } from "solid-js";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createDocumentVisibility, createMediaQuery } from "./platform.ts";

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
