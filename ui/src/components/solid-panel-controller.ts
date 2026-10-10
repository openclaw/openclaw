import { createEffect, createRenderEffect, createSignal, onCleanup, onSettled } from "solid-js";
import { i18n } from "../i18n/lib/translate.ts";

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
  private readonly version = createSignal(0);
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
    this.version[0]();
    return this;
  }

  revision(): number {
    return this.version[0]();
  }

  requestUpdate(name?: string, oldValue?: unknown): void {
    if (name !== undefined && !this.changes.has(name)) {
      this.changes.set(name, oldValue);
    }
    if (!this.complete) {
      this.completion = new Promise((resolve) => {
        this.complete = resolve;
      });
    }
    this.version[1]((value) => value + 1);
  }

  connectedCallback(): void {}
  disconnectedCallback(): void {}
  willUpdate(_changed: Map<string, unknown>): void {}
  updated(_changed: Map<string, unknown>): void {}

  connect(): void {
    this.connected = true;
    this.stopLocale = i18n.subscribe(() => this.requestUpdate());
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    this.connectedCallback();
    this.requestUpdate();
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
  createRenderEffect(
    () => controller.revision(),
    () => controller.prepare(),
  );
  createEffect(
    () => controller.revision(),
    () => controller.commit(),
  );
  onSettled(() => controller.connect());
  onCleanup(() => controller.disconnect());
}
