import { describe, expect, it, vi } from "vitest";
import {
  createBrowserClient,
  createBrowserPanelTestController,
  setupBrowserPanelTestCleanup,
} from "./browser-panel-controller-test-support.ts";
import type { BrowserPanelController } from "./browser-panel-controller.ts";

setupBrowserPanelTestCleanup();

function pointer(type: string, pointerId: number, clientX: number, clientY: number): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperty(event, "pointerId", { configurable: true, value: pointerId });
  return event as PointerEvent;
}

function createOverlay(controller: BrowserPanelController) {
  const overlay = document.createElement("canvas");
  const capturedPointers = new Set<number>();
  overlay.setPointerCapture = vi.fn((pointerId) => capturedPointers.add(pointerId));
  overlay.hasPointerCapture = vi.fn((pointerId) => capturedPointers.has(pointerId));
  const releasePointerCapture = vi.fn((pointerId) => capturedPointers.delete(pointerId));
  overlay.releasePointerCapture = releasePointerCapture;
  overlay.addEventListener("pointerdown", (event) =>
    controller.handleOverlayPointerDown(event as PointerEvent),
  );
  overlay.addEventListener("pointermove", (event) =>
    controller.handleOverlayPointerMove(event as PointerEvent),
  );
  overlay.addEventListener("pointerup", (event) =>
    controller.handleOverlayPointerUp(event as PointerEvent),
  );
  overlay.addEventListener("pointercancel", (event) =>
    controller.handleOverlayPointerUp(event as PointerEvent),
  );
  overlay.addEventListener("lostpointercapture", (event) =>
    controller.handleOverlayPointerUp(event as PointerEvent),
  );
  return { overlay, capturedPointers, releasePointerCapture };
}

function createAnnotationController() {
  const { client } = createBrowserClient(async () => {
    throw new Error("annotation ownership does not call the gateway");
  });
  const controller = createBrowserPanelTestController(client, "tab-a");
  controller.setMode("annotate");
  return controller;
}

describe("BrowserPanelController annotation pointer ownership", () => {
  it("ignores foreign pointer starts, moves, ends, and cancellations", () => {
    const controller = createAnnotationController();
    const { overlay } = createOverlay(controller);

    overlay.dispatchEvent(pointer("pointerdown", 7, 10, 20));
    expect(controller.strokes).toEqual([{ points: [{ x: 0.1, y: 0.2 }] }]);

    overlay.dispatchEvent(pointer("pointerdown", 8, 80, 90));
    overlay.dispatchEvent(pointer("pointermove", 8, 70, 80));
    overlay.dispatchEvent(pointer("pointerup", 8, 70, 80));
    overlay.dispatchEvent(pointer("pointercancel", 9, 60, 70));
    overlay.dispatchEvent(pointer("lostpointercapture", 10, 50, 60));

    expect(controller.strokes).toEqual([{ points: [{ x: 0.1, y: 0.2 }] }]);

    overlay.dispatchEvent(pointer("pointermove", 7, 30, 40));
    expect(controller.strokes).toEqual([
      {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4 },
        ],
      },
    ]);

    overlay.dispatchEvent(pointer("pointerup", 7, 30, 40));
    overlay.dispatchEvent(pointer("pointermove", 7, 50, 60));
    expect(controller.strokes).toEqual([
      {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.3, y: 0.4 },
        ],
      },
    ]);
  });

  it("ends the owner on cancellation or capture loss and accepts the next pointer", () => {
    const controller = createAnnotationController();
    const { overlay } = createOverlay(controller);

    overlay.dispatchEvent(pointer("pointerdown", 7, 10, 20));
    overlay.dispatchEvent(pointer("pointermove", 7, 20, 30));
    overlay.dispatchEvent(pointer("pointercancel", 7, 20, 30));
    overlay.dispatchEvent(pointer("pointermove", 7, 30, 40));

    overlay.dispatchEvent(pointer("pointerdown", 8, 40, 50));
    overlay.dispatchEvent(pointer("pointermove", 8, 50, 60));
    overlay.dispatchEvent(pointer("lostpointercapture", 8, 50, 60));
    overlay.dispatchEvent(pointer("pointermove", 8, 60, 70));

    overlay.dispatchEvent(pointer("pointerdown", 9, 70, 80));
    overlay.dispatchEvent(pointer("pointerup", 9, 70, 80));

    expect(controller.strokes).toEqual([
      {
        points: [
          { x: 0.1, y: 0.2 },
          { x: 0.2, y: 0.3 },
        ],
      },
      {
        points: [
          { x: 0.4, y: 0.5 },
          { x: 0.5, y: 0.6 },
        ],
      },
      { points: [{ x: 0.7, y: 0.8 }] },
    ]);
  });

  it("does not leave an active owner after undo or clear", () => {
    const controller = createAnnotationController();
    const { overlay, capturedPointers, releasePointerCapture } = createOverlay(controller);

    overlay.dispatchEvent(pointer("pointerdown", 7, 10, 20));
    controller.undoStroke();

    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(capturedPointers.has(7)).toBe(false);
    overlay.dispatchEvent(pointer("pointermove", 7, 20, 30));
    expect(controller.strokes).toEqual([]);

    overlay.dispatchEvent(pointer("pointerdown", 8, 30, 40));
    controller.clearStrokes();

    expect(releasePointerCapture).toHaveBeenCalledWith(8);
    expect(capturedPointers.has(8)).toBe(false);
    overlay.dispatchEvent(pointer("pointermove", 8, 40, 50));
    expect(controller.strokes).toEqual([]);
  });

  it("releases the owner capture when annotation mode or the controller is torn down", () => {
    const controller = createAnnotationController();
    const { overlay, capturedPointers, releasePointerCapture } = createOverlay(controller);

    overlay.dispatchEvent(pointer("pointerdown", 7, 10, 20));
    expect(capturedPointers.has(7)).toBe(true);

    controller.exitCaptureModes();
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    expect(capturedPointers.has(7)).toBe(false);
    expect(controller.mode).toBe("interact");
    expect(controller.strokes).toEqual([]);

    controller.setMode("annotate");
    overlay.dispatchEvent(pointer("pointerdown", 8, 30, 40));
    controller.hostDisconnected();

    expect(releasePointerCapture).toHaveBeenCalledWith(8);
    expect(capturedPointers.has(8)).toBe(false);
  });
});
