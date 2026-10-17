import type { SolidController, SolidControllerHost } from "./reactive/solid-controller-host.ts";

type Cleanup = () => void;
type SourceEntry<T> = {
  readonly getSource: () => T | null | undefined;
  readonly connect: (source: T) => Cleanup | undefined;
  readonly invalidateOnConnect: boolean;
  source: T | undefined;
  cleanup: Cleanup | undefined;
  frame: number | undefined;
};

/** Adapts dynamic subscriptions to the sidebar host until it adopts Solid lifetimes. */
export class SubscriptionsController implements SolidController {
  private readonly entries: SourceEntry<unknown>[] = [];
  private connected = false;

  constructor(private readonly host: SolidControllerHost) {
    host.addController(this);
  }

  watchStore<T extends { subscribe: (notify: () => void) => Cleanup }>(
    getSource: () => T | null | undefined,
    synchronize?: (source: T) => void,
    commitInFrame?: () => void,
  ): this {
    return this.watch(
      getSource,
      (source, notify) => source.subscribe(notify),
      synchronize,
      commitInFrame,
    );
  }

  watch<T>(
    getSource: () => T | null | undefined,
    subscribe: (source: T, notify: () => void) => Cleanup,
    synchronize?: (source: T) => void,
    commitInFrame?: () => void,
  ): this {
    return this.addEntry(
      getSource,
      (source, entry) => {
        const notify = () => {
          if (!this.connected || !Object.is(entry.source, source)) {
            return;
          }
          synchronize?.(source);
          if (
            !commitInFrame ||
            globalThis.document?.visibilityState === "hidden" ||
            typeof globalThis.requestAnimationFrame !== "function"
          ) {
            this.host.requestUpdate();
          } else if (entry.frame === undefined) {
            entry.frame = globalThis.requestAnimationFrame(() => {
              entry.frame = undefined;
              if (!this.connected || !Object.is(entry.getSource(), source)) {
                return;
              }
              this.host.requestUpdate();
              // Commit bindings in the same frame, before the queued render notification.
              commitInFrame();
            });
          }
        };
        const cleanup = subscribe(source, notify);
        // Make cleanup visible before synchronization in case initial state
        // projection throws after the external listener is already registered.
        entry.cleanup = cleanup;
        synchronize?.(source);
        return cleanup;
      },
      true,
    );
  }

  effect<T>(
    getSource: () => T | null | undefined,
    connect: (source: T) => Cleanup | undefined,
  ): this {
    return this.addEntry(getSource, (source) => connect(source), false);
  }

  hostConnected(): void {
    this.connected = true;
    this.refresh(true);
  }

  hostUpdate(): void {
    if (this.connected) {
      this.refresh(false);
    }
  }

  clear(): void {
    for (const entry of this.entries) {
      this.disconnectEntry(entry);
    }
  }

  hostDisconnected(): void {
    this.connected = false;
    this.clear();
  }

  private addEntry<T>(
    getSource: () => T | null | undefined,
    connect: (source: T, entry: SourceEntry<T>) => Cleanup | undefined,
    invalidateOnConnect: boolean,
  ): this {
    const entry: SourceEntry<T> = {
      getSource,
      connect: (source) => connect(source, entry),
      invalidateOnConnect,
      source: undefined,
      cleanup: undefined,
      frame: undefined,
    };
    this.entries.push(entry as SourceEntry<unknown>);
    if (this.connected) {
      this.refreshEntry(entry, invalidateOnConnect);
    }
    return this;
  }

  private refresh(requestUpdate: boolean): void {
    for (const entry of this.entries) {
      this.refreshEntry(entry, requestUpdate && entry.invalidateOnConnect);
    }
  }

  private refreshEntry<T>(entry: SourceEntry<T>, requestUpdate: boolean): void {
    const source = entry.getSource() ?? undefined;
    if (Object.is(entry.source, source)) {
      return;
    }
    this.disconnectEntry(entry);
    if (source === undefined) {
      return;
    }
    entry.source = source;
    try {
      entry.cleanup = entry.connect(source);
    } catch (error) {
      this.disconnectEntry(entry);
      throw error;
    }
    if (requestUpdate) {
      this.host.requestUpdate();
    }
  }

  private disconnectEntry<T>(entry: SourceEntry<T>): void {
    if (entry.frame !== undefined) {
      globalThis.cancelAnimationFrame(entry.frame);
      entry.frame = undefined;
    }
    entry.source = undefined;
    const cleanup = entry.cleanup;
    entry.cleanup = undefined;
    try {
      cleanup?.();
    } catch (error) {
      console.error("[openclaw] subscription cleanup failed", error);
    }
  }
}
