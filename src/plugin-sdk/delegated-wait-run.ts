/**
 * Plugin-facing wait-run handle seam for delegated tasks.
 *
 * Provides a generic, A2A-agnostic registry for managing the lifecycle of
 * delegated wait-run handles.  Plugins (e.g. the A2A broker plugin) use this
 * surface to register, resolve, cancel, and clean up handles without reaching
 * into core-owned runtime state.
 *
 * ## Lifecycle
 *
 * 1. **Register** — `registry.register(id)` creates a new handle in `"pending"` state.
 * 2. **Terminal transition** — A handle moves to exactly one of `"resolved"`,
 *    `"cancelled"`, or `"expired"` and never transitions again.
 * 3. **Cleanup** — `registry.cleanup()` removes expired handles from the map.
 *
 * ## Ownership
 *
 * The caller that registers a handle owns it.  Only the owner (or a designee
 * with a reference to the handle) should call `resolve()` or `cancel()`.
 * After a handle reaches a terminal state the `wait()` promise settles and the
 * handle is eligible for garbage-collection or explicit cleanup.
 *
 * @module plugin-sdk/delegated-wait-run
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Possible terminal and non-terminal states of a wait-run handle. */
export type DelegatedWaitRunStatus = "pending" | "resolved" | "cancelled" | "expired";

/** Outcome of a successful or failed terminal resolution. */
export type DelegatedWaitRunResolution = {
  /** `"success"` if the delegated task produced a usable result. */
  outcome: "success" | "failure";
  /** Optional opaque output produced by the delegated task. */
  output?: unknown;
  /** Human-readable error string when `outcome === "failure"`. */
  error?: string;
};

/** Options accepted when registering a new wait-run handle. */
export type DelegatedWaitRunOptions = {
  /**
   * Optional time-to-live in milliseconds.  When set, the handle
   * automatically transitions to `"expired"` once the TTL elapses
   * (checked lazily on access).
   */
  ttlMs?: number;
  /** Opaque metadata the caller wants to attach to the handle. */
  meta?: unknown;
};

/** Public shape of a single wait-run handle. */
export interface WaitRunHandle {
  /** Unique identifier for this handle (provided at registration time). */
  readonly id: string;
  /** Current lifecycle status. */
  readonly status: DelegatedWaitRunStatus;
  /** ISO-8601 timestamp when the handle was created. */
  readonly createdAt: string;
  /**
   * ISO-8601 timestamp after which the handle is considered expired.
   * `undefined` when no TTL was configured.
   */
  readonly expiresAt?: string;
  /** Terminal resolution payload (set when status becomes `"resolved"`). */
  readonly resolution?: DelegatedWaitRunResolution;
  /** Human-readable reason (set when status becomes `"cancelled"`). */
  readonly cancelReason?: string;
  /** Opaque metadata attached at registration. */
  readonly meta?: unknown;
  /**
   * Terminate the handle with a successful or failed resolution.
   * No-op if the handle is already in a terminal state.
   */
  resolve(resolution: DelegatedWaitRunResolution): void;
  /**
   * Terminate the handle with a cancellation.
   * No-op if the handle is already in a terminal state.
   */
  cancel(reason?: string): void;
  /**
   * Returns a promise that settles when the handle reaches a terminal
   * state (`"resolved"`, `"cancelled"`, or `"expired"`).
   */
  wait(): Promise<WaitRunHandle>;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

type HandleState = {
  status: DelegatedWaitRunStatus;
  createdAt: string;
  expiresAt?: string;
  resolution?: DelegatedWaitRunResolution;
  cancelReason?: string;
  meta?: unknown;
};

type Listener = (handle: WaitRunHandle) => void;

function isTerminal(status: DelegatedWaitRunStatus): boolean {
  return status !== "pending";
}

function nowISO(): string {
  return new Date().toISOString();
}

function expiresAtISO(ttlMs: number): string {
  return new Date(Date.now() + ttlMs).toISOString();
}

function isExpired(expiresAt: string | undefined): boolean {
  if (expiresAt === undefined) {
    return false;
  }
  return Date.now() >= new Date(expiresAt).getTime();
}

// ---------------------------------------------------------------------------
// Handle implementation
// ---------------------------------------------------------------------------

function createHandle(
  id: string,
  options: DelegatedWaitRunOptions | undefined,
  notifyTransition: (handle: WaitRunHandle) => void,
): WaitRunHandle {
  const state: HandleState = {
    status: "pending",
    createdAt: nowISO(),
    expiresAt: options?.ttlMs !== undefined ? expiresAtISO(options.ttlMs) : undefined,
    meta: options?.meta,
  };

  let waiters: Array<{
    resolve: (handle: WaitRunHandle) => void;
  }> | null = [];

  const handle: WaitRunHandle = {
    get id() {
      return id;
    },
    get status() {
      // Lazy TTL check — also settles any pending waiters.
      if (state.status === "pending" && isExpired(state.expiresAt)) {
        state.status = "expired";
        notifyTransition(handle);
        settleWaiters();
      }
      return state.status;
    },
    get createdAt() {
      return state.createdAt;
    },
    get expiresAt() {
      return state.expiresAt;
    },
    get resolution() {
      return state.resolution;
    },
    get cancelReason() {
      return state.cancelReason;
    },
    get meta() {
      return state.meta;
    },
    resolve(resolution: DelegatedWaitRunResolution): void {
      if (isTerminal(state.status)) {
        return;
      }
      state.status = "resolved";
      state.resolution = resolution;
      notifyTransition(handle);
      settleWaiters();
    },
    cancel(reason?: string): void {
      if (isTerminal(state.status)) {
        return;
      }
      state.status = "cancelled";
      state.cancelReason = reason;
      notifyTransition(handle);
      settleWaiters();
    },
    wait(): Promise<WaitRunHandle> {
      if (isTerminal(state.status)) {
        return Promise.resolve(handle);
      }
      if (waiters === null) {
        waiters = [];
      }
      return new Promise<WaitRunHandle>((resolve) => {
        waiters!.push({ resolve });
      });
    },
  };

  function settleWaiters(): void {
    if (waiters) {
      for (const w of waiters) {
        w.resolve(handle);
      }
      waiters = null;
    }
  }

  return handle;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type WaitRunHandleRegistry = {
  /**
   * Register a new wait-run handle.
   * @throws {Error} If a handle with the same `id` already exists.
   */
  register(id: string, options?: DelegatedWaitRunOptions): WaitRunHandle;
  /**
   * Terminate a handle with a resolution.
   * No-op if the handle does not exist or is already terminal.
   */
  resolve(id: string, resolution: DelegatedWaitRunResolution): void;
  /**
   * Terminate a handle with a cancellation.
   * No-op if the handle does not exist or is already terminal.
   */
  cancel(id: string, reason?: string): void;
  /** Retrieve a handle by id, or `undefined` if not found. */
  get(id: string): WaitRunHandle | undefined;
  /** Return all registered handles. */
  list(): WaitRunHandle[];
  /**
   * Remove handles whose TTL has elapsed (status transitions to `"expired"`).
   * Returns the number of handles removed.
   */
  cleanup(): number;
  /**
   * Register a callback invoked whenever any handle transitions to a
   * terminal state.  Returns an unsubscribe function.
   */
  onTerminal(callback: (handle: WaitRunHandle) => void): () => void;
};

/**
 * Factory that creates a new `WaitRunHandleRegistry`.
 *
 * The registry is intentionally not a singleton — callers may create as many
 * independent registries as needed (e.g. one per plugin instance).
 */
export function createWaitRunHandleRegistry(): WaitRunHandleRegistry {
  const handles = new Map<string, WaitRunHandle>();
  const listeners = new Set<Listener>();

  function notify(handle: WaitRunHandle): void {
    for (const fn of listeners) {
      try {
        fn(handle);
      } catch {
        // listeners must not throw
      }
    }
  }

  return {
    register(id: string, options?: DelegatedWaitRunOptions): WaitRunHandle {
      if (handles.has(id)) {
        throw new Error(`WaitRunHandle already registered: ${id}`);
      }
      const handle = createHandle(id, options, notify);
      handles.set(id, handle);
      return handle;
    },

    resolve(id: string, resolution: DelegatedWaitRunResolution): void {
      const handle = handles.get(id);
      if (!handle) {
        return;
      }
      handle.resolve(resolution);
    },

    cancel(id: string, reason?: string): void {
      const handle = handles.get(id);
      if (!handle) {
        return;
      }
      handle.cancel(reason);
    },

    get(id: string): WaitRunHandle | undefined {
      return handles.get(id);
    },

    list(): WaitRunHandle[] {
      return Array.from(handles.values());
    },

    cleanup(): number {
      let removed = 0;
      for (const [id, handle] of handles) {
        // Accessing .status triggers lazy TTL check
        if (handle.status === "expired") {
          handles.delete(id);
          removed++;
        }
      }
      return removed;
    },

    onTerminal(callback: (handle: WaitRunHandle) => void): () => void {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
}
