/* @vitest-environment jsdom */

import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DockLayoutController } from "./dock-layout-controller.ts";
import type { DockPanelLayoutStore } from "./dock-panel-layout.ts";

const originalPointerEvent = globalThis.PointerEvent;
const activeControllers: DockLayoutController<"right">[] = [];

class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
  }
}

class TestHost implements ReactiveControllerHost {
  readonly controllers: ReactiveController[] = [];
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);
  isConnected = true;

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
    this.controllers.splice(this.controllers.indexOf(controller), 1);
  }
}

function pointer(type: string, pointerId: number, clientX: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    cancelable: true,
    clientX,
    pointerId,
    pointerType: "touch",
  });
}

function createResizer(controller: DockLayoutController<"right">) {
  const capturedPointers = new Set<number>();
  const resizer = document.createElement("div");
  const setPointerCapture = vi.fn((pointerId: number) => capturedPointers.add(pointerId));
  resizer.setPointerCapture = setPointerCapture;
  resizer.hasPointerCapture = vi.fn((pointerId: number) => capturedPointers.has(pointerId));
  resizer.releasePointerCapture = vi.fn((pointerId: number) => capturedPointers.delete(pointerId));
  resizer.addEventListener("pointerdown", (event) => controller.startResize(event));
  document.body.append(resizer);
  return { capturedPointers, resizer, setPointerCapture };
}

function createController(isAvailable: () => boolean = () => true) {
  const save = vi.fn();
  const layout: DockPanelLayoutStore<"right"> = {
    defaults: { open: true, dock: "right", height: 420, width: 500 },
    minHeight: 200,
    minWidth: 300,
    maxHeight: () => 700,
    maxWidth: () => 900,
    load: () => ({ open: true, dock: "right", height: 420, width: 500 }),
    save,
  };
  const host = new TestHost();
  const controller = new DockLayoutController(host, {
    layout,
    reservationPrefix: "test",
    isAvailable,
  });
  controller.hostConnected();
  activeControllers.push(controller);
  return { controller, host, save };
}

describe("DockLayoutController", () => {
  beforeEach(() => {
    if (!globalThis.PointerEvent) {
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: TestPointerEvent as typeof PointerEvent,
      });
    }
  });

  afterEach(() => {
    for (const controller of activeControllers.splice(0)) {
      controller.hostDisconnected();
    }
    document.body.replaceChildren();
    document.documentElement.style.removeProperty("--oc-test-reserve-right");
    if (originalPointerEvent) {
      Object.defineProperty(globalThis, "PointerEvent", {
        configurable: true,
        value: originalPointerEvent,
      });
    } else {
      delete (globalThis as Partial<typeof globalThis>).PointerEvent;
    }
    vi.restoreAllMocks();
  });

  it("keeps resize ownership with the pointer that started it", () => {
    const { controller, save } = createController();
    const { resizer } = createResizer(controller);

    resizer.dispatchEvent(pointer("pointerdown", 7, 500));
    const foreignDown = pointer("pointerdown", 8, 450);
    resizer.dispatchEvent(foreignDown);
    window.dispatchEvent(pointer("pointermove", 8, 300));
    window.dispatchEvent(pointer("pointerup", 8, 300));
    window.dispatchEvent(pointer("pointercancel", 9, 300));

    expect(controller.width).toBe(500);
    expect(save).not.toHaveBeenCalled();
    expect(foreignDown.defaultPrevented).toBe(true);

    window.dispatchEvent(pointer("pointermove", 7, 400));
    expect(controller.width).toBe(600);

    window.dispatchEvent(pointer("pointerup", 7, 400));
    expect(save).toHaveBeenCalledOnce();
    expect(save).toHaveBeenLastCalledWith({
      open: true,
      dock: "right",
      height: 420,
      width: 600,
    });
  });

  it("cleans resize ownership on window blur", () => {
    const { controller, save } = createController();
    const { resizer } = createResizer(controller);

    resizer.dispatchEvent(pointer("pointerdown", 7, 500));
    window.dispatchEvent(pointer("pointermove", 7, 400));
    window.dispatchEvent(new Event("blur"));

    expect(controller.width).toBe(600);
    expect(save).toHaveBeenCalledOnce();

    window.dispatchEvent(pointer("pointermove", 7, 300));
    expect(controller.width).toBe(600);

    resizer.dispatchEvent(pointer("pointerdown", 8, 400));
    window.dispatchEvent(pointer("pointermove", 8, 350));
    window.dispatchEvent(pointer("pointerup", 8, 350));

    expect(controller.width).toBe(650);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("captures the owner pointer and cleans up when capture is lost", () => {
    const { controller, save } = createController();
    const { capturedPointers, resizer, setPointerCapture } = createResizer(controller);

    resizer.dispatchEvent(pointer("pointerdown", 7, 500));
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(capturedPointers.has(7)).toBe(true);

    window.dispatchEvent(pointer("pointermove", 7, 450));
    capturedPointers.delete(7);
    resizer.dispatchEvent(pointer("lostpointercapture", 7, 450));

    expect(controller.width).toBe(550);
    expect(save).toHaveBeenCalledOnce();

    window.dispatchEvent(pointer("pointermove", 7, 400));
    expect(controller.width).toBe(550);

    resizer.dispatchEvent(pointer("pointerdown", 8, 450));
    expect(setPointerCapture).toHaveBeenLastCalledWith(8);
  });

  it("does not persist a temporary suppressed state when resize capture is lost", () => {
    const { controller, save } = createController();
    const { capturedPointers, resizer } = createResizer(controller);

    resizer.dispatchEvent(pointer("pointerdown", 7, 500));
    window.dispatchEvent(pointer("pointermove", 7, 450));
    expect(controller.width).toBe(550);

    controller.setSuppressed(true);
    capturedPointers.delete(7);
    resizer.dispatchEvent(pointer("lostpointercapture", 7, 450));

    expect(controller.open).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(controller.setSuppressed(false)).toBe(true);
    expect(controller.open).toBe(true);
  });

  it("does not persist a temporary unavailable state when resize capture is lost", () => {
    let available = true;
    const { controller, save } = createController(() => available);
    const { capturedPointers, resizer } = createResizer(controller);

    resizer.dispatchEvent(pointer("pointerdown", 7, 500));
    window.dispatchEvent(pointer("pointermove", 7, 450));
    expect(controller.width).toBe(550);

    available = false;
    controller.hideWithoutPersisting();
    capturedPointers.delete(7);
    resizer.dispatchEvent(pointer("lostpointercapture", 7, 450));

    expect(controller.open).toBe(false);
    expect(save).not.toHaveBeenCalled();

    available = true;
    expect(controller.restoreOpenState()).toBe(true);
    expect(controller.open).toBe(true);
  });
});
