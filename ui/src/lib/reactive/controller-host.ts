import type { ReactiveController, ReactiveControllerHost } from "lit";

type Listener = () => void;

/** Keeps existing synchronous page controllers alive while Solid owns their DOM. */
export class ControllerHost implements ReactiveControllerHost {
  private readonly controllers = new Set<ReactiveController>();
  private readonly listeners = new Set<Listener>();
  private pendingUpdate: Promise<boolean> | null = null;
  isConnected = false;

  addController(controller: ReactiveController): void {
    this.controllers.add(controller);
    if (this.isConnected) {
      controller.hostConnected?.();
    }
  }

  removeController(controller: ReactiveController): void {
    this.controllers.delete(controller);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  requestUpdate(): void {
    if (!this.pendingUpdate) {
      this.pendingUpdate = Promise.resolve().then(() => {
        this.pendingUpdate = null;
        if (this.isConnected) {
          for (const controller of this.controllers) {
            controller.hostUpdate?.();
          }
        }
        for (const listener of this.listeners) {
          listener();
        }
        return true;
      });
    }
  }

  get updateComplete(): Promise<boolean> {
    return this.pendingUpdate ?? Promise.resolve(true);
  }

  connect(): void {
    this.isConnected = true;
    for (const controller of this.controllers) {
      controller.hostConnected?.();
    }
    this.requestUpdate();
  }

  disconnect(): void {
    this.isConnected = false;
    for (const controller of this.controllers) {
      controller.hostDisconnected?.();
    }
  }
}

/** State stays synchronous; the setter only publishes a rendering invalidation. */
export function viewState() {
  return (prototype: ControllerHost, key: string): void => {
    const values = new WeakMap<ControllerHost, unknown>();
    Object.defineProperty(prototype, key, {
      configurable: true,
      get(this: ControllerHost) {
        return values.get(this);
      },
      set(this: ControllerHost, value: unknown) {
        if (!Object.is(values.get(this), value)) {
          values.set(this, value);
          this.requestUpdate();
        }
      },
    });
  };
}
