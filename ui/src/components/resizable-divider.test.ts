/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "./resizable-divider.ts";

let container: HTMLDivElement;

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

async function dragFixture() {
  const divider = await renderDivider();
  const resized = vi.fn();
  const resizeStarted = vi.fn();
  const resizeEnded = vi.fn();
  divider.setPointerCapture = vi.fn();
  divider.releasePointerCapture = vi.fn();
  divider.hasPointerCapture = vi.fn(() => true);
  container.addEventListener("resize-start", resizeStarted);
  divider.addEventListener("resize", resized);
  divider.addEventListener("resize-end", resizeEnded);
  return { divider, resized, resizeStarted, resizeEnded };
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

    key(divider, "Tab");
    expect(measureRatio).not.toHaveBeenCalled();
    key(divider, "ArrowLeft");
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

    expect(key(divider, "ArrowLeft").defaultPrevented).toBe(true);
    expectLastResizeRatio(resized, 0.58);

    expect(key(divider, "ArrowRight", true).defaultPrevented).toBe(true);
    expectLastResizeRatio(resized, 0.65);

    key(divider, "Home");
    expectLastResizeRatio(resized, 0.4);

    key(divider, "End");
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
    key(divider, "ArrowUp");
    expectLastResizeRatio(resized, 0.58);
    key(divider, "ArrowDown", true);
    expectLastResizeRatio(resized, 0.65);
    expect(resizeStarted).not.toHaveBeenCalled();
  });

  it("keeps dragging owned by the initiating pointer", async () => {
    const { divider, resized, resizeStarted, resizeEnded } = await dragFixture();

    dispatchPointer(divider, "pointerdown", 100);
    expect(document.activeElement).not.toBe(divider);
    expect([...divider.classList]).toEqual(["dragging"]);
    expect(divider.setPointerCapture).toHaveBeenCalledWith(7);
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

    expect(divider.setPointerCapture).toHaveBeenCalledTimes(1);
    expect(resizeStarted).toHaveBeenCalledOnce();
    expect(resized).not.toHaveBeenCalled();
    expect(resizeEnded).not.toHaveBeenCalled();
    expect([...divider.classList]).toEqual(["dragging"]);

    dispatchPointer(document, "pointermove", 220, 7);
    dispatchPointer(document, "pointermove", 120, 7);
    expect(resized).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
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
    expect(divider.releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(resizeStarted).toHaveBeenCalledOnce();
  });

  it("stops dragging when the window loses focus", async () => {
    const { divider, resized, resizeEnded } = await dragFixture();

    dispatchPointer(divider, "pointerdown", 100);
    window.dispatchEvent(new Event("blur"));

    expect([...divider.classList]).toEqual([]);
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    expectLastResizeRatio(resizeEnded, 0.6);
    expect(resizeEnded).toHaveBeenCalledOnce();
    dispatchPointer(document, "pointermove", 220);
    dispatchPointer(document, "pointerup", 220);
    expect(resized).not.toHaveBeenCalled();
    expect(resizeEnded).toHaveBeenCalledOnce();
  });

  it("ends only the owner gesture when pointer capture is lost", async () => {
    const { divider, resized, resizeEnded } = await dragFixture();
    const capturedPointers = new Set<number>();
    divider.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
    divider.releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
    divider.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));

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
    const { divider, resized, resizeEnded } = await dragFixture();

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
    key(divider, "ArrowRight");
    dispatchPointer(divider, "pointerdown", 100);
    expect(resized).toHaveBeenCalledOnce();
    expect(resizeEnded).toHaveBeenCalledOnce();
    expect(divider.classList.contains("dragging")).toBe(false);
  });
});
