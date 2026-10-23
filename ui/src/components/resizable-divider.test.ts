/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "./resizable-divider.ts";

let container: HTMLDivElement;

async function renderDivider() {
  const root = document.createElement("div");
  const divider = document.createElement("resizable-divider");
  Object.assign(divider, { splitRatio: 0.6, minRatio: 0.4, maxRatio: 0.7 });
  divider.label = "Resize sidebar";
  root.append(divider);
  mountSolid(() => root, { container });
  root.getBoundingClientRect = vi.fn(() => new DOMRect(0, 0, 400, 0));
  await divider.updateComplete;
  vi.advanceTimersToNextFrame();
  return divider;
}

function key(target: EventTarget, name: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: name,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event;
}

async function dragFixture(start = true) {
  const divider = await renderDivider();
  const resized = vi.fn();
  const resizeStarted = vi.fn();
  const resizeEnded = vi.fn();
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  divider.setPointerCapture = setPointerCapture;
  divider.releasePointerCapture = releasePointerCapture;
  divider.hasPointerCapture = vi.fn(() => true);
  container.addEventListener("resize-start", resizeStarted);
  divider.addEventListener("resize", resized);
  divider.addEventListener("resize-end", resizeEnded);
  if (start) {
    dispatchPointer(divider, "pointerdown", 100);
  }
  return { divider, resized, resizeStarted, resizeEnded, setPointerCapture, releasePointerCapture };
}

function dispatchPointer(target: EventTarget, type: string, clientX: number, pointerId = 7) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      cancelable: true,
      clientX,
      pointerId,
      pointerType: "touch",
    }),
  );
}

function expectLastResizeRatio(resized: ReturnType<typeof vi.fn>, splitRatio: number) {
  expect(resized.mock.lastCall?.[0]).toMatchObject({ detail: { splitRatio } });
}

function calls(...mocks: ReturnType<typeof vi.fn>[]) {
  return mocks.map((mock) => mock.mock.calls.length);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(() => {
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("exposes the supplied split without measuring until a resize gesture", async () => {
  const divider = await renderDivider();
  const measureRatio = vi.fn(() => 0.55);
  divider.measureRatio = measureRatio;
  await divider.updateComplete;
  expect(divider.getAttribute("role")).toBe("separator");
  expect(divider.getAttribute("tabindex")).toBe("0");
  expect(divider.getAttribute("aria-label")).toBe("Resize sidebar");
  expect(divider.getAttribute("aria-orientation")).toBe("vertical");
  expect(
    ["min", "max", "now"].map((suffix) => divider.getAttribute(`aria-value${suffix}`)),
  ).toEqual(["40", "70", "60"]);

  divider.splitRatio = 0.65;
  await divider.updateComplete;
  expect(divider.getAttribute("aria-valuenow")).toBe("65");
  divider.label = "Resize panel";
  await divider.updateComplete;
  expect(divider.getAttribute("aria-label")).toBe("Resize panel");
  expect(divider.getAttribute("aria-valuenow")).toBe("65");
  expect(measureRatio).not.toHaveBeenCalled();
  key(divider, "Tab");
  expect(measureRatio).not.toHaveBeenCalled();
  key(divider, "ArrowLeft");
  expect(measureRatio).toHaveBeenCalledOnce();
  expect(divider.getAttribute("aria-valuenow")).toBe("53");
});

it("updates the fallback separator label when the locale changes", async () => {
  i18n.registerTranslation("pt-BR", {
    common: { resizeSplitView: "Redimensionar visualização dividida" },
  });
  await i18n.setLocale("en");
  try {
    const divider = document.createElement("resizable-divider");
    mountSolid(() => divider, { container });
    await divider.updateComplete;
    expect(divider.getAttribute("aria-label")).toBe("Resize split view");
    await i18n.setLocale("pt-BR");
    flush();
    expect(divider.getAttribute("aria-label")).toBe("Redimensionar visualização dividida");
  } finally {
    await i18n.setLocale("en");
  }
});

it.each([
  ["vertical", "ArrowLeft", "ArrowRight"],
  ["horizontal", "ArrowUp", "ArrowDown"],
] as const)("resizes %s with arrows, Home, and End", async (orientation, decrease, increase) => {
  const divider = await renderDivider();
  const resized = vi.fn();
  const resizeStarted = vi.fn();
  divider.orientation = orientation;
  divider.addEventListener("resize", resized);
  divider.addEventListener("resize-start", resizeStarted);
  await divider.updateComplete;
  expect(divider.getAttribute("aria-orientation")).toBe(orientation);
  for (const [name, shift, ratio] of [
    [decrease, false, 0.58],
    [increase, true, 0.65],
    ["Home", false, 0.4],
    ["End", false, 0.7],
  ] as const) {
    expect(key(divider, name, shift).defaultPrevented).toBe(true);
    expectLastResizeRatio(resized, ratio);
  }
  expect(resizeStarted).not.toHaveBeenCalled();
});

it("keeps dragging owned by the initiating pointer", async () => {
  const { divider, resized, resizeStarted, resizeEnded, setPointerCapture, releasePointerCapture } =
    await dragFixture();
  expect(document.activeElement).not.toBe(divider);
  expect([...divider.classList]).toEqual(["dragging"]);
  expect(setPointerCapture).toHaveBeenCalledWith(7);
  expect(resizeStarted).toHaveBeenCalledOnce();
  expect(resizeStarted.mock.calls[0]?.[0]).toMatchObject({
    target: divider,
    bubbles: true,
    composed: true,
  });
  expect(resized).not.toHaveBeenCalled();
  dispatchPointer(divider, "pointerdown", 180, 8);
  dispatchPointer(document, "pointermove", 220, 8);
  dispatchPointer(document, "pointercancel", 220, 8);
  dispatchPointer(document, "pointerup", 220, 8);
  expect(setPointerCapture).toHaveBeenCalledTimes(1);
  expect(calls(resizeStarted, resized, resizeEnded)).toEqual([1, 0, 0]);
  expect([...divider.classList]).toEqual(["dragging"]);

  dispatchPointer(document, "pointermove", 220, 7);
  dispatchPointer(document, "pointermove", 120, 7);
  expect(resized).not.toHaveBeenCalled();
  vi.advanceTimersToNextFrame();
  expectLastResizeRatio(resized, 0.65);
  expect(calls(resized, resizeEnded)).toEqual([1, 0]);

  dispatchPointer(document, "pointerup", 220, 7);
  expect(resizeEnded.mock.lastCall?.[0].detail).toEqual({ splitRatio: 0.65 });
  expect(resizeEnded).toHaveBeenCalledTimes(1);
  expect([...divider.classList]).toEqual([]);
  expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  expect(resizeStarted).toHaveBeenCalledOnce();
});

it("stops dragging when the window loses focus", async () => {
  const { divider, resized, resizeEnded, releasePointerCapture } = await dragFixture();
  window.dispatchEvent(new Event("blur"));
  expect([...divider.classList]).toEqual([]);
  expect(releasePointerCapture).toHaveBeenCalledWith(7);
  expectLastResizeRatio(resizeEnded, 0.6);
  expect(resizeEnded).toHaveBeenCalledOnce();
  dispatchPointer(document, "pointermove", 220);
  dispatchPointer(document, "pointerup", 220);
  expect(calls(resized, resizeEnded)).toEqual([0, 1]);
});

it("ends only the owner gesture when pointer capture is lost", async () => {
  const { divider, resized, resizeEnded } = await dragFixture(false);
  const capturedPointers = new Set<number>();
  divider.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
  divider.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
  divider.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));

  dispatchPointer(divider, "pointerdown", 100, 7);
  dispatchPointer(document, "pointermove", 120, 7);
  dispatchPointer(divider, "lostpointercapture", 120, 8);
  expect([...divider.classList]).toEqual(["dragging"]);
  expect(calls(resized, resizeEnded)).toEqual([0, 0]);

  capturedPointers.delete(7);
  dispatchPointer(divider, "lostpointercapture", 120, 7);
  expectLastResizeRatio(resized, 0.65);
  expectLastResizeRatio(resizeEnded, 0.65);
  expect(resizeEnded).toHaveBeenCalledOnce();
  expect([...divider.classList]).toEqual([]);

  dispatchPointer(divider, "pointerdown", 120, 8);
  expect(capturedPointers.has(8)).toBe(true);
  dispatchPointer(document, "pointerup", 120, 8);
  expect(resizeEnded).toHaveBeenCalledTimes(2);
});

it("commits the final pointer position when disconnected", async () => {
  const { divider, resized, resizeEnded } = await dragFixture();
  dispatchPointer(document, "pointermove", 120);
  divider.remove();
  // The bridge preserves roots during same-turn reparenting.
  await Promise.resolve();

  expectLastResizeRatio(resized, 0.65);
  expectLastResizeRatio(resizeEnded, 0.65);
  expect(resizeEnded).toHaveBeenCalledOnce();
  dispatchPointer(document, "pointerup", 120);
  expect(resizeEnded).toHaveBeenCalledOnce();
  key(divider, "ArrowRight");
  dispatchPointer(divider, "pointerdown", 100);
  expect(calls(resized, resizeEnded)).toEqual([1, 1]);
  expect(divider.classList.contains("dragging")).toBe(false);
});
