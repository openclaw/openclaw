import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { TtsAutoMode, TtsConfig, TtsProvider } from "../config/types.tts.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import { normalizeTtsAutoMode } from "./tts-auto-mode.js";

const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;

type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
};

type TtsStatusSnapshot = {
  autoMode: TtsAutoMode;
  provider: TtsProvider;
  maxLength: number;
  summarize: boolean;
};

function resolveConfiguredTtsAutoMode(raw: TtsConfig): TtsAutoMode {
  return normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off");
}

function normalizeConfiguredSpeechProviderId(
  providerId: string | undefined,
): TtsProvider | undefined {
  const normalized = providerId?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(CONFIG_DIR, "settings", "tts.json");
}

function readPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!fs.existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function resolveTtsAutoModeFromPrefs(prefs: TtsUserPrefs): TtsAutoMode | undefined {
  const auto = normalizeTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}

export function resolveStatusTtsSnapshot(params: {
  cfg: OpenClawConfig;
  sessionAuto?: string;
}): TtsStatusSnapshot | null {
  const raw: TtsConfig = params.cfg.messages?.tts ?? {};
  const prefsPath = resolveTtsPrefsPathValue(raw.prefsPath);
  const prefs = readPrefs(prefsPath);
  const autoMode =
    normalizeTtsAutoMode(params.sessionAuto) ??
    resolveTtsAutoModeFromPrefs(prefs) ??
    resolveConfiguredTtsAutoMode(raw);

  if (autoMode === "off") {
    return null;
  }

  return {
    autoMode,
    provider:
      normalizeConfiguredSpeechProviderId(prefs.tts?.provider) ??
      normalizeConfiguredSpeechProviderId(raw.provider) ??
      "auto",
    maxLength: prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH,
    summarize: prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE,
  };
}
