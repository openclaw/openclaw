import {
  createMemo,
  createSignal,
  getObserver,
  getOwner,
  onCleanup,
  untrack,
} from "@solidjs/signals";

type Dispose = () => void;

type SourceContract<S, T> = {
  read(source: S): T;
  subscribe(source: S, notify: () => void): Dispose;
  /** Mutable snapshots invalidate by notification, never by object identity. */
  equality: "revision" | ((previous: T, next: T) => boolean);
};

export type SourceProjection<S, T> = {
  readonly equality: SourceContract<S, T>["equality"];
  readonly read: () => T;
  readonly revision: () => number;
  subscribe(this: void, listener: () => void): Dispose;
  replaceSource(this: void, source: S): void;
  dispose(this: void): void;
};

/** Capability owners publish mutable state through the same subscription contract. */
export function projectOwner<S extends { subscribe(notify: () => void): Dispose }, T>(
  source: S,
  read: (source: S) => T,
  equality: SourceContract<S, T>["equality"] = "revision",
): SourceProjection<S, T> {
  return projectSource(source, {
    read,
    subscribe: (owner, notify) => owner.subscribe(notify),
    equality,
  });
}

/** A read-through view of an owner. This never becomes an authoritative store. */
export function projectSource<S, T>(
  initialSource: S,
  contract: SourceContract<S, T>,
): SourceProjection<S, T> {
  let source = initialSource;
  let value = untrack(() => contract.read(source));
  let lastRead = value;
  let disposed = false;
  let observed = false;
  let connected = false;
  let disconnect: Dispose | undefined;
  const listeners = new Set<() => void>();
  const release = () => {
    connected = false;
    const cleanup = disconnect;
    disconnect = undefined;
    cleanup?.();
  };
  const [revision, setRevision] = createSignal(0, {
    ownedWrite: true,
  });
  const publish = () => {
    setRevision((previous) => previous + 1);
    const snapshot = Array.from(listeners);
    for (const listener of snapshot) {
      if (listeners.has(listener)) {
        listener();
      }
    }
  };
  const connect = () => {
    if (connected || disposed) {
      return;
    }
    connected = true;
    // Owners remove their listeners synchronously; detached callbacks are not replayed.
    disconnect = contract.subscribe(source, () => {
      const next = untrack(() => contract.read(source));
      const changed = contract.equality === "revision" || !contract.equality(value, next);
      value = next;
      lastRead = next;
      if (changed) {
        publish();
      }
    });
    value = untrack(() => contract.read(source));
    lastRead = value;
  };
  // A lazy, dependency-free memo gives probes a temporary lifetime and tracked
  // readers a shared lifetime. It never reruns merely because the owner publishes.
  const observation = createMemo(
    () => {
      observed = true;
      onCleanup(() => {
        observed = false;
        if (listeners.size === 0) {
          release();
        }
      });
      untrack(connect);
      return true;
    },
    { lazy: true },
  );
  const observe = () => {
    const current = revision();
    if (!disposed && getObserver()) {
      observation();
    }
    return current;
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    setRevision(untrack(revision));
    disposed = true;
    listeners.clear();
    release();
  };
  if (getOwner()) {
    onCleanup(dispose);
  }
  return {
    equality: contract.equality,
    read() {
      observe();
      if (!disposed) {
        lastRead = untrack(() => contract.read(source));
      }
      return lastRead;
    },
    revision: observe,
    subscribe(listener) {
      if (disposed) {
        return () => {};
      }
      // Each subscription has its own identity, including duplicate callbacks.
      const entry = () => listener();
      listeners.add(entry);
      connect();
      return () => {
        listeners.delete(entry);
        if (!observed && listeners.size === 0) {
          release();
        }
      };
    },
    replaceSource(next) {
      if (disposed || Object.is(source, next)) {
        return;
      }
      release();
      source = next;
      value = untrack(() => contract.read(source));
      lastRead = value;
      if (observed || listeners.size > 0) {
        connect();
      }
      publish();
    },
    dispose,
  };
}
