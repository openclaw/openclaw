import type { SessionEntry } from "./types.js";

/**
 * Abstract interface for session store persistence.
 *
 * Implementations handle the physical storage of session entries.
 * The default implementation uses the local filesystem; an "external"
 * adapter can delegate to a remote store (e.g. database or API).
 */
export type SessionStoreAdapter = {
  /** Load a single session entry by key. Returns undefined if not found. */
  load(sessionKey: string): SessionEntry | undefined;
  /** Persist a single session entry. */
  save(sessionKey: string, entry: SessionEntry): Promise<void>;
  /** List all known session keys. */
  list(): string[];
  /** Remove a session entry by key. */
  delete(sessionKey: string): Promise<void>;
  /** Efficient bulk read. If provided, used instead of iterating list()+load(). */
  toRecord?(): Record<string, SessionEntry>;
  /** Pre-populate adapter cache on activation. */
  warmCache?(): Promise<void>;
};
