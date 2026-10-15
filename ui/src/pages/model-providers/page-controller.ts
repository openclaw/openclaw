import { I18nController } from "../../i18n/lib/lit-controller.ts";
import type { SolidController, SolidControllerHost } from "../../lit/solid-controller-host.ts";

/** Keeps synchronous page owners and their subscriptions independent of the renderer. */
export class ModelPageController implements SolidControllerHost {
  private readonly controllers = new Set<SolidController>();
  protected readonly i18nController = new I18nController(this);
  private connected = false;
  private settle: ((settled: boolean) => void) | undefined;
  updateComplete = Promise.resolve(true);

  readonly querySelector: HTMLElement["querySelector"];
  readonly querySelectorAll: HTMLElement["querySelectorAll"];

  constructor(
    readonly renderRoot: HTMLElement,
    private readonly notify: () => void,
  ) {
    this.querySelector = renderRoot.querySelector.bind(renderRoot);
    this.querySelectorAll = renderRoot.querySelectorAll.bind(renderRoot);
  }

  get isConnected(): boolean {
    return this.connected;
  }

  addController(controller: SolidController): void {
    this.controllers.add(controller);
    if (this.connected) {
      controller.hostConnected?.();
    }
  }

  removeController(controller: SolidController): void {
    this.controllers.delete(controller);
  }

  requestUpdate(): void {
    if (!this.settle) {
      this.updateComplete = new Promise((resolve) => {
        this.settle = resolve;
      });
    }
    this.notify();
  }

  connect(): void {
    this.connected = true;
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    this.requestUpdate();
  }

  beforeUpdate(): void {
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
  }

  afterUpdate(): void {
    const settle = this.settle;
    this.settle = undefined;
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
    settle?.(!this.settle);
  }

  disconnect(): void {
    this.connected = false;
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.settle?.(true);
    this.settle = undefined;
  }
}
