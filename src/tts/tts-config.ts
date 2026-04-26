import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsConfig, TtsMode } from "../config/types.tts.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { normalizeTtsAutoMode } from "./tts-auto-mode.js";
export { normalizeTtsAutoMode } from "./tts-auto-mode.js";

const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMergeDefined(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined ? base : override;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (BLOCKED_MERGE_KEYS.has(key) || value === undefined) {
      continue;
    }
    const existing = result[key];
    result[key] = key in result ? deepMergeDefined(existing, value) : value;
  }
  return result;
}

function resolveAgentTtsOverride(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): TtsConfig | undefined {
  if (!agentId || !Array.isArray(cfg.agents?.list)) {
    return undefined;
  }
  const normalized = normalizeAgentId(agentId);
  const agent = cfg.agents.list.find((entry) => normalizeAgentId(entry.id) === normalized);
  return agent?.tts;
}

export function resolveEffectiveTtsConfig(cfg: OpenClawConfig, agentId?: string): TtsConfig {
  const base = cfg.messages?.tts ?? {};
  const override = resolveAgentTtsOverride(cfg, agentId);
  return deepMergeDefined(base, override ?? {}) as TtsConfig;
}

export function resolveConfiguredTtsMode(cfg: OpenClawConfig, agentId?: string): TtsMode {
  return resolveEffectiveTtsConfig(cfg, agentId).mode ?? "final";
}

function resolveTtsPrefsPathValue(prefsPath: string | undefined): string {
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

function readTtsPrefsAutoMode(prefsPath: string): TtsAutoMode | undefined {
  try {
    if (!existsSync(prefsPath)) {
      return undefined;
    }
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as {
      tts?: { auto?: unknown; enabled?: unknown };
    };
    const auto = normalizeTtsAutoMode(prefs.tts?.auto);
    if (auto) {
      return auto;
    }
    if (typeof prefs.tts?.enabled === "boolean") {
      return prefs.tts.enabled ? "always" : "off";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function shouldAttemptTtsPayload(params: {
  cfg: OpenClawConfig;
  ttsAuto?: string;
  agentId?: string;
}): boolean {
  const sessionAuto = normalizeTtsAutoMode(params.ttsAuto);
  if (sessionAuto) {
    return sessionAuto !== "off";
  }

  const raw = resolveEffectiveTtsConfig(params.cfg, params.agentId);
  const prefsAuto = readTtsPrefsAutoMode(resolveTtsPrefsPathValue(raw?.prefsPath));
  if (prefsAuto) {
    return prefsAuto !== "off";
  }

  const configuredAuto = normalizeTtsAutoMode(raw?.auto);
  if (configuredAuto) {
    return configuredAuto !== "off";
  }
  return raw?.enabled === true;
}

export function shouldCleanTtsDirectiveText(params: {
  cfg: OpenClawConfig;
  ttsAuto?: string;
  agentId?: string;
}): boolean {
  if (!shouldAttemptTtsPayload(params)) {
    return false;
  }
  return resolveEffectiveTtsConfig(params.cfg, params.agentId).modelOverrides?.enabled !== false;
}
