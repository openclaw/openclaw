/**
 * One-shot migration: Phase 5C node-host config JSON file → SQLite.
 *
 * Covers:
 *   ~/.openclaw/node.json → core_settings(scope='node-host', key='config')
 *
 * Idempotent: skips if DB already has data.
 * File is removed after migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { NodeHostConfig } from "../../node-host/config.js";
import { loadJsonFile } from "../json-file.js";
import { getCoreSettingFromDb, setCoreSettingInDb } from "./core-settings-sqlite.js";

const SCOPE = "node-host";
const KEY = "config";

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

function migrateNodeHostConfig(stateDir: string): MigrationResult {
  const result: MigrationResult = { store: "node-host-config", count: 0, migrated: false };
  const filePath = path.join(stateDir, "node.json");

  try {
    if (!fs.existsSync(filePath)) {
      return result;
    }

    // Skip if DB already has data
    if (getCoreSettingFromDb(SCOPE, KEY) !== null) {
      tryUnlink(filePath);
      return result;
    }

    const raw = loadJsonFile(filePath) as Partial<NodeHostConfig> | null;
    if (raw && typeof raw === "object") {
      setCoreSettingInDb(SCOPE, KEY, raw);
      result.count = 1;
      result.migrated = true;
    }
    tryUnlink(filePath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

export function migratePhase5cToSqlite(env: NodeJS.ProcessEnv = process.env): MigrationResult[] {
  const stateDir = resolveStateDir(env, () => os.homedir());
  return [migrateNodeHostConfig(stateDir)];
}
