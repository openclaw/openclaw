// Lightweight TTS settings resolution shared by agent prompts, status, and speech runtime.
import { asNonArrayRecord, isRecord } from "../../packages/normalization-core/src/record-coerce.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import { selectLiveRuntimeConfig } from "../config/runtime-snapshot.js";
import type {
  OpenClawConfig,
  ResolvedTtsPersona,
  TtsAutoMode,
  TtsConfig,
  TtsModelOverrideConfig,
  TtsProvider,
} from "../config/types.js";
import { warnPluginSdkDeprecation } from "../plugins/sdk-deprecation.js";
import { normalizeSpeechProviderId } from "./provider-registry-core.js";
import type { SpeechProviderConfig } from "./provider-types.js";
import { withSpeakerSelectionCompat } from "./speaker.js";
import { normalizeTtsAutoMode } from "./tts-auto-mode.js";
import {
  isTtsConfigReservedKey,
  readTtsPrefs,
  resolveEffectiveTtsConfig,
  resolveTtsAutoModeFromPrefs,
  resolveTtsPrefsPathValue,
  type TtsConfigResolutionContext,
  type TtsUserPrefs,
} from "./tts-config.js";
import { DEFAULT_MAX_TEXT_LENGTH } from "./tts-limits.js";
import type { PreparedTtsPreferences } from "./tts-preferences.js";
import type { ResolvedTtsConfig, ResolvedTtsModelOverrides } from "./tts-types.js";

export type { ResolvedTtsConfig, ResolvedTtsModelOverrides };
export { readTtsPrefs, type TtsUserPrefs } from "./tts-config.js";

export const DEFAULT_TTS_TIMEOUT_MS = 30_000;
const DEFAULT_TTS_MAX_LENGTH = 1500;
const DEFAULT_TTS_SUMMARIZE = true;
let machinePrefsPathResolver: () => string | undefined = () => undefined;

export function setTtsMachinePrefsPathResolver(resolver?: () => string | undefined): void {
  machinePrefsPathResolver = resolver ?? (() => undefined);
}

export function normalizeConfiguredSpeechProviderId(
  providerId: string | undefined,
): TtsProvider | undefined {
  const normalized = normalizeSpeechProviderId(providerId);
  if (!normalized) {
    return undefined;
  }
  return normalized === "edge" ? "microsoft" : normalized;
}

export function normalizeTtsPersonaId(personaId: string | null | undefined): string | undefined {
  return normalizeOptionalLowercaseString(personaId);
}

export function resolveModelOverridePolicy(
  overrides: TtsModelOverrideConfig | undefined,
): ResolvedTtsModelOverrides {
  const enabled = overrides?.enabled ?? true;
  return {
    enabled,
    allowText: enabled && (overrides?.allowText ?? true),
    allowProvider: enabled && (overrides?.allowProvider ?? false),
    allowVoice: enabled && (overrides?.allowVoice ?? true),
    allowModelId: enabled && (overrides?.allowModelId ?? true),
    allowVoiceSettings: enabled && (overrides?.allowVoiceSettings ?? true),
    allowNormalization: enabled && (overrides?.allowNormalization ?? true),
    allowSeed: enabled && (overrides?.allowSeed ?? true),
  };
}

export function asProviderConfig(value: unknown): SpeechProviderConfig {
  return withSpeakerSelectionCompat(asNonArrayRecord(value));
}

function normalizeProviderConfigMap(
  value: unknown,
): Record<string, SpeechProviderConfig> | undefined {
  const rawMap = asNonArrayRecord(value);
  if (Object.keys(rawMap).length === 0) {
    return undefined;
  }
  const next: Record<string, SpeechProviderConfig> = {};
  for (const [providerId, providerConfig] of Object.entries(rawMap)) {
    const normalized = normalizeConfiguredSpeechProviderId(providerId) ?? providerId;
    next[normalized] = asProviderConfig(providerConfig);
  }
  return next;
}

function collectTtsPersonas(raw: TtsConfig): Record<string, ResolvedTtsPersona> {
  const personas: Record<string, ResolvedTtsPersona> = {};
  for (const [id, persona] of Object.entries(raw.personas ?? {})) {
    const normalizedId = normalizeTtsPersonaId(id);
    if (!normalizedId) {
      continue;
    }
    personas[normalizedId] = {
      ...persona,
      id: normalizedId,
      provider: normalizeConfiguredSpeechProviderId(persona.provider) ?? persona.provider,
      providers: normalizeProviderConfigMap(persona.providers),
    };
  }
  return personas;
}

function collectDirectProviderConfigEntries(raw: TtsConfig): Record<string, SpeechProviderConfig> {
  const entries = normalizeProviderConfigMap(raw.providers) ?? {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (isTtsConfigReservedKey(key)) {
      continue;
    }
    if (!isRecord(value)) {
      continue;
    }
    const normalized = normalizeConfiguredSpeechProviderId(key) ?? key;
    entries[normalized] ??= asProviderConfig(value);
  }
  return entries;
}

export function resolveTtsConfig(
  cfgInput: OpenClawConfig,
  contextOrAgentId?: string | TtsConfigResolutionContext,
): ResolvedTtsConfig {
  const cfg = selectLiveRuntimeConfig(cfgInput);
  const raw: TtsConfig = resolveEffectiveTtsConfig(cfg, contextOrAgentId);
  const providerSource = raw.provider ? "config" : "default";
  const timeoutMs = raw.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS;
  const timeoutMsSource = raw.timeoutMs === undefined ? "default" : "config";
  return {
    auto: normalizeTtsAutoMode(raw.auto) ?? (raw.enabled ? "always" : "off"),
    mode: raw.mode ?? "final",
    provider: normalizeConfiguredSpeechProviderId(raw.provider) ?? "",
    providerSource,
    persona: normalizeTtsPersonaId(raw.persona),
    personas: collectTtsPersonas(raw),
    summaryModel: normalizeOptionalString(raw.summaryModel),
    modelOverrides: resolveModelOverridePolicy(raw.modelOverrides),
    providerConfigs: collectDirectProviderConfigEntries(raw),
    prefsPath: (raw as TtsConfig & { prefsPath?: string }).prefsPath,
    maxTextLength: raw.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH,
    timeoutMs,
    timeoutMsSource,
    rawConfig: raw,
    sourceConfig: cfg,
  };
}

/** Resolves a prepared preference path without reading the state database. */
export function resolveTtsPrefsPath(
  config: ResolvedTtsConfig,
  preparedTtsPreferences: PreparedTtsPreferences,
): string;
/** @deprecated Use resolveTtsPrefsPathAsync or pass awaited prepareTtsPreferences(). Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function resolveTtsPrefsPath(
  config: ResolvedTtsConfig,
  preparedTtsPreferences?: PreparedTtsPreferences,
): string;
export function resolveTtsPrefsPath(
  config: ResolvedTtsConfig,
  preparedTtsPreferences?: PreparedTtsPreferences,
): string {
  if (!preparedTtsPreferences) {
    warnPluginSdkDeprecation({
      family: "tts",
      method: "resolveTtsPrefsPath",
      replacement: "resolveTtsPrefsPathAsync",
    });
  }
  return resolveTtsPrefsPathValue(
    config.prefsPath,
    preparedTtsPreferences
      ? () => preparedTtsPreferences.machinePrefsPath
      : machinePrefsPathResolver,
  );
}

export async function resolveTtsPrefsPathAsync(
  config: ResolvedTtsConfig,
  preparedTtsPreferences?: PreparedTtsPreferences,
): Promise<string> {
  return resolveTtsPrefsPath(
    config,
    await prepareTtsPreferencesForConfig(config, preparedTtsPreferences),
  );
}

async function prepareTtsPreferencesForConfig(
  config: ResolvedTtsConfig,
  preparedTtsPreferences?: PreparedTtsPreferences,
): Promise<PreparedTtsPreferences> {
  return (
    preparedTtsPreferences ??
    (config.prefsPath?.trim() || process.env.OPENCLAW_TTS_PREFS?.trim()
      ? {}
      : await (await import("./tts-preferences.js")).prepareTtsPreferences())
  );
}

export function resolveTtsAutoMode(params: {
  config: ResolvedTtsConfig;
  prefsPath: string;
  sessionAuto?: string;
}): TtsAutoMode {
  const sessionAuto = normalizeTtsAutoMode(params.sessionAuto);
  if (sessionAuto) {
    return sessionAuto;
  }
  return resolveTtsAutoModeFromPrefs(readTtsPrefs(params.prefsPath)) ?? params.config.auto;
}

function resolveTtsPersonaIdFromPrefs(
  config: ResolvedTtsConfig,
  prefs: TtsUserPrefs,
): string | undefined {
  if (prefs.tts && Object.hasOwn(prefs.tts, "persona")) {
    return normalizeTtsPersonaId(prefs.tts.persona);
  }
  return config.persona;
}

export function resolveTtsPersonaFromPrefs(
  config: ResolvedTtsConfig,
  prefs: TtsUserPrefs,
): ResolvedTtsPersona | undefined {
  const personaId = resolveTtsPersonaIdFromPrefs(config, prefs);
  return personaId ? config.personas[personaId] : undefined;
}

export type TtsProviderPreference = {
  provider: TtsProvider;
  source: "prefs" | "persona" | "config";
};

type ResolvedTtsSettingsSnapshot = {
  autoMode: TtsAutoMode;
  config: ResolvedTtsConfig;
  maxLength: number;
  persona?: ResolvedTtsPersona;
  personaId?: string;
  preferredProvider?: TtsProvider;
  providerPreference?: TtsProviderPreference;
  prefsPath: string;
  summarize: boolean;
};

export function resolveTtsSettingsSnapshot(params: {
  cfg: OpenClawConfig;
  preparedTtsPreferences?: PreparedTtsPreferences;
  sessionAuto?: string;
  agentId?: string;
  channelId?: string;
  accountId?: string;
}): ResolvedTtsSettingsSnapshot {
  const config = resolveTtsConfig(params.cfg, {
    agentId: params.agentId,
    channelId: params.channelId,
    accountId: params.accountId,
  });
  const prefsPath = resolveTtsPrefsPath(config, params.preparedTtsPreferences);
  const prefs = readTtsPrefs(prefsPath);
  const personaId = resolveTtsPersonaIdFromPrefs(config, prefs);
  const persona = personaId ? config.personas[personaId] : undefined;
  const prefsProvider = normalizeConfiguredSpeechProviderId(prefs.tts?.provider);
  const personaProvider = normalizeConfiguredSpeechProviderId(persona?.provider);
  const configuredProvider = config.providerSource === "config" ? config.provider : undefined;
  const providerPreference: TtsProviderPreference | undefined = prefsProvider
    ? { provider: prefsProvider, source: "prefs" }
    : personaProvider
      ? { provider: personaProvider, source: "persona" }
      : configuredProvider
        ? { provider: configuredProvider, source: "config" }
        : undefined;
  return {
    autoMode:
      normalizeTtsAutoMode(params.sessionAuto) ?? resolveTtsAutoModeFromPrefs(prefs) ?? config.auto,
    config,
    maxLength: prefs.tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH,
    ...(persona ? { persona } : {}),
    ...(personaId ? { personaId } : {}),
    ...(providerPreference
      ? { preferredProvider: providerPreference.provider, providerPreference }
      : {}),
    prefsPath,
    summarize: prefs.tts?.summarize ?? DEFAULT_TTS_SUMMARIZE,
  };
}

/** Builds the hint from an awaited preference-path preparation without state-database reads. */
export function buildTtsSystemPromptHint(
  cfg: OpenClawConfig,
  agentId: string | undefined,
  options: { messageToolOnly?: boolean; preparedTtsPreferences: PreparedTtsPreferences },
): string | undefined;
/** @deprecated Await api.runtime.tts.buildSystemPromptHintAsync. Bundled callers can pass awaited prepareTtsPreferences(). Final compatibility day: 2026-12-31. Removal in the first January 2027 stable release. */
export function buildTtsSystemPromptHint(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: { messageToolOnly?: boolean; preparedTtsPreferences?: PreparedTtsPreferences },
): string | undefined;
export function buildTtsSystemPromptHint(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: { messageToolOnly?: boolean; preparedTtsPreferences?: PreparedTtsPreferences },
): string | undefined {
  if (!options?.preparedTtsPreferences) {
    warnPluginSdkDeprecation({
      family: "tts",
      method: "buildTtsSystemPromptHint",
      replacement:
        "api.runtime.tts.buildSystemPromptHintAsync (bundled callers can also pass awaited prepareTtsPreferences())",
    });
  }
  const settings = resolveTtsSettingsSnapshot({
    cfg,
    agentId,
    preparedTtsPreferences: options?.preparedTtsPreferences,
  });
  if (settings.autoMode === "off") {
    return undefined;
  }
  const structured = options?.messageToolOnly === true;
  const autoHint =
    settings.autoMode === "inbound"
      ? "Only use TTS when the user's last message includes audio/voice."
      : settings.autoMode === "tagged"
        ? structured
          ? "Use TTS only through message(action=send) speech fields."
          : "Only use TTS when you include [[tts:key=value]] directives or a [[tts:text]]...[[/tts:text]] block."
        : undefined;
  return [
    "Voice (TTS) is enabled.",
    autoHint,
    settings.persona
      ? `Active TTS persona: ${settings.persona.label ?? settings.persona.id}${settings.persona.description ? ` - ${settings.persona.description}` : ""}.`
      : undefined,
    `Keep spoken text ≤${settings.maxLength} chars to avoid auto-summary (summary ${settings.summarize ? "on" : "off"}).`,
    structured
      ? "If workspace context (especially MEMORY.md) tells you not to use TTS or to use a local voice workflow, follow that workspace instruction instead."
      : "If workspace context (especially MEMORY.md) tells you not to use [[tts:...]] or to use a local/non-tagged voice workflow, follow that workspace instruction instead.",
    structured
      ? "Use message(action=send) with voiceText and optional voiceProvider/voiceId."
      : "Use [[tts:...]] and optional [[tts:text]]...[[/tts:text]] to control voice/expressiveness.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Prepares machine preferences through their worker owner before rendering the hint. */
export async function buildTtsSystemPromptHintAsync(
  cfg: OpenClawConfig,
  agentId?: string,
  options?: { messageToolOnly?: boolean; preparedTtsPreferences?: PreparedTtsPreferences },
): Promise<string | undefined> {
  const preparedTtsPreferences = await prepareTtsPreferencesForConfig(
    resolveTtsConfig(cfg, agentId),
    options?.preparedTtsPreferences,
  );
  return buildTtsSystemPromptHint(cfg, agentId, { ...options, preparedTtsPreferences });
}

export function isTtsEnabled(
  config: ResolvedTtsConfig,
  prefsPath: string,
  sessionAuto?: string,
): boolean {
  return resolveTtsAutoMode({ config, prefsPath, sessionAuto }) !== "off";
}

export function getTtsPersona(
  config: ResolvedTtsConfig,
  prefsPath: string,
): ResolvedTtsPersona | undefined {
  return resolveTtsPersonaFromPrefs(config, readTtsPrefs(prefsPath));
}

export function listTtsPersonas(config: ResolvedTtsConfig): ResolvedTtsPersona[] {
  return Object.values(config.personas).toSorted((left, right) => left.id.localeCompare(right.id));
}

export async function resolveTtsPersonaList(cfg: OpenClawConfig) {
  const config = resolveTtsConfig(cfg);
  const prefsPath = await resolveTtsPrefsPathAsync(config);
  const active = getTtsPersona(config, prefsPath);
  return {
    active: active?.id ?? null,
    personas: listTtsPersonas(config).map((persona) => ({
      id: persona.id,
      label: persona.label,
      description: persona.description,
      provider: persona.provider,
      fallbackPolicy: persona.fallbackPolicy,
      providers: Object.keys(persona.providers ?? {}),
    })),
  };
}

export function getTtsMaxLength(prefsPath: string): number {
  return readTtsPrefs(prefsPath).tts?.maxLength ?? DEFAULT_TTS_MAX_LENGTH;
}

export function isSummarizationEnabled(prefsPath: string): boolean {
  return readTtsPrefs(prefsPath).tts?.summarize ?? DEFAULT_TTS_SUMMARIZE;
}
