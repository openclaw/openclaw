import { I18nController } from "../../i18n/lib/lit-controller.ts";

export interface PageLifecycle {
  hostConnected?(): void;
  hostDisconnected?(): void;
  hostUpdate?(): void;
  hostUpdated?(): void;
}

export interface ControllerHost {
  addController(controller: PageLifecycle): void;
  removeController(controller: PageLifecycle): void;
  requestUpdate(): void;
  readonly updateComplete: Promise<boolean>;
}

/** Keeps synchronous page owners and their subscriptions independent of the renderer. */
export class ModelPageController implements ControllerHost {
  private readonly controllers = new Set<PageLifecycle>();
  protected readonly i18nController = new I18nController(this);
  private connected = false;
  private settle: ((settled: boolean) => void) | undefined;
  updateComplete = Promise.resolve(true);

  constructor(
    readonly renderRoot: HTMLElement,
    private readonly notify: () => void,
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  querySelector<Key extends keyof HTMLElementTagNameMap>(
    selector: Key,
  ): HTMLElementTagNameMap[Key] | null;
  querySelector<E extends Element = Element>(selector: string): E | null;
  querySelector<E extends Element = Element>(selector: string): E | null {
    return this.renderRoot.querySelector<E>(selector);
  }

  querySelectorAll<E extends Element = Element>(selector: string): NodeListOf<E> {
    return this.renderRoot.querySelectorAll<E>(selector);
  }

  addController(controller: PageLifecycle): void {
    this.controllers.add(controller);
    if (this.connected) {
      controller.hostConnected?.();
    }
  }

  removeController(controller: PageLifecycle): void {
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
