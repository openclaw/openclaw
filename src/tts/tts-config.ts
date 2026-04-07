import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";
import type { TtsConfig, TtsMode } from "../config/types.tts.js";
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

export function resolveRawTtsConfig(cfg: OpenClawConfig, agentId?: string): TtsConfig {
  const base = cfg.messages?.tts;
  const override = agentId ? resolveAgentConfig(cfg, agentId)?.tts : undefined;
  return (deepMergeDefined(base ?? {}, override) as TtsConfig | undefined) ?? {};
}

export function resolveConfiguredTtsMode(cfg: OpenClawConfig, agentId?: string): TtsMode {
  return resolveRawTtsConfig(cfg, agentId).mode ?? "final";
}
