import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../state/openclaw-state-kv.js";

export type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];
const VOICEWAKE_SCOPE = "voicewake";
const VOICEWAKE_CONFIG_KEY = "triggers";

function sqliteOptionsForBaseDir(baseDir: string | undefined): OpenClawStateDatabaseOptions {
  return baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } } : {};
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

export function normalizeVoiceWakeConfigSnapshot(raw: unknown): VoiceWakeConfig {
  const updatedAtMs = (raw as Partial<VoiceWakeConfig> | undefined)?.updatedAtMs;
  return {
    triggers: sanitizeTriggers((raw as Partial<VoiceWakeConfig> | undefined)?.triggers),
    updatedAtMs: typeof updatedAtMs === "number" && updatedAtMs > 0 ? updatedAtMs : 0,
  };
}

export function writeVoiceWakeConfigSnapshot(config: VoiceWakeConfig, baseDir?: string): void {
  writeOpenClawStateKvJson<OpenClawStateJsonValue>(
    VOICEWAKE_SCOPE,
    VOICEWAKE_CONFIG_KEY,
    config as unknown as OpenClawStateJsonValue,
    sqliteOptionsForBaseDir(baseDir),
  );
}
