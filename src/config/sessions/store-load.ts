import fs from "node:fs";
import {
  loadSqliteSessionStore,
  resolveSqliteSessionStoreOptionsForPath,
} from "./store-backend.sqlite.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionStore } from "./store-normalize.js";
import type { SessionEntry } from "./types.js";

export { normalizeSessionStore } from "./store-normalize.js";

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function loadSessionStore(storePath: string): Record<string, SessionEntry> {
  const sqliteOptions = resolveSqliteSessionStoreOptionsForPath(storePath);
  if (sqliteOptions) {
    return loadSqliteSessionStore(sqliteOptions);
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed = JSON.parse(raw);
      if (isSessionStoreRecord(parsed)) {
        store = parsed;
      }
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  applySessionStoreMigrations(store);
  normalizeSessionStore(store);
  return store;
}
