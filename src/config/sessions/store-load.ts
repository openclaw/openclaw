import fs from "node:fs";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import {
  loadSqliteSessionStore,
  resolveSqliteSessionStoreOptionsForPath,
} from "./store-backend.sqlite.js";
import {
  cloneSessionStoreRecord,
  isSessionStoreCacheEnabled,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { resolveMaintenanceConfig } from "./store-maintenance-runtime.js";
import {
  capEntryCount,
  pruneStaleEntries,
  shouldRunSessionEntryMaintenance,
  type ResolvedSessionMaintenanceConfig,
} from "./store-maintenance.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionStore } from "./store-normalize.js";
import type { SessionEntry } from "./types.js";

export { normalizeSessionStore } from "./store-normalize.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
  maintenanceConfig?: ResolvedSessionMaintenanceConfig;
  runMaintenance?: boolean;
  clone?: boolean;
};

const log = createSubsystemLogger("sessions/store");

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  const sqliteOptions = resolveSqliteSessionStoreOptionsForPath(storePath);
  if (sqliteOptions) {
    return loadSqliteSessionStore(sqliteOptions);
  }

  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = readSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
      clone: opts.clone,
    });
    if (cached) {
      return cached;
    }
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  let fileStat = getFileStatSnapshot(storePath);
  let mtimeMs = fileStat?.mtimeMs;
  let serializedFromDisk: string | undefined;
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
        serializedFromDisk = raw;
      }
      fileStat = getFileStatSnapshot(storePath) ?? fileStat;
      mtimeMs = fileStat?.mtimeMs;
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  const migrated = applySessionStoreMigrations(store);
  const normalized = normalizeSessionStore(store);
  if (migrated || normalized) {
    serializedFromDisk = undefined;
  }
  if (opts.runMaintenance) {
    const maintenance = opts.maintenanceConfig ?? resolveMaintenanceConfig();
    const beforeCount = Object.keys(store).length;
    let pruned = 0;
    let capped = 0;
    if (maintenance.mode === "enforce" && beforeCount > maintenance.maxEntries) {
      pruned = pruneStaleEntries(store, maintenance.pruneAfterMs, { log: false });
      const countAfterPrune = Object.keys(store).length;
      capped = shouldRunSessionEntryMaintenance({
        entryCount: countAfterPrune,
        maxEntries: maintenance.maxEntries,
      })
        ? capEntryCount(store, maintenance.maxEntries, { log: false })
        : 0;
    }
    const afterCount = Object.keys(store).length;
    if (pruned > 0 || capped > 0) {
      serializedFromDisk = undefined;
      log.info("applied load-time maintenance to session store", {
        storePath,
        before: beforeCount,
        after: afterCount,
        pruned,
        capped,
        maxEntries: maintenance.maxEntries,
      });
    }
  }

  setSerializedSessionStore(storePath, serializedFromDisk);

  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs,
      sizeBytes: fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  }

  return opts.clone === false ? store : cloneSessionStoreRecord(store, serializedFromDisk);
}
