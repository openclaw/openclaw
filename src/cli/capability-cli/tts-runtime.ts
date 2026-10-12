import fs from "node:fs/promises";
import path from "node:path";
import { isRecord as isObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveApiKeyForProviderCore } from "../../agents/model-auth.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { buildGatewayConnectionDetailsWithResolvers } from "../../gateway/connection-details.js";
import { isLoopbackHost } from "../../gateway/net.js";
import { resolveModelRefOverride } from "../../shared/model-ref-override.js";
import { canonicalizeSpeechProviderId, listSpeechProviders } from "../../tts/provider-registry.js";
import type { TtsResult } from "../../tts/tts-runtime-types.js";
import { isTtsConfigReservedKey, resolveTtsPersonaList } from "../../tts/tts-settings.js";
import {
  getTtsProviderAsync,
  listTtsPersonas,
  listSpeechVoices,
  resolveExplicitTtsOverridesAsync,
  resolveTtsConfig,
  resolveTtsPrefsPathAsync,
  setTtsEnabled,
  setTtsPersona,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import { getTtsCommandSecretTargetIds } from "../command-secret-targets.js";
import { publishOutputFileAtomically } from "../media-output.js";
import type { CapabilityEnvelope, CapabilityTransport } from "./metadata.js";
import {
  pinRuntimeConfigSnapshot,
  providerHasGenericConfig,
  resolveCapabilityProviderAgentId,
  resolveLocalCapabilityRuntimeConfig,
} from "./shared.js";

export async function runTtsConvert(params: {
  text: string;
  channel?: string;
  provider?: string;
  modelId?: string;
  voiceId?: string;
  output?: string;
  transport: CapabilityTransport;
}) {
  let result: Pick<TtsResult, "audioPath" | "provider" | "outputFormat" | "voiceCompatible">;
  let attempts: NonNullable<TtsResult["attempts"]> = [];
  if (params.transport === "gateway") {
    const gatewayConnection = buildGatewayConnectionDetailsWithResolvers({
      config: getRuntimeConfig(),
    });
    if (params.output && !isLoopbackHost(new URL(gatewayConnection.url).hostname)) {
      throw new Error(
        `--output is not supported for remote gateway TTS yet (gateway target: ${gatewayConnection.url}).`,
      );
    }
    result = await callGateway({
      method: "tts.convert",
      params: {
        text: params.text,
        channel: params.channel,
        provider: normalizeOptionalString(params.provider),
        modelId: params.modelId,
        voiceId: params.voiceId,
      },
      timeoutMs: 120_000,
    });
  } else {
    const cfg = await resolveLocalCapabilityRuntimeConfig({
      commandName: "infer tts convert",
      targetIds: getTtsCommandSecretTargetIds(),
    });
    const ttsConfig = resolveTtsConfig(cfg, { channelId: params.channel });
    const prefsPath = await resolveTtsPrefsPathAsync(ttsConfig);
    const ttsProvider =
      params.provider ??
      resolveModelRefOverride(normalizeOptionalString(params.modelId)).provider ??
      (await getTtsProviderAsync(ttsConfig, prefsPath));
    const effectiveCfg = await injectTtsAuthProfileApiKey({
      cfg,
      provider: ttsProvider,
      channelId: params.channel,
    });
    if (effectiveCfg !== cfg) {
      pinRuntimeConfigSnapshot(effectiveCfg);
    }
    const overrides = await resolveExplicitTtsOverridesAsync({
      cfg: effectiveCfg,
      prefsPath,
      provider: params.provider,
      modelId: params.modelId,
      voiceId: params.voiceId,
      channelId: params.channel,
    });
    const hasExplicitSelection = Boolean(
      overrides.provider ||
      normalizeOptionalString(params.modelId) ||
      normalizeOptionalString(params.voiceId),
    );
    const localResult = await textToSpeech({
      text: params.text,
      cfg: effectiveCfg,
      prefsPath,
      channel: params.channel,
      overrides,
      disableFallback: hasExplicitSelection,
    });
    if (!localResult.success || !localResult.audioPath) {
      throw new Error(localResult.error ?? "TTS conversion failed");
    }
    result = localResult;
    attempts = localResult.attempts ?? [];
  }
  let outputPath = result.audioPath;
  if (params.output && result.audioPath) {
    const sourcePath = result.audioPath;
    outputPath = path.resolve(params.output);
    await publishOutputFileAtomically({
      filePath: outputPath,
      writeTemp: (tempPath) => fs.copyFile(sourcePath, tempPath),
    });
  }
  return {
    ok: true,
    capability: "tts.convert",
    transport: params.transport,
    provider: result.provider,
    attempts,
    outputs: [
      {
        path: outputPath,
        format: result.outputFormat,
        voiceCompatible: result.voiceCompatible,
      },
    ],
  } satisfies CapabilityEnvelope;
}

async function injectTtsAuthProfileApiKey(params: {
  cfg: OpenClawConfig;
  provider?: string;
  channelId?: string;
}): Promise<OpenClawConfig> {
  const { cfg } = params;
  if (!params.provider) {
    return cfg;
  }
  const providerId =
    canonicalizeSpeechProviderId(params.provider, cfg) ??
    normalizeLowercaseStringOrEmpty(params.provider);
  if (!providerId) {
    return cfg;
  }
  const effectiveTtsConfig = resolveTtsConfig(cfg, { channelId: params.channelId });
  if (ttsProviderConfigHasApiKey(effectiveTtsConfig.providerConfigs[providerId])) {
    return cfg;
  }

  const channelId = normalizeOptionalString(params.channelId);
  const channelKey =
    isObjectRecord(cfg.channels) && channelId
      ? Object.hasOwn(cfg.channels, channelId)
        ? channelId
        : Object.keys(cfg.channels).find(
            (key) => normalizeLowercaseStringOrEmpty(key) === channelId.toLowerCase(),
          )
      : undefined;
  let channel = channelKey ? cfg.channels?.[channelKey] : undefined;
  const channelProvider = isObjectRecord(channel)
    ? findTtsProviderConfig(channel.tts, providerId, cfg)
    : undefined;
  const existing = channelProvider ?? findTtsProviderConfig(cfg.tts, providerId, cfg);
  if (ttsProviderConfigHasApiKey(existing?.value)) {
    return cfg;
  }
  const auth = await resolveApiKeyForProviderCore({
    provider: providerId,
    cfg,
    credentialPrecedence: "profile-first",
  }).catch(() => undefined);
  if (!auth?.apiKey || auth.mode !== "api-key") {
    return cfg;
  }

  if (channelProvider && channelKey) {
    channel = cfg.channels?.[channelKey];
    if (!isObjectRecord(channel)) {
      return cfg;
    }
  }
  const rawTts = channelProvider && isObjectRecord(channel) ? channel.tts : cfg.tts;
  const tts = isObjectRecord(rawTts) ? { ...rawTts } : {};
  const key = existing?.key ?? providerId;
  const providerConfig = {
    ...(isObjectRecord(existing?.value) ? existing.value : {}),
    apiKey: auth.apiKey,
  };
  if (existing?.container === "direct") {
    tts[key] = providerConfig;
  } else {
    tts.providers = {
      ...(isObjectRecord(tts.providers) ? tts.providers : {}),
      [key]: providerConfig,
    };
  }
  return channelProvider && channelKey && isObjectRecord(channel)
    ? { ...cfg, channels: { ...cfg.channels, [channelKey]: { ...channel, tts } } }
    : { ...cfg, tts };
}

function findTtsProviderConfig(
  tts: unknown,
  providerId: string,
  cfg: OpenClawConfig,
): { container: "providers" | "direct"; key: string; value: unknown } | undefined {
  if (!isObjectRecord(tts)) {
    return undefined;
  }
  const providers = isObjectRecord(tts.providers) ? tts.providers : undefined;
  const exact = providers?.[providerId];
  if (exact !== undefined) {
    return { container: "providers", key: providerId, value: exact };
  }
  for (const [container, entries] of [
    ["providers", providers],
    ["direct", tts],
  ] as const) {
    for (const [key, value] of Object.entries(entries ?? {})) {
      if (container === "direct" && isTtsConfigReservedKey(key)) {
        continue;
      }
      if (
        normalizeLowercaseStringOrEmpty(canonicalizeSpeechProviderId(key, cfg) ?? key) ===
        providerId
      ) {
        return { container, key, value };
      }
    }
  }
  return undefined;
}

function ttsProviderConfigHasApiKey(value: unknown): boolean {
  return isObjectRecord(value) && "apiKey" in value;
}

export async function runTtsProviders(transport: CapabilityTransport, rawAgentId?: string) {
  const cfg = getRuntimeConfig();
  if (transport === "gateway") {
    if (rawAgentId !== undefined) {
      throw new Error("--agent is only supported with local TTS provider inspection.");
    }
    const payload: {
      providers?: Array<Record<string, unknown>>;
      active?: string;
    } = await callGateway({
      method: "tts.providers",
      timeoutMs: 30_000,
    });
    return {
      ...payload,
      providers: (payload.providers ?? []).map((provider) => {
        const id = typeof provider.id === "string" ? provider.id : "";
        return Object.assign(
          {
            available: true,
            configured:
              typeof provider.configured === `boolean`
                ? provider.configured
                : providerHasGenericConfig({ cfg, providerId: id }),
            selected: Boolean(id && payload.active === id),
          },
          provider,
        );
      }),
    };
  }
  const agentId = resolveCapabilityProviderAgentId(cfg, rawAgentId);
  const config = resolveTtsConfig(cfg);
  const prefsPath = await resolveTtsPrefsPathAsync(config);
  const active = await getTtsProviderAsync(config, prefsPath);
  return {
    providers: listSpeechProviders(cfg).map((provider) => ({
      available: true,
      configured:
        active === provider.id ||
        providerHasGenericConfig({ cfg, providerId: provider.id, agentId }),
      selected: active === provider.id,
      id: provider.id,
      name: provider.label,
      models: [...(provider.models ?? [])],
      voices: [...(provider.voices ?? [])],
    })),
    active,
  };
}

export async function runTtsPersonas(transport: CapabilityTransport) {
  if (transport === "gateway") {
    return await callGateway({
      method: "tts.personas",
      timeoutMs: 30_000,
    });
  }
  const cfg = getRuntimeConfig();
  return resolveTtsPersonaList(cfg);
}

export async function runTtsVoices(providerRaw?: string) {
  const cfg = await resolveLocalCapabilityRuntimeConfig({
    commandName: "infer tts voices",
    targetIds: getTtsCommandSecretTargetIds(),
  });
  const config = resolveTtsConfig(cfg);
  const prefsPath = await resolveTtsPrefsPathAsync(config);
  const provider =
    normalizeOptionalString(providerRaw) || (await getTtsProviderAsync(config, prefsPath));
  return await listSpeechVoices({
    provider,
    cfg,
    config,
  });
}

export async function runTtsStateMutation(params: {
  capability: "tts.enable" | "tts.disable" | "tts.set-provider" | "tts.set-persona";
  transport: CapabilityTransport;
  provider?: string;
  persona?: string | null;
}) {
  if (params.transport === "gateway") {
    const method =
      params.capability === "tts.enable"
        ? "tts.enable"
        : params.capability === "tts.disable"
          ? "tts.disable"
          : params.capability === "tts.set-provider"
            ? "tts.setProvider"
            : "tts.setPersona";
    return await callGateway({
      method,
      params:
        params.capability === "tts.set-provider"
          ? { provider: params.provider }
          : params.capability === "tts.set-persona"
            ? { persona: params.persona ?? "off" }
            : undefined,
      timeoutMs: 30_000,
    });
  }

  const cfg = getRuntimeConfig();
  const config = resolveTtsConfig(cfg);
  const prefsPath = await resolveTtsPrefsPathAsync(config);
  if (params.capability === "tts.enable" || params.capability === "tts.disable") {
    const enabled = params.capability === "tts.enable";
    setTtsEnabled(prefsPath, enabled);
    return { enabled };
  }
  if (params.capability === "tts.set-persona") {
    if (!params.persona) {
      setTtsPersona(prefsPath, null);
      return { persona: null };
    }
    const persona = listTtsPersonas(config).find(
      (entry) => entry.id === normalizeLowercaseStringOrEmpty(params.persona ?? ""),
    );
    if (!persona) {
      throw new Error(`Unknown TTS persona: ${params.persona}`);
    }
    setTtsPersona(prefsPath, persona.id);
    return { persona: persona.id };
  }
  if (!params.provider) {
    throw new Error("--provider is required");
  }
  const provider = canonicalizeSpeechProviderId(params.provider, cfg);
  if (!provider) {
    throw new Error(`Unknown speech provider: ${params.provider}`);
  }
  setTtsProvider(prefsPath, provider);
  return { provider };
}
