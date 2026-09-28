import type { ReactiveController, ReactiveControllerHost } from "lit";
import { vi } from "vitest";

export class TestHost implements ReactiveControllerHost {
  readonly controllers: ReactiveController[] = [];
  readonly requestUpdate = vi.fn();
  readonly updateComplete = Promise.resolve(true);

  addController(controller: ReactiveController): void {
    this.controllers.push(controller);
  }

  removeController(controller: ReactiveController): void {
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
