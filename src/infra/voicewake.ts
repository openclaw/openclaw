import { getCoreSettingFromDb, setCoreSettingInDb } from "./state-db/core-settings-sqlite.js";

export type VoiceWakeConfig = {
  triggers: string[];
  updatedAtMs: number;
};

const SCOPE = "voicewake";
const DEFAULT_TRIGGERS = ["openclaw", "claude", "computer"];

function sanitizeTriggers(triggers: string[] | undefined | null): string[] {
  const cleaned = (triggers ?? [])
    .map((w) => (typeof w === "string" ? w.trim() : ""))
    .filter((w) => w.length > 0);
  return cleaned.length > 0 ? cleaned : DEFAULT_TRIGGERS;
}

export function defaultVoiceWakeTriggers() {
  return [...DEFAULT_TRIGGERS];
}

export async function loadVoiceWakeConfig(_baseDir?: string): Promise<VoiceWakeConfig> {
  const existing = getCoreSettingFromDb<VoiceWakeConfig>(SCOPE);
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
  _baseDir?: string,
): Promise<VoiceWakeConfig> {
  const sanitized = sanitizeTriggers(triggers);
  const next: VoiceWakeConfig = {
    triggers: sanitized,
    updatedAtMs: Date.now(),
  };
  setCoreSettingInDb(SCOPE, "", next);
  return next;
}
