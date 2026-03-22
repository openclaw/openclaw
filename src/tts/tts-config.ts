import type { OpenClawConfig } from "../config/config.js";
import type { TtsAutoMode, TtsMode } from "../config/types.tts.js";

const TTS_AUTO_MODES = new Set<TtsAutoMode>(["off", "always", "inbound", "tagged"]);

export function normalizeTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (TTS_AUTO_MODES.has(normalized as TtsAutoMode)) {
    return normalized as TtsAutoMode;
  }
  return undefined;
}

export function resolveConfiguredTtsMode(cfg: OpenClawConfig): TtsMode {
  return cfg.messages?.tts?.mode ?? "final";
}
