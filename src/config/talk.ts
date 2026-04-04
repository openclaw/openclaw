import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ResolvedTalkConfig,
  TalkConfig,
  TalkConfigResponse,
  TalkProviderConfig,
} from "./types.gateway.js";
import type { OpenClawConfig } from "./types.js";
import { coerceSecretRef } from "./types.secrets.js";

type TalkApiKeyDeps = {
  fs?: typeof fs;
  os?: typeof os;
  path?: typeof path;
};

export const LEGACY_TALK_PROVIDER_ID = "elevenlabs";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeVoiceAliases(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const aliases: Record<string, string> = {};
  for (const [alias, rawId] of Object.entries(value)) {
    if (typeof rawId !== "string") {
      continue;
    }
    aliases[alias] = rawId;
  }
  return Object.keys(aliases).length > 0 ? aliases : undefined;
}

function normalizeTalkSecretInput(value: unknown): TalkProviderConfig["apiKey"] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return coerceSecretRef(value) ?? undefined;
}

function normalizeSilenceTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeTalkProviderConfig(value: unknown): TalkProviderConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const provider: TalkProviderConfig = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined) {
      continue;
    }
    if (key === "voiceAliases") {
      const aliases = normalizeVoiceAliases(raw);
      if (aliases) {
        provider.voiceAliases = aliases;
      }
      continue;
    }
    if (key === "apiKey") {
      const normalized = normalizeTalkSecretInput(raw);
      if (normalized !== undefined) {
        provider.apiKey = normalized;
      }
      continue;
    }
    if (key === "voiceId" || key === "modelId" || key === "outputFormat") {
      const normalized = normalizeString(raw);
      if (normalized) {
        provider[key] = normalized;
      }
      continue;
    }
    provider[key] = raw;
  }

  return Object.keys(provider).length > 0 ? provider : undefined;
}

function normalizeTalkProviders(value: unknown): Record<string, TalkProviderConfig> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const providers: Record<string, TalkProviderConfig> = {};
  for (const [rawProviderId, providerConfig] of Object.entries(value)) {
    const providerId = normalizeString(rawProviderId);
    if (!providerId) {
      continue;
    }
    const normalizedProvider = normalizeTalkProviderConfig(providerConfig);
    if (!normalizedProvider) {
      continue;
    }
    providers[providerId] = normalizedProvider;
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

function legacyProviderConfigFromTalk(
  source: Record<string, unknown>,
): TalkProviderConfig | undefined {
  return normalizeTalkProviderConfig({
    voiceId: source.voiceId,
    voiceAliases: source.voiceAliases,
    modelId: source.modelId,
    outputFormat: source.outputFormat,
    apiKey: source.apiKey,
  });
}

function activeProviderFromTalk(talk: TalkConfig): string | undefined {
  const provider = normalizeString(talk.provider);
  const providers = talk.providers;
  if (provider) {
    if (providers && !(provider in providers)) {
      return undefined;
    }
    return provider;
  }
  const providerIds = providers ? Object.keys(providers) : [];
  return providerIds.length === 1 ? providerIds[0] : undefined;
}

export function normalizeTalkSection(value: TalkConfig | undefined): TalkConfig | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const hasNormalizedShape = typeof source.provider === "string" || isPlainObject(source.providers);
  const normalized: TalkConfig = {};
  if (typeof source.interruptOnSpeech === "boolean") {
    normalized.interruptOnSpeech = source.interruptOnSpeech;
  }
  const silenceTimeoutMs = normalizeSilenceTimeoutMs(source.silenceTimeoutMs);
  if (silenceTimeoutMs !== undefined) {
    normalized.silenceTimeoutMs = silenceTimeoutMs;
  }

  if (hasNormalizedShape) {
    const providers = normalizeTalkProviders(source.providers);
    const provider = normalizeString(source.provider);
    if (providers) {
      normalized.providers = providers;
    }
    if (provider) {
      normalized.provider = provider;
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined;
  }

  const legacyProviderConfig = legacyProviderConfigFromTalk(source);
  if (legacyProviderConfig) {
    normalized.providers = { [LEGACY_TALK_PROVIDER_ID]: legacyProviderConfig };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function normalizeTalkConfig(config: OpenClawConfig): OpenClawConfig {
  if (!config.talk) {
    return config;
  }
  const normalizedTalk = normalizeTalkSection(config.talk);
  if (!normalizedTalk) {
    return config;
  }
  return {
    ...config,
    talk: normalizedTalk,
  };
}

export function resolveActiveTalkProviderConfig(
  talk: TalkConfig | undefined,
): ResolvedTalkConfig | undefined {
  const normalizedTalk = normalizeTalkSection(talk);
  if (!normalizedTalk) {
    return undefined;
  }
  const provider = activeProviderFromTalk(normalizedTalk);
  if (!provider) {
    return undefined;
  }
  return {
    provider,
    config: normalizedTalk.providers?.[provider] ?? {},
  };
}

export function buildTalkConfigResponse(value: unknown): TalkConfigResponse | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const normalized = normalizeTalkSection(value as TalkConfig);
  if (!normalized) {
    return undefined;
  }

  const payload: TalkConfigResponse = {};
  if (typeof normalized.interruptOnSpeech === "boolean") {
    payload.interruptOnSpeech = normalized.interruptOnSpeech;
  }
  if (typeof normalized.silenceTimeoutMs === "number") {
    payload.silenceTimeoutMs = normalized.silenceTimeoutMs;
  }
  if (normalized.providers && Object.keys(normalized.providers).length > 0) {
    payload.providers = normalized.providers;
  }

  const resolved = resolveActiveTalkProviderConfig(normalized);
  const activeProvider = normalizeString(normalized.provider) ?? resolved?.provider;
  if (activeProvider) {
    payload.provider = activeProvider;
  }
  if (resolved) {
    payload.resolved = resolved;
  }

  return Object.keys(payload).length > 0 ? payload : undefined;
}

export function readTalkApiKeyFromProfile(deps: TalkApiKeyDeps = {}): string | null {
  const fsImpl = deps.fs ?? fs;
  const osImpl = deps.os ?? os;
  const pathImpl = deps.path ?? path;

  const home = osImpl.homedir();
  const candidates = [".profile", ".zprofile", ".zshrc", ".bashrc"].map((name) =>
    pathImpl.join(home, name),
  );
  for (const candidate of candidates) {
    if (!fsImpl.existsSync(candidate)) {
      continue;
    }
    try {
      const text = fsImpl.readFileSync(candidate, "utf-8");
      const match = text.match(
        /(?:^|\n)\s*(?:export\s+)?ELEVENLABS_API_KEY\s*=\s*["']?([^\n"']+)["']?/,
      );
      const value = match?.[1]?.trim();
      if (value) {
        return value;
      }
    } catch {
      // Ignore profile read errors.
    }
  }
  return null;
}

export function resolveTalkApiKey(
  env: NodeJS.ProcessEnv = process.env,
  deps: TalkApiKeyDeps = {},
): string | null {
  const envValue = (env.ELEVENLABS_API_KEY ?? "").trim();
  if (envValue) {
    return envValue;
  }
  return readTalkApiKeyFromProfile(deps);
}
