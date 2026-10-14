import { asOptionalRecord, filterStringRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  normalizeUiAppearancePreference,
  type TalkCatalogParams,
  type TalkSpeakParams,
  UI_APPEARANCE_PREFERENCE_KEYS,
  validateTalkCatalogParams,
  validateTalkConfigParams,
  validateTalkSpeakParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../../agents/agent-scope.js";
import { projectConfigOntoRuntimeSourceSnapshot } from "../../../config/config.js";
import { redactConfigObject } from "../../../config/redact-snapshot.js";
import {
  buildTalkConfigResponse,
  normalizeTalkSection,
  resolveActiveTalkProviderConfig,
} from "../../../config/talk.js";
import type {
  TalkConfigResponse,
  TalkProviderConfig,
  TalkRealtimeConfig,
} from "../../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../../config/types.js";
import { resolveProviderRawConfig } from "../../../plugin-sdk/provider-selection-runtime.js";
import type { RealtimeVoicePublicClientHints } from "../../../plugins/provider-policy-surface.js";
import {
  assertSecretOwnerAvailable,
  isSecretOwnerAvailable,
} from "../../../secrets/runtime-degraded-state.js";
import { getCanonicalUserPreferences } from "../../../state/user-preferences.js";
import { resolveTalkSessionAgentId } from "../../../talk/agent-target.js";
import {
  projectInternalRealtimeVoicePublicConfig,
  projectInternalRealtimeVoicePublicProjection,
  type InternalRealtimeVoiceProviderCapabilities,
} from "../../../talk/provider-internal.js";
import {
  canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider,
  listRealtimeVoiceProviders,
} from "../../../talk/provider-registry.js";
import {
  isRealtimeVoiceProviderConfiguredAsync,
  resolveConfiguredRealtimeVoiceProviderAsync,
  resolveRealtimeVoiceProviderCapabilitiesAsync,
} from "../../../talk/provider-resolver.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../../tts/provider-registry.js";
import {
  withSpeakerSelectionCompat,
  withSpeakerSelectionFallbackCompat,
} from "../../../tts/speaker.js";
import { CODE_HEAVY_SPOKEN_FALLBACK, isCodeHeavySpeechText } from "../../../tts/speech-text.js";
import { synthesizeTalkSpeech } from "../../../tts/tts-synthesis.js";
import {
  isTtsProviderConfiguredAsync,
  resolveTtsConfig,
  type TtsDirectiveOverrides,
} from "../../../tts/tts.js";
import { providerMatchesId } from "../../../tts/voice-models.js";
import { ADMIN_SCOPE, READ_SCOPE, TALK_SECRETS_SCOPE } from "../../operator-scopes.js";
import { respondUnavailable } from "../../server-methods/response.js";
import { inferSpeechMimeType } from "../../server-methods/speech-mime.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { assertValidParams } from "../../server-methods/validation.js";
import { getSessionRowProjection } from "../../session-row-projection-access.js";
import { withPreparedSessionResolve } from "../../sessions-resolve.js";
import { formatForLog } from "../../ws-log.js";
import { buildTalkRealtimeConfig, configuredOrFalseAsync } from "../session-config.js";
import { talkClientHandlers } from "./client.js";
import {
  buildTalkTranscriptionCatalog,
  resolveCatalogProviderSelection,
} from "./provider-catalog.js";
import { talkSessionHandlers } from "./session.js";
import { talkVoiceHandlers } from "./voice.js";

type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "synthesis_failed"
  | "invalid_audio_result";

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = filterStringRecord(providerConfig.voiceAliases);
  if (!aliases) {
    return requested;
  }
  const normalizedRequested = normalizeLowercaseStringOrEmpty(requested);
  for (const [alias, voiceId] of Object.entries(aliases)) {
    if (normalizeLowercaseStringOrEmpty(alias) === normalizedRequested) {
      return voiceId;
    }
  }
  return requested;
}

function withTalkBaseTtsSpeakerSelectionCompat(
  baseTts: Record<string, unknown>,
  talkProvider?: { provider: { id: string; aliases?: readonly string[] }; apiKey?: unknown },
): Record<string, unknown> {
  const next = withSpeakerSelectionCompat(baseTts);
  const providers = asOptionalRecord(baseTts.providers);
  if (providers) {
    next.providers = Object.fromEntries(
      Object.entries(providers).map(([providerId, providerConfig]) => {
        const normalized = withSpeakerSelectionCompat(asOptionalRecord(providerConfig) ?? {});
        // Talk-owned overrides must shield provider normalization from a cold global TTS ref.
        if (
          typeof talkProvider?.apiKey === "string" &&
          providerMatchesId(talkProvider.provider, providerId) &&
          typeof normalized.apiKey === "object"
        ) {
          normalized.apiKey = talkProvider.apiKey;
        }
        return [providerId, normalized];
      }),
    );
  }
  for (const [key, value] of Object.entries(baseTts)) {
    if (key === "providers") {
      continue;
    }
    const record = asOptionalRecord(value);
    if (record) {
      next[key] = withSpeakerSelectionCompat(record);
    }
  }
  return next;
}

function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string; reason: TalkSpeakReason } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = canonicalizeSpeechProviderId(resolved?.provider, config);
  if (!resolved || !provider) {
    return {
      error: "talk.speak unavailable: talk provider not configured",
      reason: "talk_unconfigured",
    };
  }
  assertSecretOwnerAvailable("capability", "talk:speech");

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const providerConfig = withSpeakerSelectionFallbackCompat(resolved.config);
  const baseTts = withTalkBaseTtsSpeakerSelectionCompat(asOptionalRecord(config.tts) ?? {}, {
    provider: speechProvider,
    apiKey: providerConfig.apiKey,
  }) as TtsConfig;
  const resolvedProviderConfig =
    speechProvider.resolveTalkConfig?.({
      cfg: config,
      baseTtsConfig: baseTts as Record<string, unknown>,
      talkProviderConfig: providerConfig,
      timeoutMs: baseTts.timeoutMs ?? 30_000,
    }) ?? providerConfig;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
    providers: {
      ...((asOptionalRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      tts: talkTts,
    },
  };
}

async function buildTalkCatalog(config: OpenClawConfig, params: TalkCatalogParams) {
  // Reject ambiguous ownership before provider discovery loads unrelated plugins.
  const realtimeAgentId = resolveTalkSessionAgentId(config, params.sessionKey);
  const talkResolved = resolveActiveTalkProviderConfig(config.talk);
  const activeSpeechProvider = canonicalizeSpeechProviderId(talkResolved?.provider, config);
  const requestedProvider = normalizeOptionalString(params.provider);
  const requestedModel = normalizeOptionalString(params.model);
  const realtimeConfig = await buildTalkRealtimeConfig(config, requestedProvider, requestedModel);
  const realtimeProviderIds = [
    ...(requestedProvider ? [requestedProvider] : []),
    ...Object.keys(realtimeConfig.providers),
  ];
  const realtimeSurface =
    realtimeConfig.transport === "gateway-relay" ? "gateway-relay" : "browser-session";
  const realtimeResolveContext = {
    cfg: config,
    agentId: realtimeAgentId,
    surface: realtimeSurface,
    ...(realtimeSurface === "gateway-relay"
      ? { autoRespondToAudio: realtimeConfig.consultRouting !== "force-agent-consult" }
      : {}),
  } as const;
  // Mirror talk.client.create's resolution inputs (agent scope + top-level model
  // override) so catalog readiness matches what session creation will actually do;
  // diverging here previously reported GPT-Live over OAuth as unconfigured.
  const realtimeModel = requestedModel ?? realtimeConfig.model;
  const realtimeModelOverride = realtimeModel
    ? { providerConfigOverrides: { model: realtimeModel } }
    : {};
  const realtimeSelection = await resolveCatalogProviderSelection(
    canonicalizeRealtimeVoiceProviderId(realtimeConfig.provider, config),
    async () => {
      assertSecretOwnerAvailable("capability", "talk:realtime");
      return resolveConfiguredRealtimeVoiceProviderAsync({
        ...realtimeResolveContext,
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        ...realtimeModelOverride,
        defaultModel: realtimeConfig.model,
      });
    },
  );
  const activeRealtimeProvider = realtimeSelection.activeProvider;
  const speechAvailable = isSecretOwnerAvailable("capability", "talk:speech");

  const [speechProviders, transcription, realtimeProviders] = await Promise.all([
    Promise.all(
      listSpeechProviders(config).map(async (provider) => {
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured:
            speechAvailable &&
            (await configuredOrFalseAsync(() => {
              const setup =
                provider.id === activeSpeechProvider ? buildTalkTtsConfig(config) : undefined;
              const effectiveConfig = setup && !("error" in setup) ? setup.cfg : config;
              const effectiveTts = resolveTtsConfig(effectiveConfig);
              return isTtsProviderConfiguredAsync(effectiveTts, provider);
            })),
          modes: ["stt-tts"],
          brains: ["agent-consult"],
        };
        if (provider.models) {
          entry.models = [...provider.models];
        }
        if (provider.aliases?.length) {
          entry.aliases = [...provider.aliases];
        }
        if (provider.voices) {
          entry.voices = [...provider.voices];
        }
        return entry;
      }),
    ),
    buildTalkTranscriptionCatalog(config, realtimeAgentId),
    Promise.all(
      listRealtimeVoiceProviders(config, realtimeProviderIds).map(async (provider) => {
        const available = isSecretOwnerAvailable("capability", "talk:realtime");
        const selected =
          available && provider.id === activeRealtimeProvider
            ? realtimeSelection.resolved
            : undefined;
        const rawConfig = resolveProviderRawConfig({
          providerConfigs: realtimeConfig.providers ?? {},
          providerId: provider.id,
          providerAliases: provider.aliases,
          configuredProviderId:
            provider.id === activeRealtimeProvider ? realtimeConfig.provider : undefined,
        });
        // Top-level talk.realtime.model overrides provider-level config, matching
        // talk.client.create's providerConfigOverrides precedence at session time.
        const model = provider.id === activeRealtimeProvider ? realtimeModel : realtimeConfig.model;
        const rawConfigWithModel = model ? { ...rawConfig, model } : rawConfig;
        const defaultRawConfig = { ...rawConfig };
        delete defaultRawConfig.model;
        const resolveConfig = async (rawInput: typeof defaultRawConfig) =>
          available
            ? ((await (provider.resolveConfigAsync?.({
                ...realtimeResolveContext,
                rawConfig: rawInput,
              }) ??
                provider.resolveConfig?.({ ...realtimeResolveContext, rawConfig: rawInput }))) ??
              rawInput)
            : rawInput;
        // Selection already prepared this request's effective config and capabilities.
        // Only an explicit model needs a separate discovery-default resolution.
        const defaultProviderConfig =
          selected && rawConfigWithModel.model === undefined
            ? selected.providerConfig
            : await resolveConfig(defaultRawConfig);
        const providerConfig =
          selected?.providerConfig ??
          (available && rawConfigWithModel.model === undefined
            ? defaultProviderConfig
            : await resolveConfig(rawConfigWithModel));
        const capabilities: InternalRealtimeVoiceProviderCapabilities | undefined = selected
          ? selected.capabilities
          : available
            ? await resolveRealtimeVoiceProviderCapabilitiesAsync({
                provider,
                providerConfig,
                cfg: config,
                agentId: realtimeAgentId,
                surface: realtimeSurface,
              })
            : provider.capabilities;
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured:
            available &&
            (selected !== undefined ||
              (await configuredOrFalseAsync(() =>
                isRealtimeVoiceProviderConfiguredAsync({
                  provider,
                  cfg: config,
                  providerConfig,
                  agentId: realtimeAgentId,
                  surface: realtimeSurface,
                }),
              ))),
          modes: ["realtime"],
          brains:
            capabilities?.supportsToolCalls === false && capabilities.handlesAgentConsult !== true
              ? ["none"]
              : ["agent-consult"],
          supportsBrowserSession: Boolean(
            capabilities?.supportsBrowserSession ?? provider.createBrowserSession,
          ),
        };
        const defaultModel =
          normalizeOptionalString(defaultProviderConfig.model) ?? provider.defaultModel;
        if (defaultModel) {
          entry.defaultModel = defaultModel;
        }
        if (provider.models?.length) {
          entry.models = [...provider.models];
        }
        if (provider.voices) {
          entry.voices = [...provider.voices];
        }
        if (capabilities?.voices) {
          entry.activeVoices = [...capabilities.voices];
        }
        if (capabilities?.voiceSelectionPolicy) {
          entry.activeVoiceSelectionPolicy = capabilities.voiceSelectionPolicy;
        }
        if (capabilities?.voicesByModel) {
          entry.voicesByModel = capabilities.voicesByModel;
        }
        if (provider.aliases?.length) {
          entry.aliases = [...provider.aliases];
        }
        if (capabilities?.transports) {
          entry.transports = [...capabilities.transports];
        }
        for (const key of ["inputAudioFormats", "outputAudioFormats"] as const) {
          const formats = capabilities?.[key];
          if (formats) {
            entry[key] = formats.map((format) => Object.assign({}, format));
          }
        }
        for (const key of [
          "supportsBargeIn",
          "supportsToolCalls",
          "supportsVideoFrames",
          "supportsSessionResumption",
        ] as const) {
          if (capabilities?.[key] !== undefined) {
            entry[key] = capabilities[key];
          }
        }
        return entry;
      }),
    ),
  ]);
  return {
    modes: ["realtime", "stt-tts", "transcription"],
    transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
    brains: ["agent-consult", "direct-tools", "none"],
    speech: {
      ...(activeSpeechProvider ? { activeProvider: activeSpeechProvider } : {}),
      providers: speechProviders,
    },
    transcription,
    realtime: {
      ready: realtimeSelection.ready,
      ...(activeRealtimeProvider ? { activeProvider: activeRealtimeProvider } : {}),
      providers: realtimeProviders,
    },
  };
}

function talkSpeakError(reason: TalkSpeakReason, message: string) {
  return errorShape(ErrorCodes.UNAVAILABLE, message, {
    details: {
      reason,
      fallbackEligible: reason === "talk_unconfigured" || reason === "talk_provider_unsupported",
    },
  });
}

function resolveTalkSpeed(params: TalkSpeakParams): number | undefined {
  if (typeof params.speed === "number") {
    return params.speed;
  }
  if (typeof params.rateWpm !== "number" || params.rateWpm <= 0) {
    return undefined;
  }
  const resolved = params.rateWpm / 175;
  if (resolved <= 0.5 || resolved >= 2) {
    return undefined;
  }
  return resolved;
}

async function resolveTalkResponseFromConfig(params: {
  includeSecrets: boolean;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
}): Promise<
  { talk: TalkConfigResponse; realtimeClientHints?: RealtimeVoicePublicClientHints } | undefined
> {
  // Normalize once at the Gateway boundary. Legacy flat provider fields belong to doctor
  // migration and must not leak into steady-state response construction.
  const normalizedTalk = normalizeTalkSection(params.sourceConfig.talk);
  const configuredPayload = normalizedTalk ? buildTalkConfigResponse(normalizedTalk) : undefined;
  // Resolve provider selection from materialized config, but project provider-owned fields from
  // source config so SecretRefs stay redacted. The requested provider also avoids re-resolving them.
  const runtimeRealtime = await buildTalkRealtimeConfig(params.runtimeConfig);
  const effectiveProvider = canonicalizeRealtimeVoiceProviderId(
    runtimeRealtime.provider,
    params.runtimeConfig,
  );
  const sourceRealtime = await buildTalkRealtimeConfig(params.sourceConfig, effectiveProvider);
  const sourceProviders: Record<string, TalkProviderConfig> = {};
  for (const [providerId, providerConfig] of Object.entries(sourceRealtime.providers)) {
    const canonicalProviderId =
      canonicalizeRealtimeVoiceProviderId(providerId, params.runtimeConfig) ?? providerId;
    sourceProviders[canonicalProviderId] = {
      ...sourceProviders[canonicalProviderId],
      ...providerConfig,
    };
  }
  const effectiveRealtime = normalizeTalkSection({
    realtime: {
      ...(effectiveProvider ? { provider: effectiveProvider } : {}),
      ...(runtimeRealtime.model ? { model: runtimeRealtime.model } : {}),
      ...(runtimeRealtime.transport ? { transport: runtimeRealtime.transport } : {}),
      ...(Object.keys(sourceProviders).length > 0 ? { providers: sourceProviders } : {}),
    },
  })?.realtime;
  if (!configuredPayload && !effectiveRealtime) {
    return undefined;
  }
  const realtime: TalkRealtimeConfig | undefined = effectiveRealtime
    ? {
        ...configuredPayload?.realtime,
        ...effectiveRealtime,
      }
    : configuredPayload?.realtime;
  let sourcePayload: TalkConfigResponse = {
    ...configuredPayload,
    ...(realtime ? { realtime } : {}),
  };
  let realtimeClientHints: RealtimeVoicePublicClientHints | undefined;
  if (realtime) {
    const providers = realtime.providers
      ? Object.fromEntries(
          Object.entries(realtime.providers).map(([providerId, config]) => [
            providerId,
            projectInternalRealtimeVoicePublicConfig({
              provider: getRealtimeVoiceProvider(providerId, params.runtimeConfig),
              providerId,
              providerConfig: config,
              config,
            }),
          ]),
        )
      : undefined;
    const providerConfig = realtime.providers?.[effectiveProvider ?? ""] ?? {};
    const realtimeProvider = getRealtimeVoiceProvider(effectiveProvider, params.runtimeConfig);
    const projection = projectInternalRealtimeVoicePublicProjection({
      ...(realtimeProvider ? { provider: realtimeProvider } : {}),
      providerId: effectiveProvider,
      providerConfig,
      config: { ...realtime, ...(providers ? { providers } : {}) },
    });
    sourcePayload = { ...sourcePayload, realtime: projection.config };
    realtimeClientHints = projection.clientHints;
  }
  const payload = params.includeSecrets
    ? projectTalkSourcePayloadForSecrets(sourcePayload)
    : sourcePayload;

  const sourceResolved = configuredPayload?.resolved;
  const runtimeResolved = resolveActiveTalkProviderConfig(params.runtimeConfig.talk);
  const activeProviderId = sourceResolved?.provider ?? runtimeResolved?.provider;
  const provider = canonicalizeSpeechProviderId(activeProviderId, params.runtimeConfig);
  if (!provider) {
    return { talk: payload, realtimeClientHints };
  }
  if (params.includeSecrets) {
    assertSecretOwnerAvailable("capability", "talk:speech");
  } else if (!isSecretOwnerAvailable("capability", "talk:speech")) {
    // A readable redacted projection must not normalize a cold ref into provider/env fallback.
    return { talk: payload, realtimeClientHints };
  }

  const speechProvider = getSpeechProvider(provider, params.runtimeConfig);
  const sourceBaseTts = withTalkBaseTtsSpeakerSelectionCompat(
    asOptionalRecord(params.sourceConfig.tts) ?? {},
  );
  const sourceProviderConfig = withSpeakerSelectionFallbackCompat(sourceResolved?.config);
  const runtimeProviderConfig = withSpeakerSelectionFallbackCompat(runtimeResolved?.config);
  const providerInputConfig = stripUnresolvedSecretApiKey(
    Object.keys(runtimeProviderConfig).length > 0 ? runtimeProviderConfig : sourceProviderConfig,
  );
  const runtimeBaseTts = withTalkBaseTtsSpeakerSelectionCompat(
    asOptionalRecord(params.runtimeConfig.tts) ?? {},
    { provider: speechProvider ?? { id: provider }, apiKey: providerInputConfig.apiKey },
  );
  const selectedBaseTts =
    Object.keys(runtimeBaseTts).length > 0
      ? runtimeBaseTts
      : stripUnresolvedSecretApiKeysFromBaseTtsProviders(sourceBaseTts);
  const resolvedConfig =
    speechProvider?.resolveTalkConfig?.({
      cfg: params.runtimeConfig,
      baseTtsConfig: selectedBaseTts,
      talkProviderConfig: providerInputConfig,
      timeoutMs: typeof selectedBaseTts.timeoutMs === "number" ? selectedBaseTts.timeoutMs : 30_000,
    }) ?? providerInputConfig;
  const responseConfig = projectTalkResolvedProviderConfig({
    includeSecrets: params.includeSecrets,
    sourceProviderConfig,
    resolvedConfig,
  });

  return {
    talk: {
      ...payload,
      provider,
      resolved: {
        provider,
        config: responseConfig,
      },
    },
    realtimeClientHints,
  };
}

function projectTalkResolvedProviderConfig(params: {
  includeSecrets: boolean;
  sourceProviderConfig: TalkProviderConfig;
  resolvedConfig: TalkProviderConfig;
}): TalkProviderConfig {
  if (!params.includeSecrets) {
    return params.sourceProviderConfig.apiKey === undefined
      ? params.resolvedConfig
      : { ...params.resolvedConfig, apiKey: params.sourceProviderConfig.apiKey };
  }

  // includeSecrets authorizes the active Talk provider key only. Keep resolver
  // defaults in the resolved payload, but do not turn arbitrary provider-owned
  // secret-like fields into a new native-client credential surface.
  const projected = redactConfigObject(params.resolvedConfig);
  const apiKey = normalizeOptionalString(params.resolvedConfig.apiKey);
  return apiKey === undefined ? projected : { ...projected, apiKey };
}

function projectTalkSourceProviderConfigForSecrets(config: TalkProviderConfig): TalkProviderConfig {
  const projected = redactConfigObject(config);
  if (config.apiKey === undefined || typeof config.apiKey === "string") {
    return projected;
  }
  return { ...projected, apiKey: config.apiKey };
}

function projectTalkSourceProviderMapForSecrets(
  providers: Record<string, TalkProviderConfig> | undefined,
): Record<string, TalkProviderConfig> | undefined {
  if (!providers) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(providers).map(([providerId, providerConfig]) => [
      providerId,
      projectTalkSourceProviderConfigForSecrets(providerConfig),
    ]),
  );
}

function projectTalkSourcePayloadForSecrets(payload: TalkConfigResponse): TalkConfigResponse {
  const projected = redactConfigObject(payload);
  const providers = projectTalkSourceProviderMapForSecrets(payload.providers);
  if (providers) {
    projected.providers = providers;
  }
  if (payload.realtime) {
    const realtime = redactConfigObject(payload.realtime);
    const realtimeProviders = projectTalkSourceProviderMapForSecrets(payload.realtime.providers);
    projected.realtime = realtimeProviders
      ? { ...realtime, providers: realtimeProviders }
      : realtime;
  }
  return projected;
}

function stripUnresolvedSecretApiKeysFromBaseTtsProviders(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const providers = asOptionalRecord(base.providers);
  if (!providers) {
    return base;
  }
  let mutated = false;
  // Provider ids come from operator config and must remain inert object keys.
  const cleaned: Record<string, unknown> = Object.create(null);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const cfg = asOptionalRecord(providerConfig);
    if (!cfg) {
      cleaned[providerId] = providerConfig;
      continue;
    }
    const next = stripUnresolvedSecretApiKey(cfg);
    if (next !== cfg) {
      mutated = true;
    }
    cleaned[providerId] = next;
  }
  if (!mutated) {
    return base;
  }
  return { ...base, providers: cleaned };
}

function stripUnresolvedSecretApiKey(config: TalkProviderConfig): TalkProviderConfig {
  if (config.apiKey === undefined || typeof config.apiKey === "string") {
    return config;
  }
  const { apiKey: _omit, ...rest } = config;
  return rest;
}

export const talkHandlers: GatewayRequestHandlers = {
  ...talkVoiceHandlers,
  ...talkSessionHandlers,
  ...talkClientHandlers,
  "talk.catalog": async ({ params, respond, context, client }) => {
    const catalogParams = params ?? {};
    if (!assertValidParams(catalogParams, validateTalkCatalogParams, "talk.catalog", respond)) {
      return;
    }

    try {
      const config = context.getRuntimeConfig();
      if (!catalogParams.sessionKey) {
        respond(true, await buildTalkCatalog(config, catalogParams), undefined);
        return;
      }
      const projection = getSessionRowProjection(context);
      if (!projection) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "Session rows are initializing; try again"),
        );
        return;
      }
      const agentId = resolveTalkSessionAgentId(config, catalogParams.sessionKey);
      const resolveSession = () =>
        withPreparedSessionResolve(
          {
            projection,
            client,
            isCurrent: () => getSessionRowProjection(context) === projection,
            p: {
              key: catalogParams.sessionKey,
              agentId,
              includeGlobal: true,
              includeUnknown: true,
            },
          },
          (session) => {
            if (!session.ok) {
              respond(false, undefined, session.error);
            } else if ("missing" in session || "ambiguous" in session) {
              respond(
                false,
                undefined,
                errorShape(
                  ErrorCodes.INVALID_REQUEST,
                  `No session found: ${catalogParams.sessionKey}`,
                ),
              );
            } else {
              return session.key;
            }
            return undefined;
          },
        );
      const sessionKey = await resolveSession();
      if (!sessionKey) {
        return;
      }
      const catalog = await buildTalkCatalog(config, { ...catalogParams, sessionKey });
      // Provider readiness can yield; publish only while the session is still visible.
      if (await resolveSession()) {
        respond(true, catalog, undefined);
      }
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          err instanceof AgentSelectionRequiredError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
          formatForLog(err),
        ),
      );
    }
  },
  "talk.config": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateTalkConfigParams, "talk.config", respond)) {
      return;
    }

    const includeSecrets = Boolean(params.includeSecrets);
    if (includeSecrets && !canReadTalkSecrets(client)) {
      respond(
        false,
        undefined,
        missingScopeErrorShape({
          missingScope: TALK_SECRETS_SCOPE,
          requiredScopes: [READ_SCOPE, TALK_SECRETS_SCOPE],
        }),
      );
      return;
    }

    const runtimeConfig = context.getRuntimeConfig();
    const sourceConfig = projectConfigOntoRuntimeSourceSnapshot(runtimeConfig);
    const configPayload: Record<string, unknown> = {};

    let talk: TalkConfigResponse | undefined;
    let realtimeClientHints: RealtimeVoicePublicClientHints | undefined;
    try {
      const resolved = await resolveTalkResponseFromConfig({
        includeSecrets,
        sourceConfig,
        runtimeConfig,
      });
      talk = resolved?.talk;
      realtimeClientHints = resolved?.realtimeClientHints;
    } catch (err) {
      respondUnavailable(respond, err);
      return;
    }
    if (talk) {
      configPayload.talk = includeSecrets ? talk : redactConfigObject(talk);
    }
    if (realtimeClientHints) {
      configPayload.clientHints = { realtime: realtimeClientHints };
    }

    const sessionMainKey = runtimeConfig.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const profileId = client?.authenticatedUserProfile?.profileId;
    const accentKey = UI_APPEARANCE_PREFERENCE_KEYS.accent;
    const preferences = profileId
      ? await getCanonicalUserPreferences(profileId, [accentKey])
      : undefined;
    const profileAccent = preferences
      ? normalizeUiAppearancePreference(accentKey, preferences.entries[accentKey])
      : undefined;
    // Profile accent overrides gateway prefs, then the gateway seam color and theme default.
    const seamColor =
      profileAccent ?? runtimeConfig.ui?.prefs?.accent ?? runtimeConfig.ui?.seamColor;
    if (typeof seamColor === "string" && seamColor !== "theme") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
  "talk.speak": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateTalkSpeakParams, "talk.speak", respond)) {
      return;
    }

    const text = normalizeOptionalString(params.text);
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak requires text"));
      return;
    }

    if (params.speed == null && params.rateWpm != null && resolveTalkSpeed(params) == null) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.speak params: rateWpm must resolve to speed between 0.5 and 2.0`,
        ),
      );
      return;
    }

    try {
      const runtimeConfig = context.getRuntimeConfig();
      const setup = buildTalkTtsConfig(runtimeConfig);
      if ("error" in setup) {
        respond(false, undefined, talkSpeakError(setup.reason, setup.error));
        return;
      }

      const overrides: TtsDirectiveOverrides = { provider: setup.provider };
      const speechProvider = getSpeechProvider(setup.provider, runtimeConfig);
      if (speechProvider?.resolveTalkOverrides) {
        const resolvedSpeed = resolveTalkSpeed(params);
        const resolvedVoiceId = resolveTalkVoiceId(
          setup.providerConfig,
          normalizeOptionalString(params.voiceId),
        );
        const providerOverrides = speechProvider.resolveTalkOverrides({
          talkProviderConfig: setup.providerConfig,
          params: {
            ...params,
            ...(resolvedVoiceId == null ? {} : { voiceId: resolvedVoiceId }),
            ...(resolvedSpeed == null ? {} : { speed: resolvedSpeed }),
          },
        });
        if (providerOverrides && Object.keys(providerOverrides).length > 0) {
          overrides.providerOverrides = { [setup.provider]: providerOverrides };
        }
      }
      const speechText = isCodeHeavySpeechText(text) ? CODE_HEAVY_SPOKEN_FALLBACK : text;
      const result = await synthesizeTalkSpeech({
        text: speechText,
        cfg: setup.cfg,
        overrides,
        disableFallback: true,
      });
      if (!result.success || !result.audioBuffer) {
        respond(
          false,
          undefined,
          talkSpeakError("synthesis_failed", result.error ?? "talk synthesis failed"),
        );
        return;
      }
      const invalidAudio =
        (result.provider ?? setup.provider).trim().length === 0
          ? "provider"
          : result.audioBuffer.length === 0
            ? "audio"
            : undefined;
      if (invalidAudio) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", `talk synthesis returned empty ${invalidAudio}`),
        );
        return;
      }

      respond(
        true,
        {
          audioBase64: result.audioBuffer.toString("base64"),
          provider: result.provider ?? setup.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
          mimeType: inferSpeechMimeType(result.outputFormat, result.fileExtension),
          fileExtension: result.fileExtension,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, talkSpeakError("synthesis_failed", formatForLog(err)));
    }
  },
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
