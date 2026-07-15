import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveApiKeyForProvider } from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { canonicalizeSpeechProviderId } from "../tts/provider-registry.js";
import { getTtsProvider, resolveTtsConfig, resolveTtsPrefsPath } from "../tts/tts.js";
import { resolveSelectedProviderFromModelRef } from "./capability-cli.shared.js";

export function resolveTtsProviderForAuthHydration(params: {
  cfg: OpenClawConfig;
  provider?: string;
  modelId?: string;
  channelId?: string;
}): string | undefined {
  const explicitProvider =
    params.provider ?? resolveSelectedProviderFromModelRef(normalizeOptionalString(params.modelId));
  if (explicitProvider) {
    return explicitProvider;
  }
  const ttsConfig = resolveTtsConfig(params.cfg, { channelId: params.channelId });
  return getTtsProvider(ttsConfig, resolveTtsPrefsPath(ttsConfig));
}

export async function injectTtsAuthProfileApiKey(params: {
  cfg: OpenClawConfig;
  provider?: string;
  channelId?: string;
}): Promise<OpenClawConfig> {
  if (!params.provider) {
    return params.cfg;
  }
  const providerId =
    canonicalizeSpeechProviderId(params.provider, params.cfg) ??
    normalizeLowercaseStringOrEmpty(params.provider);
  if (!providerId) {
    return params.cfg;
  }
  const effectiveTtsConfig = resolveTtsConfig(params.cfg, { channelId: params.channelId });
  if (resolvedTtsConfigHasProviderApiKey(effectiveTtsConfig, providerId)) {
    return params.cfg;
  }
  const existingProviderConfig = resolveExistingTtsProviderConfig({
    cfg: params.cfg,
    providerId,
    channelId: params.channelId,
  });
  if (ttsProviderConfigHasApiKey(existingProviderConfig?.value)) {
    return params.cfg;
  }
  const auth = await resolveApiKeyForProvider({
    provider: providerId,
    cfg: params.cfg,
    credentialPrecedence: "profile-first",
  }).catch(() => undefined);
  if (!auth?.apiKey || auth.mode !== "api-key") {
    return params.cfg;
  }
  if (existingProviderConfig?.scope === "channel") {
    const channels = { ...params.cfg.channels };
    const channel = channels[existingProviderConfig.channelKey];
    if (!isObjectRecord(channel)) {
      return params.cfg;
    }
    const nextChannel = {
      ...channel,
      tts: buildTtsConfigWithHydratedProvider({
        tts: channel.tts,
        existingProviderConfig,
        providerId,
        apiKey: auth.apiKey,
      }),
    };
    return {
      ...params.cfg,
      channels: {
        ...channels,
        [existingProviderConfig.channelKey]: nextChannel,
      },
    };
  }
  const messages = { ...params.cfg.messages };
  const nextTts = buildTtsConfigWithHydratedProvider({
    tts: messages.tts,
    existingProviderConfig,
    providerId,
    apiKey: auth.apiKey,
  });
  return {
    ...params.cfg,
    messages: {
      ...messages,
      tts: nextTts,
    },
  };
}

type TtsProviderConfigLocation = {
  container: "providers" | "direct";
  key: string;
  value: unknown;
};

type ExistingTtsProviderConfig =
  | (TtsProviderConfigLocation & {
      scope: "root";
      channelKey?: never;
    })
  | (TtsProviderConfigLocation & {
      scope: "channel";
      channelKey: string;
    });

function resolveExistingTtsProviderConfig(params: {
  cfg: OpenClawConfig;
  providerId: string;
  channelId?: string;
}): ExistingTtsProviderConfig | undefined {
  const channelTts = resolveChannelTtsConfigForAuthHydration(params);
  if (channelTts) {
    const channelProviderConfig = resolveExistingTtsProviderConfigInTts({
      cfg: params.cfg,
      tts: channelTts.tts,
      providerId: params.providerId,
    });
    if (channelProviderConfig) {
      return {
        ...channelProviderConfig,
        scope: "channel",
        channelKey: channelTts.channelKey,
      };
    }
  }
  const rootProviderConfig = resolveExistingTtsProviderConfigInTts({
    cfg: params.cfg,
    tts: params.cfg.messages?.tts,
    providerId: params.providerId,
  });
  return rootProviderConfig ? { ...rootProviderConfig, scope: "root" } : undefined;
}

function resolveExistingTtsProviderConfigInTts(params: {
  cfg: OpenClawConfig;
  tts: unknown;
  providerId: string;
}): TtsProviderConfigLocation | undefined {
  if (!isObjectRecord(params.tts)) {
    return undefined;
  }
  const providers = isObjectRecord(params.tts.providers) ? params.tts.providers : undefined;
  if (!providers) {
    return resolveDirectTtsProviderConfig(params);
  }
  const exact = providers[params.providerId];
  if (exact !== undefined) {
    return { container: "providers", key: params.providerId, value: exact };
  }
  for (const [key, value] of Object.entries(providers)) {
    const normalizedKey = normalizeLowercaseStringOrEmpty(
      canonicalizeSpeechProviderId(key, params.cfg) ?? key,
    );
    if (normalizedKey === params.providerId) {
      return { container: "providers", key, value };
    }
  }
  return resolveDirectTtsProviderConfig(params);
}

const TTS_CONFIG_RESERVED_KEYS = new Set([
  "auto",
  "enabled",
  "maxTextLength",
  "mode",
  "modelOverrides",
  "persona",
  "personas",
  "prefsPath",
  "provider",
  "providers",
  "summaryModel",
  "timeoutMs",
]);

function resolveDirectTtsProviderConfig(params: {
  cfg: OpenClawConfig;
  tts: unknown;
  providerId: string;
}): TtsProviderConfigLocation | undefined {
  if (!isObjectRecord(params.tts)) {
    return undefined;
  }
  for (const [key, value] of Object.entries(params.tts)) {
    if (TTS_CONFIG_RESERVED_KEYS.has(key)) {
      continue;
    }
    const normalizedKey = normalizeLowercaseStringOrEmpty(
      canonicalizeSpeechProviderId(key, params.cfg) ?? key,
    );
    if (normalizedKey === params.providerId) {
      return { container: "direct", key, value };
    }
  }
  return undefined;
}

function resolveChannelTtsConfigForAuthHydration(params: {
  cfg: OpenClawConfig;
  channelId?: string;
}): { channelKey: string; tts: unknown } | undefined {
  const channels = params.cfg.channels;
  const normalizedChannelId = normalizeOptionalString(params.channelId);
  if (!isObjectRecord(channels) || !normalizedChannelId) {
    return undefined;
  }
  const channelKey = Object.hasOwn(channels, normalizedChannelId)
    ? normalizedChannelId
    : Object.keys(channels).find(
        (candidate) =>
          normalizeLowercaseStringOrEmpty(candidate) ===
          normalizeLowercaseStringOrEmpty(normalizedChannelId),
      );
  const channel = channelKey ? channels[channelKey] : undefined;
  if (!channelKey || !isObjectRecord(channel)) {
    return undefined;
  }
  return { channelKey, tts: channel.tts };
}

function buildTtsConfigWithHydratedProvider(params: {
  tts: unknown;
  existingProviderConfig?: ExistingTtsProviderConfig;
  providerId: string;
  apiKey: string;
}): Record<string, unknown> {
  const tts = isObjectRecord(params.tts) ? { ...params.tts } : {};
  const providers = isObjectRecord(tts.providers) ? { ...tts.providers } : {};
  const providerConfigKey = params.existingProviderConfig?.key ?? params.providerId;
  const nextProviderConfig = {
    ...(isObjectRecord(params.existingProviderConfig?.value)
      ? params.existingProviderConfig.value
      : {}),
    apiKey: params.apiKey,
  };
  if (params.existingProviderConfig?.container === "direct") {
    tts[providerConfigKey] = nextProviderConfig;
  } else {
    providers[providerConfigKey] = nextProviderConfig;
    tts.providers = providers;
  }
  return tts;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function ttsProviderConfigHasApiKey(value: unknown): boolean {
  return isObjectRecord(value) && "apiKey" in value;
}

function resolvedTtsConfigHasProviderApiKey(config: unknown, providerId: string): boolean {
  if (!isObjectRecord(config) || !isObjectRecord(config.providerConfigs)) {
    return false;
  }
  return ttsProviderConfigHasApiKey(config.providerConfigs[providerId]);
}
