/**
 * One-shot migration: Phase 4C channel state + credentials JSON files → SQLite.
 *
 * Covers:
 *   - telegram/update-offset-{acctId}.json → channel_tg_state(account_id, key='update_offset')
 *   - telegram/sticker-cache.json → channel_tg_state(account_id='global', key='sticker_cache')
 *   - discord/model-picker-preferences.json → channel_dc_state(key, scope)
 *   - credentials/github-copilot.token.json → auth_credentials(provider='github-copilot')
 *
 * Each migrator reads the JSON file, inserts rows, then deletes the file.
 * Idempotent: skips if DB already has data; files are removed after migration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile } from "../json-file.js";
import { setAuthCredentialsInDb } from "./auth-credentials-sqlite.js";
import { setDcStateInDb } from "./channel-dc-state-sqlite.js";
import { getTgStateFromDb, setTgStateInDb } from "./channel-tg-state-sqlite.js";

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

// ── Telegram Update Offsets ─────────────────────────────────────────────────

function migrateTelegramUpdateOffsets(stateDir: string): MigrationResult {
  const result: MigrationResult = { store: "telegram-update-offsets", count: 0, migrated: false };
  const tgDir = path.join(stateDir, "telegram");

  try {
    if (!fs.existsSync(tgDir)) {
      return result;
    }

    const files = fs
      .readdirSync(tgDir)
      .filter((f) => f.startsWith("update-offset-") && f.endsWith(".json"));
    for (const file of files) {
      const filePath = path.join(tgDir, file);
      const accountId = file.replace(/^update-offset-/, "").replace(/\.json$/, "");

      // Skip if DB already has data for this account
      const existing = getTgStateFromDb(accountId, "update_offset");
      if (existing != null) {
        tryUnlink(filePath);
        continue;
      }

      const raw = loadJsonFile(filePath) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") {
        tryUnlink(filePath);
        continue;
      }

      const lastUpdateId = raw.lastUpdateId;
      const botId = raw.botId;
      if (
        typeof lastUpdateId !== "number" ||
        !Number.isSafeInteger(lastUpdateId) ||
        lastUpdateId < 0
      ) {
        tryUnlink(filePath);
        continue;
      }

      setTgStateInDb(accountId, "update_offset", {
        lastUpdateId,
        botId: typeof botId === "string" ? botId : null,
      });
      result.count++;
      result.migrated = true;
      tryUnlink(filePath);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── Telegram Sticker Cache ──────────────────────────────────────────────────

function migrateTelegramStickerCache(stateDir: string): MigrationResult {
  const result: MigrationResult = { store: "telegram-sticker-cache", count: 0, migrated: false };
  const filePath = path.join(stateDir, "telegram", "sticker-cache.json");

  try {
    if (!fs.existsSync(filePath)) {
      return result;
    }

    // Skip if DB already has data
    const existing = getTgStateFromDb("global", "sticker_cache");
    if (existing != null) {
      tryUnlink(filePath);
      return result;
    }

    const raw = loadJsonFile(filePath) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      tryUnlink(filePath);
      return result;
    }

    const stickers = raw.stickers;
    if (!stickers || typeof stickers !== "object") {
      tryUnlink(filePath);
      return result;
    }

    // Store just the stickers record (not the version wrapper)
    setTgStateInDb("global", "sticker_cache", stickers);
    result.count = Object.keys(stickers as Record<string, unknown>).length;
    result.migrated = true;
    tryUnlink(filePath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── Discord Model Picker Preferences ────────────────────────────────────────

function migrateDiscordModelPickerPreferences(stateDir: string): MigrationResult {
  const result: MigrationResult = {
    store: "discord-model-picker-preferences",
    count: 0,
    migrated: false,
  };
  const filePath = path.join(stateDir, "discord", "model-picker-preferences.json");

  try {
    if (!fs.existsSync(filePath)) {
      return result;
    }

    const raw = loadJsonFile(filePath) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object" || raw.version !== 1) {
      tryUnlink(filePath);
      return result;
    }

    const entries = raw.entries;
    if (!entries || typeof entries !== "object") {
      tryUnlink(filePath);
      return result;
    }

    for (const [scope, value] of Object.entries(entries as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      setDcStateInDb("model_picker_preferences", scope, value);
      result.count++;
    }

    if (result.count > 0) {
      result.migrated = true;
    }
    tryUnlink(filePath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── GitHub Copilot Token ────────────────────────────────────────────────────

function migrateGithubCopilotToken(stateDir: string): MigrationResult {
  const result: MigrationResult = { store: "github-copilot-token", count: 0, migrated: false };
  const filePath = path.join(stateDir, "credentials", "github-copilot.token.json");

  try {
    if (!fs.existsSync(filePath)) {
      return result;
    }

    const raw = loadJsonFile(filePath) as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") {
      tryUnlink(filePath);
      return result;
    }

    const token = raw.token;
    const expiresAt = raw.expiresAt;
    if (typeof token !== "string" || typeof expiresAt !== "number") {
      tryUnlink(filePath);
      return result;
    }

    setAuthCredentialsInDb("github-copilot", "", raw, expiresAt);
    result.count = 1;
    result.migrated = true;
    tryUnlink(filePath);
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────

export function migrateChannelStateToSqlite(
  env: NodeJS.ProcessEnv = process.env,
): MigrationResult[] {
  const stateDir = resolveStateDir(env, () => os.homedir());

  return [
    migrateTelegramUpdateOffsets(stateDir),
    migrateTelegramStickerCache(stateDir),
    migrateDiscordModelPickerPreferences(stateDir),
    migrateGithubCopilotToken(stateDir),
  ];
}
