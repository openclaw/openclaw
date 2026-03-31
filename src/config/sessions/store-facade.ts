/**
 * Session store facade - abstraction layer for JSON vs SQLite backends.
 *
 * This module provides a unified interface for session storage that:
 * 1. Reads the session.storeType config to choose the backend
 * 2. Auto-migrates from JSON to SQLite on first SQLite access
 * 3. Falls back to JSON if SQLite is unavailable
 *
 * Two-tier architecture:
 * - Hot index (SQLite or JSON): Session metadata for fast queries
 * - Cold storage: Existing .jsonl transcript files (unchanged)
 */
import { existsSync } from "node:fs";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { loadConfig } from "../config.js";
import type { SessionStoreType } from "../types.base.js";
import {
  closeSessionDatabase,
  getSessionCountSqlite,
  loadSessionStoreSqlite,
  migrateJsonToSqlite,
  resolveSqlitePathFromJsonPath,
  saveSessionStoreSqlite,
  sqliteStoreExists,
} from "./store-sqlite.js";
import type { SessionEntry } from "./types.js";

/**
 * Resolve the configured session store type.
 * Defaults to "json" for backward compatibility.
 */
export function resolveSessionStoreType(): SessionStoreType {
  try {
    const config = loadConfig();
    const storeType = config.session?.storeType;
    if (storeType === "sqlite") {
      return "sqlite";
    }
    return "json";
  } catch {
    return "json";
  }
}

/**
 * Check if SQLite is available in the current Node runtime.
 * Uses createRequire-based loader to work correctly in ESM context.
 */
export function isSqliteAvailable(): boolean {
  try {
    requireNodeSqlite();
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine the effective store type, falling back to JSON if SQLite unavailable.
 */
export function resolveEffectiveStoreType(): SessionStoreType {
  const configured = resolveSessionStoreType();
  if (configured === "sqlite" && !isSqliteAvailable()) {
    return "json";
  }
  return configured;
}

/**
 * Migration state tracking to avoid repeated migration attempts.
 */
const migrationAttempted = new Set<string>();

/**
 * Ensure SQLite store is migrated from JSON if needed.
 * Returns true if migration was successful or not needed.
 */
function ensureSqliteMigrated(jsonStorePath: string, sqlitePath: string): boolean {
  const key = `${jsonStorePath}:${sqlitePath}`;
  if (migrationAttempted.has(key)) {
    return true;
  }
  migrationAttempted.add(key);

  // If SQLite already exists and has data, skip migration
  if (sqliteStoreExists(sqlitePath) && getSessionCountSqlite(sqlitePath) > 0) {
    return true;
  }

  // If JSON exists, migrate it
  if (existsSync(jsonStorePath)) {
    try {
      migrateJsonToSqlite(jsonStorePath, sqlitePath);
      return true;
    } catch {
      return false;
    }
  }

  return true;
}

export type StoreLoadResult = {
  store: Record<string, SessionEntry>;
  storeType: SessionStoreType;
  sqlitePath?: string;
};

/**
 * Load session store using the configured backend.
 * Handles migration from JSON to SQLite when switching backends.
 */
export function loadSessionStoreWithFacade(
  jsonStorePath: string,
  jsonLoader: () => Record<string, SessionEntry>,
): StoreLoadResult {
  const storeType = resolveEffectiveStoreType();

  if (storeType === "sqlite") {
    const sqlitePath = resolveSqlitePathFromJsonPath(jsonStorePath);

    // Ensure migration from JSON on first access
    ensureSqliteMigrated(jsonStorePath, sqlitePath);

    try {
      const store = loadSessionStoreSqlite(sqlitePath);
      return { store, storeType: "sqlite", sqlitePath };
    } catch {
      // Fall back to JSON if SQLite fails
      return { store: jsonLoader(), storeType: "json" };
    }
  }

  return { store: jsonLoader(), storeType: "json" };
}

/**
 * Save session store using the configured backend.
 */
export function saveSessionStoreWithFacade(
  jsonStorePath: string,
  store: Record<string, SessionEntry>,
  jsonSaver: () => Promise<void>,
): Promise<void> {
  const storeType = resolveEffectiveStoreType();

  if (storeType === "sqlite") {
    const sqlitePath = resolveSqlitePathFromJsonPath(jsonStorePath);
    try {
      saveSessionStoreSqlite(sqlitePath, store);
      return Promise.resolve();
    } catch {
      // Fall back to JSON if SQLite fails
      return jsonSaver();
    }
  }

  return jsonSaver();
}

/**
 * Get session store statistics.
 */
export type SessionStoreStats = {
  storeType: SessionStoreType;
  effectiveStoreType: SessionStoreType;
  sqliteAvailable: boolean;
  sessionCount: number;
  sqlitePath?: string;
  jsonPath: string;
};

export function getSessionStoreStats(jsonStorePath: string): SessionStoreStats {
  const configuredType = resolveSessionStoreType();
  const sqliteAvailable = isSqliteAvailable();
  const effectiveType = resolveEffectiveStoreType();
  const sqlitePath = resolveSqlitePathFromJsonPath(jsonStorePath);

  let sessionCount = 0;
  if (effectiveType === "sqlite" && sqliteStoreExists(sqlitePath)) {
    sessionCount = getSessionCountSqlite(sqlitePath);
  }

  return {
    storeType: configuredType,
    effectiveStoreType: effectiveType,
    sqliteAvailable,
    sessionCount,
    sqlitePath: effectiveType === "sqlite" ? sqlitePath : undefined,
    jsonPath: jsonStorePath,
  };
}

/**
 * Reset facade state for testing.
 */
export function resetSessionStoreFacadeForTest(): void {
  migrationAttempted.clear();
  closeSessionDatabase();
}
