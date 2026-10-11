import { createRenderEffect, onCleanup, onSettled } from "solid-js";
import { i18n } from "../i18n/lib/translate.ts";
import {
  createSolidRenderLifecycle,
  type SolidRenderLifecycle,
} from "../pages/chat/solid-render-lifecycle.ts";

/** Structural lifecycle used by the existing imperative panel owners. */
export interface PanelLifecycleController {
  hostConnected?(): void;
  hostDisconnected?(): void;
  hostUpdate?(): void;
  hostUpdated?(): void;
}

/** Keeps synchronous panel state separate from Solid's rendering notification. */
export class SolidPanelController {
  private readonly controllers = new Set<PanelLifecycleController>();
  private version = 0;
  private rendering: SolidRenderLifecycle<number> | undefined;
  private cancelCommit: (() => void) | undefined;
  private changes = new Map<string, unknown>();
  private completion: Promise<boolean> = Promise.resolve(true);
  private complete: ((value: boolean) => void) | undefined;
  private connected = false;
  private stopLocale: (() => void) | undefined;
  hasUpdated = false;

  constructor(readonly element: HTMLElement) {}

  get renderRoot(): HTMLElement {
    return this.element;
  }

  get ownerDocument(): Document {
    return this.element.ownerDocument;
  }

  get isConnected(): boolean {
    return this.connected && this.element.isConnected;
  }

  get updateComplete(): Promise<boolean> {
    return this.completion;
  }

  hasAttribute(name: string): boolean {
    return this.element.hasAttribute(name);
  }

  dispatchEvent(event: Event): boolean {
    return this.element.dispatchEvent(event);
  }

  addController(controller: PanelLifecycleController): void {
    this.controllers.add(controller);
    if (this.connected) {
      controller.hostConnected?.();
    }
  }

  removeController(controller: PanelLifecycleController): void {
    this.controllers.delete(controller);
  }

  read(): this {
    this.rendering?.snapshot();
    return this;
  }

  revision(): number {
    return this.rendering?.snapshot() ?? this.version;
  }

  bindRendering(): void {
    this.rendering = createSolidRenderLifecycle({
      host: this.element,
      // The panel owner still processes disconnect/suppression while its view is hidden.
      presented: () => true,
      read: () => this.version,
    });
  }

  inputsChanged(name: string, oldValue: unknown): void {
    if (!this.changes.has(name)) {
      this.changes.set(name, oldValue);
    }
    this.invalidate();
  }

  /** Legacy controllers consume this structural host method until their callers migrate. */
  requestUpdate(): void {
    this.invalidate();
  }

  invalidate(): void {
    if (!this.complete) {
      this.completion = new Promise((resolve) => {
        this.complete = resolve;
      });
    }
    this.version += 1;
    if (this.rendering && this.connected && !this.cancelCommit) {
      this.cancelCommit = this.rendering.afterCommit(() => {
        this.cancelCommit = undefined;
        this.commit();
      });
    } else {
      this.rendering?.invalidate();
    }
  }

  connectedCallback(): void {}
  disconnectedCallback(): void {}
  willUpdate(_changed: Map<string, unknown>): void {}
  updated(_changed: Map<string, unknown>): void {}

  connect(): void {
    this.connected = true;
    this.stopLocale = i18n.subscribe(() => this.invalidate());
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    this.connectedCallback();
    this.invalidate();
  }

  prepare(): void {
    if (!this.connected) {
      return;
    }
    this.willUpdate(this.changes);
    for (const controller of this.controllers) {
      controller.hostUpdate?.();
    }
  }

  commit(): void {
    // Initial props belong to the first connected commit, after the DOM mounts.
    if (!this.connected) {
      return;
    }
    const changed = this.changes;
    this.changes = new Map();
    const complete = this.complete;
    this.complete = undefined;
    for (const controller of this.controllers) {
      controller.hostUpdated?.();
    }
    this.updated(changed);
    this.hasUpdated = true;
    complete?.(true);
  }

  disconnect(): void {
    this.connected = false;
    this.cancelCommit?.();
    this.cancelCommit = undefined;
    this.rendering = undefined;
    this.stopLocale?.();
    this.stopLocale = undefined;
    this.disconnectedCallback();
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
    this.complete?.(false);
    this.complete = undefined;
  }
}

/** Connect after mount, and publish completion only after Solid commits the DOM. */
export function usePanelController(controller: SolidPanelController): void {
  controller.bindRendering();
  createRenderEffect(
    () => controller.revision(),
    () => controller.prepare(),
  );
  let disposed = false;
  onSettled(() => {
    if (controller.element.isConnected) {
      controller.connect();
    } else {
      // A direct bridge render settles before its parent inserts the host.
      queueMicrotask(() => {
        if (!disposed && controller.element.isConnected) {
          controller.connect();
        }
      });
    }
  });
  onCleanup(() => {
    disposed = true;
    controller.disconnect();
  });
}
