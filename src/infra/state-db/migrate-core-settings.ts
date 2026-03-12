/**
 * One-shot migration: Phase 4B core settings JSON files → SQLite core_settings table.
 *
 * Covers 7 files:
 *   - settings/voicewake.json   → scope="voicewake"
 *   - settings/tts.json         → scope="tts"
 *   - identity/device.json      → scope="device"
 *   - identity/device-auth.json → scope="device-auth"
 *   - restart-sentinel.json     → scope="gateway", key="restart-sentinel"
 *   - update-check.json         → scope="gateway", key="update-check"
 *   - push/apns-registrations.json → scope="push"
 *
 * Each migrator reads the JSON file, inserts into core_settings, then deletes the file.
 * Idempotent: skips if DB already has data for the scope+key; files are removed after migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile } from "../json-file.js";
import { getCoreSettingFromDb, setCoreSettingInDb } from "./core-settings-sqlite.js";

type MigrationResult = {
  store: string;
  count: number;
  migrated: boolean;
  error?: string;
};

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * Generic migrator for a single JSON file → core_settings row.
 * Reads the file, stores the parsed value under (scope, key), deletes the file.
 */
function migrateSettingsFile(opts: {
  store: string;
  filePath: string;
  scope: string;
  key: string;
}): MigrationResult {
  const result: MigrationResult = { store: opts.store, count: 0, migrated: false };

  try {
    if (!fs.existsSync(opts.filePath)) {
      return result;
    }

    // Skip if DB already has data for this scope+key
    const existing = getCoreSettingFromDb(opts.scope, opts.key);
    if (existing != null) {
      tryUnlink(opts.filePath);
      return result;
    }

    const raw = loadJsonFile(opts.filePath);
    if (raw == null || typeof raw !== "object") {
      tryUnlink(opts.filePath);
      return result;
    }

    setCoreSettingInDb(opts.scope, opts.key, raw);
    result.count = 1;
    result.migrated = true;
    tryUnlink(opts.filePath);
    // Also clean up backup files
    tryUnlink(`${opts.filePath}.bak`);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function migrateCoreSettingsToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): MigrationResult[] {
  const stateDir = resolveStateDir(env, () => os.homedir());

  return [
    // settings/voicewake.json → scope="voicewake"
    migrateSettingsFile({
      store: "voicewake",
      filePath: path.join(stateDir, "settings", "voicewake.json"),
      scope: "voicewake",
      key: "",
    }),

    // settings/tts.json → scope="tts"
    migrateSettingsFile({
      store: "tts",
      filePath: path.join(stateDir, "settings", "tts.json"),
      scope: "tts",
      key: "",
    }),

    // identity/device.json → scope="device"
    migrateSettingsFile({
      store: "device-identity",
      filePath: path.join(stateDir, "identity", "device.json"),
      scope: "device",
      key: "",
    }),

    // identity/device-auth.json → scope="device-auth"
    migrateSettingsFile({
      store: "device-auth",
      filePath: path.join(stateDir, "identity", "device-auth.json"),
      scope: "device-auth",
      key: "",
    }),

    // restart-sentinel.json → scope="gateway", key="restart-sentinel"
    migrateSettingsFile({
      store: "restart-sentinel",
      filePath: path.join(stateDir, "restart-sentinel.json"),
      scope: "gateway",
      key: "restart-sentinel",
    }),

    // update-check.json → scope="gateway", key="update-check"
    migrateSettingsFile({
      store: "update-check",
      filePath: path.join(stateDir, "update-check.json"),
      scope: "gateway",
      key: "update-check",
    }),

    // push/apns-registrations.json → scope="push"
    migrateSettingsFile({
      store: "apns-registrations",
      filePath: path.join(stateDir, "push", "apns-registrations.json"),
      scope: "push",
      key: "",
    }),
  ];
}
