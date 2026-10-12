/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "./resizable-divider.ts";

let container: HTMLDivElement;

function nextFrame() {
  vi.advanceTimersToNextFrame();
}

async function renderDivider() {
  const root = document.createElement("div");
  root.id = "split-root";
  const divider = document.createElement("resizable-divider");
  divider.splitRatio = 0.6;
  divider.minRatio = 0.4;
  divider.maxRatio = 0.7;
  divider.label = "Resize sidebar";
  root.append(divider);
  mountSolid(() => root, { container });
  expect(root?.id).toBe("split-root");
  expect(divider?.tagName.toLowerCase()).toBe("resizable-divider");
  if (!root || !divider) {
    throw new Error("expected resizable divider fixture");
  }

  root.getBoundingClientRect = vi.fn(() => ({
    bottom: 0,
    height: 0,
    left: 0,
    right: 400,
    top: 0,
    width: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }));

  await divider.updateComplete;
  nextFrame();
  return divider;
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
  const event = resized.mock.lastCall?.[0] as CustomEvent<{ splitRatio: number }> | undefined;
  expect(event?.detail.splitRatio).toBe(splitRatio);
}

describe("resizable-divider", () => {
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
    expect(divider.getAttribute("aria-valuemin")).toBe("40");
    expect(divider.getAttribute("aria-valuemax")).toBe("70");
    expect(divider.getAttribute("aria-valuenow")).toBe("60");

    divider.splitRatio = 0.65;
    await divider.updateComplete;

    expect(divider.getAttribute("aria-valuenow")).toBe("65");

    divider.label = "Resize panel";
    await divider.updateComplete;

    expect(divider.getAttribute("aria-label")).toBe("Resize panel");
    expect(divider.getAttribute("aria-valuenow")).toBe("65");
    expect(measureRatio).not.toHaveBeenCalled();

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    expect(measureRatio).not.toHaveBeenCalled();
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(measureRatio).toHaveBeenCalledOnce();
    expect(divider.getAttribute("aria-valuenow")).toBe("53");
  });

  it("updates the fallback separator label when the locale changes", async () => {
    i18n.registerTranslation("pt-BR", {
      common: {
        resizeSplitView: "Redimensionar visualização dividida",
      },
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

  it("resizes with keyboard arrows, Home, and End", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    const resizeStarted = vi.fn();
    divider.addEventListener("resize", resized);
    divider.addEventListener("resize-start", resizeStarted);

    const arrowLeft = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
    });
    divider.dispatchEvent(arrowLeft);
    expect(arrowLeft.defaultPrevented).toBe(true);
    expectLastResizeRatio(resized, 0.58);

    const arrowRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    divider.dispatchEvent(arrowRight);
    expect(arrowRight.defaultPrevented).toBe(true);
    expectLastResizeRatio(resized, 0.65);

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expectLastResizeRatio(resized, 0.4);

    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expectLastResizeRatio(resized, 0.7);
    expect(resizeStarted).not.toHaveBeenCalled();
  });

  it("supports horizontal semantics and Up/Down keyboard resizing", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    const resizeStarted = vi.fn();
    divider.orientation = "horizontal";
    divider.addEventListener("resize", resized);
    divider.addEventListener("resize-start", resizeStarted);
    await divider.updateComplete;

    expect(divider.getAttribute("aria-orientation")).toBe("horizontal");
    divider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expectLastResizeRatio(resized, 0.58);
    divider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
    );
    expectLastResizeRatio(resized, 0.65);
    expect(resizeStarted).not.toHaveBeenCalled();
  });

  it("keeps dragging owned by the initiating pointer", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    const resizeStarted = vi.fn();
    const resizeEnded = vi.fn();
    const setPointerCapture = vi.fn();
    const releasePointerCapture = vi.fn();
    const hasPointerCapture = vi.fn(() => true);
    divider.setPointerCapture = setPointerCapture;
    divider.releasePointerCapture = releasePointerCapture;
    divider.hasPointerCapture = hasPointerCapture;
    container.addEventListener("resize-start", resizeStarted);
    divider.addEventListener("resize", resized);
    divider.addEventListener("resize-end", resizeEnded);

    dispatchPointer(divider, "pointerdown", 100);
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
    expect(resizeStarted).toHaveBeenCalledOnce();
    expect(resized).not.toHaveBeenCalled();
    expect(resizeEnded).not.toHaveBeenCalled();
    expect([...divider.classList]).toEqual(["dragging"]);

    dispatchPointer(document, "pointermove", 220, 7);
    dispatchPointer(document, "pointermove", 120, 7);
    expect(resized).not.toHaveBeenCalled();
    nextFrame();
    expectLastResizeRatio(resized, 0.65);
    expect(resized).toHaveBeenCalledTimes(1);
    expect(resizeEnded).not.toHaveBeenCalled();

    dispatchPointer(document, "pointerup", 220, 7);
    const endEvent = resizeEnded.mock.lastCall?.[0] as
      | CustomEvent<{ splitRatio: number }>
      | undefined;
    expect(endEvent?.detail).toEqual({ splitRatio: 0.65 });
    expect(resizeEnded).toHaveBeenCalledTimes(1);
    expect([...divider.classList]).toEqual([]);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(releasePointerCapture).toHaveBeenCalledTimes(1);
    expect(resizeStarted).toHaveBeenCalledOnce();
  });

  it("stops dragging when the window loses focus", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    const resizeEnded = vi.fn();
    const releasePointerCapture = vi.fn();
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = releasePointerCapture;
    divider.hasPointerCapture = vi.fn(() => true);
    divider.addEventListener("resize", resized);
    divider.addEventListener("resize-end", resizeEnded);

    dispatchPointer(divider, "pointerdown", 100);
    window.dispatchEvent(new Event("blur"));

    expect([...divider.classList]).toEqual([]);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expectLastResizeRatio(resizeEnded, 0.6);
    expect(resizeEnded).toHaveBeenCalledOnce();
    dispatchPointer(document, "pointermove", 220);
    dispatchPointer(document, "pointerup", 220);
    expect(resized).not.toHaveBeenCalled();
    expect(resizeEnded).toHaveBeenCalledOnce();
  });

  it("ends only the owner gesture when pointer capture is lost", async () => {
    const divider = await renderDivider();
    const resized = vi.fn();
    const resizeEnded = vi.fn();
    const capturedPointers = new Set<number>();
    divider.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
    divider.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
    divider.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
    divider.addEventListener("resize", resized);
    divider.addEventListener("resize-end", resizeEnded);

    dispatchPointer(divider, "pointerdown", 100, 7);
    dispatchPointer(document, "pointermove", 120, 7);
    dispatchPointer(divider, "lostpointercapture", 120, 8);

    expect([...divider.classList]).toEqual(["dragging"]);
    expect(resized).not.toHaveBeenCalled();
    expect(resizeEnded).not.toHaveBeenCalled();

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
    const divider = await renderDivider();
    const resized = vi.fn();
    const resizeEnded = vi.fn();
    divider.setPointerCapture = vi.fn();
    divider.releasePointerCapture = vi.fn();
    divider.addEventListener("resize", resized);
    divider.addEventListener("resize-end", resizeEnded);

    dispatchPointer(divider, "pointerdown", 100);
    dispatchPointer(document, "pointermove", 120);
    divider.remove();
    // The bridge preserves roots during same-turn reparenting.
    await Promise.resolve();

    expectLastResizeRatio(resized, 0.65);
    expectLastResizeRatio(resizeEnded, 0.65);
    expect(resizeEnded).toHaveBeenCalledOnce();
    dispatchPointer(document, "pointerup", 120);
    expect(resizeEnded).toHaveBeenCalledOnce();
  });
});
