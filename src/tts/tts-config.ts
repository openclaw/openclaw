// TTS config helpers read and normalize text-to-speech provider settings.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  asNonArrayRecord,
  asOptionalRecord as asObjectRecord,
  isRecord as isPlainObject,
} from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.js";
import type { TtsAutoMode, TtsConfig, TtsMode, TtsProvider } from "../config/types.tts.js";
import { mergeDeep } from "../infra/deep-merge.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { resolveConfigDir, resolveUserPath } from "../utils.js";
import { normalizeTtsAutoMode } from "./tts-auto-mode.js";
export { normalizeTtsAutoMode } from "./tts-auto-mode.js";

/** Routing context used to layer global, agent, channel, and account TTS config. */
export type TtsConfigResolutionContext = {
  agentId?: string;
  channelId?: string;
  accountId?: string;
};

function resolveRecordEntry<T>(
  entries: Record<string, T> | undefined,
  id: string | undefined,
  normalize: (value: string) => string,
): T | undefined {
  const normalizedId = normalizeOptionalString(id);
  if (!entries || !normalizedId) {
    return undefined;
  }
  if (Object.hasOwn(entries, normalizedId)) {
    return entries[normalizedId];
  }
  const normalized = normalize(normalizedId);
  const key = Object.keys(entries).find((candidate) => normalize(candidate) === normalized);
  return key ? entries[key] : undefined;
}

function asTtsConfig(value: unknown): TtsConfig | undefined {
  return isPlainObject(value) ? (value as TtsConfig) : undefined;
}

function resolveChannelConfig(
  cfg: OpenClawConfig,
  channelId: string | undefined,
): Record<string, unknown> | undefined {
  if (!isPlainObject(cfg.channels)) {
    return undefined;
  }
  const normalizedChannelId = normalizeOptionalString(channelId);
  if (!normalizedChannelId) {
    return undefined;
  }
  return asObjectRecord(
    resolveRecordEntry(
      cfg.channels as Record<string, unknown>,
      normalizedChannelId,
      normalizeLowercaseStringOrEmpty,
    ),
  );
}

/** Resolve effective TTS config after applying global, agent, channel, and account layers. */
export function resolveEffectiveTtsConfig(
  cfg: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): TtsConfig {
  const context =
    typeof contextOrAgentId === "string" ? { agentId: contextOrAgentId } : (contextOrAgentId ?? {});
  const base = cfg.tts ?? {};
  const agentOverride = context.agentId ? resolveAgentConfig(cfg, context.agentId)?.tts : undefined;
  const channelConfig = resolveChannelConfig(cfg, context.channelId);
  const channelOverride = asTtsConfig(channelConfig?.tts);
  const accounts = isPlainObject(channelConfig?.accounts) ? channelConfig.accounts : undefined;
  const accountConfig = resolveRecordEntry(accounts, context.accountId, normalizeAccountId);
  const accountOverride = asTtsConfig(asObjectRecord(accountConfig)?.tts);
  let merged: unknown = base;
  for (const override of [agentOverride, channelOverride, accountOverride]) {
    merged = mergeDeep(merged, override ?? {});
  }
  return merged as TtsConfig;
}

/** Resolve the configured TTS mode, defaulting to final-answer synthesis. */
export function resolveConfiguredTtsMode(
  cfg: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): TtsMode {
  return resolveEffectiveTtsConfig(cfg, contextOrAgentId).mode ?? "final";
}

export function resolveTtsPrefsPathValue(
  prefsPath: string | undefined,
  machinePrefsPath: () => string | undefined,
): string {
  if (prefsPath?.trim()) {
    return resolveUserPath(prefsPath.trim());
  }
  const envPath = process.env.OPENCLAW_TTS_PREFS?.trim();
  if (envPath) {
    return resolveUserPath(envPath);
  }
  const machinePath = machinePrefsPath()?.trim();
  if (machinePath) {
    return resolveUserPath(machinePath);
  }
  return path.join(resolveConfigDir(process.env), "settings", "tts.json");
}

export type TtsUserPrefs = {
  tts?: {
    auto?: TtsAutoMode;
    enabled?: boolean;
    provider?: TtsProvider;
    persona?: string | null;
    maxLength?: number;
    summarize?: boolean;
  };
};

export function readTtsPrefs(prefsPath: string): TtsUserPrefs {
  try {
    if (!existsSync(prefsPath)) {
      return {};
    }
    return asNonArrayRecord(JSON.parse(readFileSync(prefsPath, "utf8"))) as TtsUserPrefs;
  } catch {
    return {};
  }
}

export function resolveTtsAutoModeFromPrefs(prefs: TtsUserPrefs): TtsAutoMode | undefined {
  const auto = normalizeTtsAutoMode(prefs.tts?.auto);
  if (auto) {
    return auto;
  }
  if (typeof prefs.tts?.enabled === "boolean") {
    return prefs.tts.enabled ? "always" : "off";
  }
  return undefined;
}

/** Return whether this payload should attempt TTS based on session, prefs, and config. */
export function shouldAttemptTtsPayload(params: {
  cfg: OpenClawConfig;
  ttsAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): boolean {
  const sessionAuto = normalizeTtsAutoMode(params.ttsAuto);
  if (sessionAuto) {
    return sessionAuto !== "off";
  }

  const raw = resolveEffectiveTtsConfig(params.cfg, params);
  const scopedPrefsPath = (raw as TtsConfig & { prefsPath?: string }).prefsPath;
  const machinePrefsPath = readConfigMachineState<string>("tts.prefsPath");
  const prefsAuto = resolveTtsAutoModeFromPrefs(
    readTtsPrefs(resolveTtsPrefsPathValue(scopedPrefsPath, () => machinePrefsPath)),
  );
  if (prefsAuto) {
    return prefsAuto !== "off";
  }

  const configuredAuto = normalizeTtsAutoMode(raw?.auto);
  if (configuredAuto) {
    return configuredAuto !== "off";
  }
  return raw?.enabled === true;
}

/** Return whether TTS directive markup should be stripped from user-visible text. */
export function shouldCleanTtsDirectiveText(params: {
  cfg: OpenClawConfig;
  ttsAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): boolean {
  if (!shouldAttemptTtsPayload(params)) {
    return false;
  }
  return resolveEffectiveTtsConfig(params.cfg, params).modelOverrides?.enabled !== false;
}
