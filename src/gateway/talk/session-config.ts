import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { resolveRealtimeVoiceAgentContextInstructions } from "../../agents/realtime-bootstrap-context.js";
import type { TalkRealtimeConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig } from "../../config/types.js";
import {
  getRealtimeTranscriptionProvider,
  listRealtimeTranscriptionProviders,
} from "../../realtime-transcription/provider-registry.js";
import type { RealtimeTranscriptionProviderConfig } from "../../realtime-transcription/provider-types.js";
import { REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME } from "../../talk/agent-consult-tool.js";
import { REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME } from "../../talk/agent-run-control-shared.js";
import { listRealtimeVoiceProviders } from "../../talk/provider-registry.js";
import type { RealtimeVoiceProviderConfig } from "../../talk/provider-types.js";
import {
  getVoiceProviderConfig,
  providerMatchesId,
  resolveSupportedVoiceModelRefs,
  type VoiceModelProvider,
} from "../../tts/voice-models.js";

export async function resolveTalkRealtimeProviderInstructions(params: {
  config: OpenClawConfig;
  agentId: string;
  configuredInstructions?: string;
  sessionKey: string;
  warn: (message: string) => void;
}): Promise<string> {
  return [params.configuredInstructions, await resolveRealtimeVoiceAgentContextInstructions(params)]
    .filter((entry): entry is string => Boolean(entry?.trim()))
    .join("\n\n");
}

function normalizeRealtimeTransport(value: unknown): TalkRealtimeConfig["transport"] {
  const transport = normalizeOptionalLowercaseString(value);
  return transport === "webrtc" ||
    transport === "provider-websocket" ||
    transport === "gateway-relay" ||
    transport === "managed-room"
    ? transport
    : undefined;
}

function getVoiceCallStreamingConfig(config: OpenClawConfig): {
  provider?: string;
  providers?: Record<string, Record<string, unknown>>;
} {
  const plugins = asOptionalRecord(config.plugins);
  const entries = asOptionalRecord(plugins?.entries);
  const voiceCall = asOptionalRecord(entries?.["voice-call"]);
  const pluginConfig = asOptionalRecord(voiceCall?.config);
  const section = asOptionalRecord(pluginConfig?.streaming);
  const providersRaw = asOptionalRecord(section?.providers);
  const providers: Record<string, Record<string, unknown>> = {};
  if (providersRaw) {
    for (const [providerId, providerConfig] of Object.entries(providersRaw)) {
      const record = asOptionalRecord(providerConfig);
      if (record) {
        providers[providerId] = record;
      }
    }
  }
  return {
    provider: normalizeOptionalString(section?.provider),
    providers: Object.keys(providers).length > 0 ? providers : undefined,
  };
}

export function listTalkTranscriptionProviders(
  config: OpenClawConfig,
  configuredProviderIds: Iterable<string | undefined>,
) {
  const providers = listRealtimeTranscriptionProviders(config);
  for (const providerId of configuredProviderIds) {
    const configuredProvider = getRealtimeTranscriptionProvider(providerId, config);
    if (
      configuredProvider &&
      !providers.some(
        (provider) =>
          normalizeOptionalLowercaseString(provider.id) ===
          normalizeOptionalLowercaseString(configuredProvider.id),
      )
    ) {
      providers.push(configuredProvider);
    }
  }
  return providers;
}

type RealtimeProviderWithConfig<TConfig extends Record<string, unknown>> = VoiceModelProvider & {
  resolveConfig?: (ctx: { cfg: OpenClawConfig; rawConfig: TConfig }) => TConfig;
  isConfigured?: (ctx: { cfg: OpenClawConfig; providerConfig: TConfig }) => boolean;
  isConfiguredAsync?: (ctx: { cfg: OpenClawConfig; providerConfig: TConfig }) => Promise<boolean>;
  resolveConfigAsync?: (ctx: { cfg: OpenClawConfig; rawConfig: TConfig }) => Promise<TConfig>;
};

async function resolveConfiguredVoiceModelDefaultRef<
  TConfig extends Record<string, unknown>,
>(params: {
  config: OpenClawConfig;
  provider: string | undefined;
  providerConfigs: Record<string, TConfig>;
  providers: readonly RealtimeProviderWithConfig<TConfig>[];
  requestedModel?: string;
}): Promise<{ provider: string; model: string } | undefined> {
  const configuredProvider = normalizeOptionalString(params.provider);
  const refs = resolveSupportedVoiceModelRefs({
    config: params.config.agents?.defaults?.voiceModel,
    providers: params.providers,
    providerId: configuredProvider,
  });
  for (const ref of refs) {
    const provider = params.providers.find((entry) => providerMatchesId(entry, ref.provider));
    if (!provider) {
      continue;
    }
    if (!configuredProvider) {
      const rawConfig = getVoiceProviderConfig({
        providerConfigs: params.providerConfigs,
        provider,
      });
      const rawConfigWithModel = {
        ...rawConfig,
        model:
          params.requestedModel ?? (rawConfig.model === undefined ? ref.model : rawConfig.model),
      };
      const providerConfig =
        (provider.resolveConfigAsync
          ? await provider.resolveConfigAsync({ cfg: params.config, rawConfig: rawConfigWithModel })
          : provider.resolveConfig?.({ cfg: params.config, rawConfig: rawConfigWithModel })) ??
        rawConfigWithModel;
      if (
        !(await configuredOrFalseAsync(() =>
          provider.isConfiguredAsync
            ? provider.isConfiguredAsync({ cfg: params.config, providerConfig })
            : (provider.isConfigured?.({ cfg: params.config, providerConfig }) ?? false),
        ))
      ) {
        continue;
      }
    }
    return { provider: provider.id, model: ref.model };
  }
  return undefined;
}

export async function buildTalkRealtimeConfig(
  config: OpenClawConfig,
  requestedProvider?: string,
  requestedModel?: string,
) {
  const talkRealtime = asOptionalRecord(config.talk?.realtime);
  const talkRealtimeProviderConfigs = talkRealtime?.providers as
    | Record<string, RealtimeVoiceProviderConfig>
    | undefined;
  const explicitProvider =
    normalizeOptionalString(requestedProvider) ?? normalizeOptionalString(talkRealtime?.provider);
  const configuredProviderIds = Object.keys(talkRealtimeProviderConfigs ?? {});
  const singleConfiguredProvider = normalizeOptionalString(
    configuredProviderIds.length === 1 ? configuredProviderIds[0] : undefined,
  );
  const selectedProvider = explicitProvider ?? singleConfiguredProvider;
  const providerConfigs = talkRealtimeProviderConfigs ?? {};
  const voiceModelDefault = await resolveConfiguredVoiceModelDefaultRef({
    config,
    provider: selectedProvider,
    providerConfigs,
    providers: listRealtimeVoiceProviders(config),
    requestedModel:
      normalizeOptionalString(requestedModel) ?? normalizeOptionalString(talkRealtime?.model),
  });
  const provider = selectedProvider ?? voiceModelDefault?.provider;
  const model = normalizeOptionalString(talkRealtime?.model) ?? voiceModelDefault?.model;
  return {
    provider,
    providers: providerConfigs,
    model,
    // talk.realtime.voice is not a schema key (strictObject rejects it);
    // provider-level `voice` compat is owned by each provider's normalizer.
    voice:
      normalizeOptionalString(talkRealtime?.speakerVoice) ??
      normalizeOptionalString(talkRealtime?.speakerVoiceId),
    instructions: normalizeOptionalString(talkRealtime?.instructions),
    mode: normalizeOptionalLowercaseString(talkRealtime?.mode),
    transport: normalizeRealtimeTransport(talkRealtime?.transport),
    vadThreshold: asFiniteNumber(talkRealtime?.vadThreshold),
    silenceDurationMs: asFiniteNumber(talkRealtime?.silenceDurationMs),
    prefixPaddingMs: asFiniteNumber(talkRealtime?.prefixPaddingMs),
    reasoningEffort: normalizeOptionalString(talkRealtime?.reasoningEffort),
    brain: normalizeOptionalLowercaseString(talkRealtime?.brain),
    consultRouting: normalizeOptionalLowercaseString(talkRealtime?.consultRouting),
  };
}

export async function buildTalkTranscriptionConfig(
  config: OpenClawConfig,
  requestedProvider?: string,
  requestedModel?: string,
) {
  const streamingConfig = getVoiceCallStreamingConfig(config);
  const provider = normalizeOptionalString(requestedProvider) ?? streamingConfig.provider;
  const providerConfigs = streamingConfig.providers ?? {};
  const configuredProviderIds = [provider, ...Object.keys(providerConfigs)];
  const voiceModelDefault = await resolveConfiguredVoiceModelDefaultRef({
    config,
    provider,
    providerConfigs,
    providers: listTalkTranscriptionProviders(config, configuredProviderIds),
    requestedModel: normalizeOptionalString(requestedModel),
  });
  return {
    provider: provider ?? voiceModelDefault?.provider,
    providers: providerConfigs,
    model: voiceModelDefault?.model,
  };
}

export async function configuredOrFalseAsync(
  callback: () => boolean | Promise<boolean>,
): Promise<boolean> {
  try {
    return await callback();
  } catch {
    return false;
  }
}

export async function resolveConfiguredRealtimeTranscriptionProvider(params: {
  config: OpenClawConfig;
  configuredProviderId?: string;
  providerConfigs: Record<string, RealtimeTranscriptionProviderConfig>;
  requestedModel?: string;
  defaultModel?: string;
}) {
  const normalizedConfigured = normalizeOptionalLowercaseString(params.configuredProviderId);
  const providers = normalizedConfigured
    ? [getRealtimeTranscriptionProvider(normalizedConfigured, params.config)].filter(
        (provider) => provider !== undefined,
      )
    : listTalkTranscriptionProviders(params.config, Object.keys(params.providerConfigs));
  // An explicit provider is authoritative; automatic selection is stable by
  // provider order so the same config picks the same transcription backend.
  const orderedProviders = normalizedConfigured
    ? providers
    : providers.toSorted((a, b) => (a.autoSelectOrder ?? 1000) - (b.autoSelectOrder ?? 1000));
  for (const provider of orderedProviders) {
    const rawConfig = getVoiceProviderConfig({
      providerConfigs: params.providerConfigs,
      provider,
      configuredProviderId: params.configuredProviderId,
    });
    const model =
      params.requestedModel ?? (rawConfig.model === undefined ? params.defaultModel : undefined);
    const rawConfigWithModel = model ? { ...rawConfig, model } : rawConfig;
    const providerConfig =
      provider.resolveConfig?.({ cfg: params.config, rawConfig: rawConfigWithModel }) ??
      rawConfigWithModel;
    if (
      await configuredOrFalseAsync(() =>
        provider.isConfiguredAsync
          ? provider.isConfiguredAsync({ cfg: params.config, providerConfig })
          : (provider.isConfigured?.({ cfg: params.config, providerConfig }) ?? false),
      )
    ) {
      return { provider, providerConfig };
    }
  }
  if (normalizedConfigured) {
    throw new Error(
      `Realtime transcription provider "${params.configuredProviderId}" is not configured`,
    );
  }
  throw new Error("No realtime transcription provider registered");
}

const DEFAULT_REALTIME_INSTRUCTIONS = [
  "You are OpenClaw's realtime voice interface. Keep spoken replies concise.",
  `If the user asks for code, repository state, files, current OpenClaw context, tool-backed actions, or deeper reasoning, call ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} and then summarize the result naturally.`,
  `Do not claim you cannot use tools, perform actions, or reach OpenClaw unless ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} returns that failure.`,
  `When ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} is in progress, speak one brief acknowledgement such as "Let me check that for you", then wait for the final OpenClaw result before answering with the actual result.`,
  `If OpenClaw is already working through ${REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME} and the user asks in any language for progress, cancellation, a redirect/change, or a follow-up, call ${REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME} with the semantic mode.`,
  "For greetings and casual chatter while OpenClaw is working, answer naturally and do not redirect the active work.",
].join(" ");

export function buildRealtimeInstructions(configuredInstructions?: string): string {
  const extra = normalizeOptionalString(configuredInstructions);
  if (!extra) {
    return DEFAULT_REALTIME_INSTRUCTIONS;
  }
  // Keep the tool-use contract first, then append operator customization so
  // provider sessions preserve the same control-tool behavior.
  return `${DEFAULT_REALTIME_INSTRUCTIONS}\n\nAdditional realtime instructions:\n${extra}`;
}

type RealtimeVoiceLaunchOptions = {
  model?: string;
  voice?: string;
  vadThreshold?: number;
  silenceDurationMs?: number;
  prefixPaddingMs?: number;
  reasoningEffort?: string;
};

type RealtimeVoiceLaunchOptionInput = Partial<Record<keyof RealtimeVoiceLaunchOptions, unknown>>;

export function buildRealtimeVoiceLaunchOptions(params: {
  requested: RealtimeVoiceLaunchOptionInput;
  defaults: RealtimeVoiceLaunchOptions;
}): RealtimeVoiceLaunchOptions {
  // Per-request browser controls override config defaults, but only when they
  // are valid primitive values the realtime provider can consume.
  return {
    ...pickRealtimeVoiceLaunchOptions(params.defaults),
    ...pickRealtimeVoiceLaunchOptions(params.requested),
  };
}

function pickRealtimeVoiceLaunchOptions(
  params: RealtimeVoiceLaunchOptionInput,
): RealtimeVoiceLaunchOptions {
  const options: RealtimeVoiceLaunchOptions = {};
  for (const key of ["model", "voice", "reasoningEffort"] as const) {
    const value = normalizeOptionalString(params[key]);
    if (value) {
      options[key] = value;
    }
  }
  for (const key of ["vadThreshold", "silenceDurationMs", "prefixPaddingMs"] as const) {
    const value = params[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      options[key] = value;
    }
  }
  return options;
}

export function resolveTalkClientLaunchError({
  mode,
  brain,
  transport,
  wantsGatewayControl,
  wantsCameraFrames,
}: {
  mode: string;
  brain: string;
  transport: TalkRealtimeConfig["transport"];
  wantsGatewayControl: boolean;
  wantsCameraFrames: boolean;
}):
  | { code: typeof ErrorCodes.INVALID_REQUEST | typeof ErrorCodes.UNAVAILABLE; message: string }
  | undefined {
  if (mode !== "realtime") {
    return {
      code: ErrorCodes.INVALID_REQUEST,
      message: `talk.client.create only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
    };
  }
  if (brain !== "agent-consult") {
    return {
      code: ErrorCodes.INVALID_REQUEST,
      message: `talk.client.create only supports brain="agent-consult"`,
    };
  }
  if (wantsGatewayControl && wantsCameraFrames) {
    return {
      code: ErrorCodes.INVALID_REQUEST,
      message: "gateway-control-v1 supports audio-only WebRTC sessions",
    };
  }
  if (transport === "managed-room") {
    return {
      code: ErrorCodes.UNAVAILABLE,
      message: "managed-room realtime Talk sessions are not available in the browser UI yet",
    };
  }
  if (transport === "gateway-relay") {
    return {
      code: ErrorCodes.INVALID_REQUEST,
      message: wantsCameraFrames
        ? "gateway-relay does not support browser video frames"
        : `talk.client.create is client-owned; use talk.session.create for gateway-relay`,
    };
  }
  return undefined;
}

export function assertTalkClientSessionEntryDeadline(deadlineAt: number | undefined): void {
  if (deadlineAt !== undefined && Date.now() >= deadlineAt) {
    throw new Error("Realtime browser session expired during startup; try again");
  }
}
