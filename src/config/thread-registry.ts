/**
 * Thread-Session Binding Registry
 *
 * Persistent, in-memory bidirectional map that tracks which sessions are bound
 * to which platform threads.  Rebuilt from the session store on load and kept
 * in sync as sessions are created/updated/removed.
 *
 * Key concepts:
 *   threadKey  – normalized string  `<channel>:<accountId?>:<threadId>`
 *   sessionKey – existing session key (e.g. `agent:dev:subagent:<uuid>`)
 *
 * One thread can have many bound sessions (fan-out).
 * Each session can be bound to at most one thread.
 */

/**
 * Thread binding configuration stored on a SessionEntry.
 */
export type ThreadBinding = {
  /** Platform channel type (e.g. "slack", "discord", "telegram"). */
  channel: string;
  /** Platform-specific account / workspace id. */
  accountId?: string;
  /** Destination channel/group/DM identifier for delivery (e.g., Slack channel "C12345"). */
  to?: string;
  /** Platform thread identifier. */
  threadId: string;
  /** Root message id that started the thread (for creation tracking). */
  threadRootId?: string;

  /** Delivery mode for agent responses. */
  mode: "thread-only" | "thread+announcer" | "announcer-only";
  /** Whether to route cross-thread replies to the parent session. */
  inheritParent?: boolean;

  /** Unix-ms timestamp when binding was created. */
  boundAt: number;
  /** Session key that created the binding. */
  createdBy?: string;
  /** Human-readable label for discovery. */
  label?: string;
};

// ---------------------------------------------------------------------------
// Thread key helpers
// ---------------------------------------------------------------------------

/**
 * Build a normalised thread key from its components.
 *
 * Format: `<channel>:<accountId?>:<threadId>`
 *
 * The `accountId` segment is always present (empty string when absent) so that
 * `parseThreadKey` can round-trip reliably even when the threadId itself
 * contains colons.
 */
export function buildThreadKey(params: {
  channel: string;
  accountId?: string;
  threadId: string;
}): string {
  const accountPart = params.accountId ?? "";
  return `${params.channel}:${accountPart}:${params.threadId}`;
}

/**
 * Parse a thread key back to its components.  Returns `null` for malformed
 * keys (fewer than 3 colon-separated segments).
 */
export function parseThreadKey(
  threadKey: string,
): { channel: string; accountId?: string; threadId: string } | null {
  const idx1 = threadKey.indexOf(":");
  if (idx1 === -1) return null;

  const idx2 = threadKey.indexOf(":", idx1 + 1);
  if (idx2 === -1) return null;

  const channel = threadKey.slice(0, idx1);
  const accountId = threadKey.slice(idx1 + 1, idx2) || undefined;
  const threadId = threadKey.slice(idx2 + 1);

  if (!channel || !threadId) return null;

  return { channel, accountId, threadId };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * In-memory bidirectional map: threadKey ↔ sessionKey.
 */
export class ThreadBindingRegistry {
  /** threadKey → Set<sessionKey> */
  private threadToSessions = new Map<string, Set<string>>();
  /** sessionKey → threadKey */
  private sessionToThread = new Map<string, string>();
  /** sessionKey → ThreadBinding — stores the full binding metadata for revival */
  private sessionBindings = new Map<string, ThreadBinding>();
  /** storePath → Set<sessionKey> — tracks which session keys were indexed from each store */
  private storeSessionKeys = new Map<string, Set<string>>();

  // -- mutations ------------------------------------------------------------

  /**
   * Bind a session to a thread.  If the session was previously bound to a
   * different thread it is unbound first.
   */
  bind(sessionKey: string, threadKey: string, binding?: ThreadBinding): void {
    // If already bound to a *different* thread, unbind first.
    const prev = this.sessionToThread.get(sessionKey);
    if (prev !== undefined && prev !== threadKey) {
      this.unbind(sessionKey);
    }

    let sessions = this.threadToSessions.get(threadKey);
    if (!sessions) {
      sessions = new Set();
      this.threadToSessions.set(threadKey, sessions);
    }
    sessions.add(sessionKey);
    this.sessionToThread.set(sessionKey, threadKey);

    // Store the full binding metadata if provided
    if (binding) {
      this.sessionBindings.set(sessionKey, binding);
    }
  }

  /**
   * Unbind a session from its thread.  Returns `true` if the session was
   * actually bound.
   */
  unbind(sessionKey: string): boolean {
    const threadKey = this.sessionToThread.get(sessionKey);
    if (threadKey === undefined) return false;

    const sessions = this.threadToSessions.get(threadKey);
    if (sessions) {
      sessions.delete(sessionKey);
      if (sessions.size === 0) {
        this.threadToSessions.delete(threadKey);
      }
    }
    this.sessionToThread.delete(sessionKey);
    // Note: Keep sessionBindings entry — we need it for revival lookup of dead sessions
    return true;
  }

  // -- queries --------------------------------------------------------------

  /** Return all session keys bound to a thread (empty array if none). */
  lookup(threadKey: string): string[] {
    const sessions = this.threadToSessions.get(threadKey);
    return sessions ? Array.from(sessions) : [];
  }

  /** Return the threadKey a session is bound to, or `undefined`. */
  getBinding(sessionKey: string): string | undefined {
    return this.sessionToThread.get(sessionKey);
  }

  /** Return the full ThreadBinding metadata for a session, or `undefined`. */
  getBindingData(sessionKey: string): ThreadBinding | undefined {
    return this.sessionBindings.get(sessionKey);
  }

  /** Check whether a session is bound to any thread. */
  isBound(sessionKey: string): boolean {
    return this.sessionToThread.has(sessionKey);
  }

  // -- bulk operations ------------------------------------------------------

  /**
   * @deprecated Use {@link mergeFromSessions} instead. This method clears ALL
   * bindings before re-indexing, which evicts other agents' bindings when
   * per-agent session stores are used.
   */
  rebuildFromSessions(sessions: Record<string, { threadBinding?: ThreadBinding }>): void {
    this.threadToSessions.clear();
    this.sessionToThread.clear();
    this.sessionBindings.clear();
    this.storeSessionKeys.clear();

    for (const [sessionKey, entry] of Object.entries(sessions)) {
      if (entry?.threadBinding) {
        const threadKey = buildThreadKey({
          channel: entry.threadBinding.channel,
          accountId: entry.threadBinding.accountId,
          threadId: entry.threadBinding.threadId,
        });
        this.bind(sessionKey, threadKey, entry.threadBinding);
      }
    }
  }

  /**
   * Merge bindings from a single session store into the registry.
   *
   * Only clears bindings previously owned by the given `storePath`, then
   * re-indexes that store's sessions.  Bindings from other stores are left
   * intact.
   */
  mergeFromSessions(
    storePath: string,
    sessions: Record<string, { threadBinding?: ThreadBinding }>,
  ): void {
    // 1. Remove bindings previously owned by this store path.
    const previousKeys = this.storeSessionKeys.get(storePath);
    if (previousKeys) {
      for (const sessionKey of previousKeys) {
        this.unbind(sessionKey);
      }
    }

    // 2. Re-index sessions from this store and track ownership.
    const newKeys = new Set<string>();
    for (const [sessionKey, entry] of Object.entries(sessions)) {
      if (entry?.threadBinding) {
        const threadKey = buildThreadKey({
          channel: entry.threadBinding.channel,
          accountId: entry.threadBinding.accountId,
          threadId: entry.threadBinding.threadId,
        });
        this.bind(sessionKey, threadKey, entry.threadBinding);
        newKeys.add(sessionKey);
      }
    }

    // 3. Update ownership tracking.
    if (newKeys.size > 0) {
      this.storeSessionKeys.set(storePath, newKeys);
    } else {
      this.storeSessionKeys.delete(storePath);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let registryInstance: ThreadBindingRegistry | null = null;

/** Return the singleton thread-binding registry, creating it on first call. */
export function getThreadRegistry(): ThreadBindingRegistry {
  if (!registryInstance) {
    registryInstance = new ThreadBindingRegistry();
  }
  return registryInstance;
}

/** Reset the singleton (for tests). */
export function resetThreadRegistry(): void {
  registryInstance = null;
}

// ---------------------------------------------------------------------------
// Binding lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Bind a session to a thread: updates the session store entry and the
 * in-memory registry in one atomic operation.
 */
export async function bindSessionToThread(params: {
  storePath: string;
  sessionKey: string;
  binding: ThreadBinding;
}): Promise<void> {
  const { updateSessionStore } = await import("./sessions/store.js");
  const { mergeSessionEntry } = await import("./sessions/types.js");
  const { storePath, sessionKey, binding } = params;

  await updateSessionStore(storePath, (store) => {
    const existing = store[sessionKey];
    store[sessionKey] = mergeSessionEntry(existing, { threadBinding: binding });
  });
  // Registry is rebuilt inside saveSessionStore, so no manual sync needed.
}

/**
 * Remove the thread binding from a session.  Returns `true` if the session
 * existed and had a binding that was removed.
 */
export async function unbindSessionFromThread(params: {
  storePath: string;
  sessionKey: string;
}): Promise<boolean> {
  const { updateSessionStore } = await import("./sessions/store.js");
  const { storePath, sessionKey } = params;

  let removed = false;
  await updateSessionStore(storePath, (store) => {
    const entry = store[sessionKey];
    if (!entry?.threadBinding) return;
    delete entry.threadBinding;
    removed = true;
  });
  // Registry is rebuilt inside saveSessionStore, so the unbind is reflected.
  return removed;
}

/**
 * Query: find all session keys bound to a specific thread.
 */
export function findSessionsByThread(params: {
  channel: string;
  accountId?: string;
  threadId: string;
}): string[] {
  const threadKey = buildThreadKey(params);
  return getThreadRegistry().lookup(threadKey);
}

/**
 * Query: return the ThreadBinding stored on a session entry, or `undefined`.
 *
 * Uses a dynamic import to avoid circular dependency issues at module-load
 * time.  Because `loadSessionStore` is synchronous (reads from cache / disk)
 * and the import is cached after the first call, the overall overhead is
 * negligible.
 */
export async function getSessionThreadBinding(params: {
  storePath: string;
  sessionKey: string;
}): Promise<ThreadBinding | undefined> {
  const { loadSessionStore } = await import("./sessions/store.js");
  const store = loadSessionStore(params.storePath);
  return store[params.sessionKey]?.threadBinding;
}
