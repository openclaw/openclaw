import { vi } from "vitest";
import type { SolidController, SolidControllerHost } from "./solid-controller-host.ts";

export class TestHost implements SolidControllerHost {
  readonly controllers: SolidController[] = [];
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);

  addController(controller: SolidController): void {
    this.controllers.push(controller);
  }

  removeController(controller: SolidController): void {
    const index = this.controllers.indexOf(controller);
    if (index !== -1) {
      this.controllers.splice(index, 1);
    }
  }

  connect(): void {
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
  }

  update(): void {
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
  }

  disconnect(): void {
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }
}
