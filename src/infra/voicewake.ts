import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];
const VOICEWAKE_SCOPE = "voicewake";
const VOICEWAKE_CONFIG_KEY = "triggers";

function sqliteOptionsForBaseDir(baseDir: string | undefined): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
}

function resolveLegacyPath(baseDir?: string) {
  const root = baseDir ?? resolveStateDir();
  return path.join(root, "settings", "voicewake.json");
}

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => normalizeOptionalString(w) ?? "")
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

export async function loadVoiceWakeConfig(baseDir?: string): Promise<VoiceWakeConfig> {
  const existing = readOpenClawStateKvJson(
    VOICEWAKE_SCOPE,
    VOICEWAKE_CONFIG_KEY,
    sqliteOptionsForBaseDir(baseDir),
  ) as Partial<VoiceWakeConfig> | undefined;
  if (!existing) {
    return { triggers: defaultVoiceWakeTriggers(), updatedAtMs: 0 };
  }
  return {
    triggers: sanitizeTriggers(existing.triggers),
    updatedAtMs:
      typeof existing.updatedAtMs === "number" && existing.updatedAtMs > 0
        ? existing.updatedAtMs
        : 0,
  };
}

export async function setVoiceWakeTriggers(
  triggers: string[],
  baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
  const next: VoiceWakeConfig = {
    triggers: sanitized,
    updatedAtMs: Date.now(),
  };
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    VOICEWAKE_SCOPE,
    VOICEWAKE_CONFIG_KEY,
    next as unknown as OpenClawStateJsonValue,
    sqliteOptionsForBaseDir(baseDir),
  );
  return next;
}

export async function legacyVoiceWakeConfigFileExists(baseDir?: string): Promise<boolean> {
  try {
    await fs.access(resolveLegacyPath(baseDir));
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function importLegacyVoiceWakeConfigFileToSqlite(baseDir?: string): Promise<{
  imported: boolean;
  triggers: number;
}> {
  const filePath = resolveLegacyPath(baseDir);
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ENOENT") {
      return { imported: false, triggers: 0 };
    }
    throw error;
  }
  const normalized = {
    triggers: sanitizeTriggers((raw as Partial<VoiceWakeConfig> | undefined)?.triggers),
    updatedAtMs:
      typeof (raw as Partial<VoiceWakeConfig> | undefined)?.updatedAtMs === "number" &&
      ((raw as Partial<VoiceWakeConfig>).updatedAtMs ?? 0) > 0
        ? (raw as Partial<VoiceWakeConfig>).updatedAtMs
        : 0,
  };
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    VOICEWAKE_SCOPE,
    VOICEWAKE_CONFIG_KEY,
    normalized as OpenClawStateJsonValue,
    sqliteOptionsForBaseDir(baseDir),
  );
  await fs.rm(filePath, { force: true }).catch(() => undefined);
  return { imported: true, triggers: normalized.triggers.length };
}
