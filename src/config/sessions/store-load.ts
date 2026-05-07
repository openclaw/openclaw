import {
  loadSqliteSessionStore,
  resolveSqliteSessionStoreOptionsForPath,
} from "./store-backend.sqlite.js";
import type { SessionEntry } from "./types.js";

export { normalizeSessionStore } from "./store-normalize.js";

export function loadSessionStore(storePath: string): Record<string, SessionEntry> {
  const sqliteOptions = resolveSqliteSessionStoreOptionsForPath(storePath);
  if (!sqliteOptions) {
    throw new Error(`Session stores are SQLite-only; cannot resolve agent for ${storePath}`);
  }
  return loadSqliteSessionStore(sqliteOptions);
}
