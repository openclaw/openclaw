import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type { TtsAutoMode, TtsProvider } from "../config/types.tts.js";
import { CONFIG_DIR, resolveUserPath } from "../utils.js";
import type { ResolvedTtsConfig } from "./tts-config.js";

export const DEFAULT_EXTENSION_HOST_TTS_MAX_LENGTH = 1500;
export const DEFAULT_EXTENSION_HOST_TTS_SUMMARIZE = true;

type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    maxLength?: number;
    summarize?: boolean;
  };
};

function readExtensionHostTtsPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return JSON.parse(readFileSync(prefsPath, "utf8")) as TtsUserPrefs;
  } catch {
    return {};
  }
}

function atomicWriteExtensionHostTtsPrefs(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp.${Date.now()}.${randomBytes(8).toString("hex")}`;
  writeFileSync(tmpPath, content, { mode: 0o600 });
  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

function updateExtensionHostTtsPrefs(
  prefsPath: string,
  update: (prefs: TtsUserPrefs) => void,
): void {
  const prefs = readExtensionHostTtsPrefs(prefsPath);
  update(prefs);
  mkdirSync(path.dirname(prefsPath), { recursive: true });
  atomicWriteExtensionHostTtsPrefs(prefsPath, JSON.stringify(prefs, null, 2));
}

export function normalizeExtensionHostTtsAutoMode(value: unknown): TtsAutoMode | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "off" ||
    normalized === "always" ||
    normalized === "inbound" ||
    normalized === "tagged"
    ? normalized
    : undefined;
}

export function resolveExtensionHostTtsPrefsPath(config: ResolvedTtsConfig): string {
  if (config.prefsPath?.trim()) {
    return resolveUserPath(config.prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(CONFIG_DIR, "settings", "tts.json");
}

function resolveExtensionHostTtsAutoModeFromPrefs(prefs: TtsUserPrefs): TtsAutoMode | undefined {
  const auto = normalizeExtensionHostTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}

export function resolveExtensionHostTtsAutoMode(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
}): TtsAutoMode {
  const sessionAuto = normalizeExtensionHostTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return sessionAuto;
  }
  const prefsAuto = resolveExtensionHostTtsAutoModeFromPrefs(
    readExtensionHostTtsPrefs(params.prefsPath),
  );
  if (prefsAuto) {
    return prefsAuto;
  }
  return params.config.auto;
}

export function isExtensionHostTtsEnabled(
  config: ResolvedTtsConfig,
  prefsPath: string,
  sessionAuto?: string,
): boolean {
  return resolveExtensionHostTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}

export function setExtensionHostTtsAutoMode(prefsPath: string, mode: TtsAutoMode): void {
  updateExtensionHostTtsPrefs(prefsPath, (prefs) => {
    const next = { ...prefs.tts };
    delete next.enabled;
    next.auto = mode;
    prefs.tts = next;
  });
}

export function setExtensionHostTtsEnabled(prefsPath: string, enabled: boolean): void {
  setExtensionHostTtsAutoMode(prefsPath, enabled ? "always" : "off");
}

export function setExtensionHostTtsProvider(prefsPath: string, provider: TtsProvider): void {
  updateExtensionHostTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, provider };
  });
}

export function getExtensionHostTtsMaxLength(prefsPath: string): number {
  const prefs = readExtensionHostTtsPrefs(prefsPath);
  return prefs.tts?.maxLength ?? DEFAULT_EXTENSION_HOST_TTS_MAX_LENGTH;
}

export function setExtensionHostTtsMaxLength(prefsPath: string, maxLength: number): void {
  updateExtensionHostTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, maxLength };
  });
}

export function isExtensionHostTtsSummarizationEnabled(prefsPath: string): boolean {
  const prefs = readExtensionHostTtsPrefs(prefsPath);
  return prefs.tts?.summarize ?? DEFAULT_EXTENSION_HOST_TTS_SUMMARIZE;
}

export function setExtensionHostTtsSummarizationEnabled(prefsPath: string, enabled: boolean): void {
  updateExtensionHostTtsPrefs(prefsPath, (prefs) => {
    prefs.tts = { ...prefs.tts, summarize: enabled };
  });
}
