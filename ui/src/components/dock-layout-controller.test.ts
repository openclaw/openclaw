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

function createController() {
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
    isAvailable: () => true,
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

    controller.startResize(pointer("pointerdown", 7, 500));
    controller.startResize(pointer("pointerdown", 8, 450));
    window.dispatchEvent(pointer("pointermove", 8, 300));
    window.dispatchEvent(pointer("pointerup", 8, 300));
    window.dispatchEvent(pointer("pointercancel", 9, 300));

    expect(controller.width).toBe(500);
    expect(save).not.toHaveBeenCalled();

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

    controller.startResize(pointer("pointerdown", 7, 500));
    window.dispatchEvent(pointer("pointermove", 7, 400));
    window.dispatchEvent(new Event("blur"));

    expect(controller.width).toBe(600);
    expect(save).toHaveBeenCalledOnce();

    window.dispatchEvent(pointer("pointermove", 7, 300));
    expect(controller.width).toBe(600);

    controller.startResize(pointer("pointerdown", 8, 400));
    window.dispatchEvent(pointer("pointermove", 8, 350));
    window.dispatchEvent(pointer("pointerup", 8, 350));

    expect(controller.width).toBe(650);
    expect(save).toHaveBeenCalledTimes(2);
  });
});
