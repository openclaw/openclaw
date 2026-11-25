import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  normalizeUiAppearancePreference,
  type TalkSpeakParams,
  UI_APPEARANCE_PREFERENCE_KEYS,
  validateTalkConfigParams,
  validateTalkSpeakParams,
} from "../../../../packages/gateway-protocol/src/index.js";
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
import type { OpenClawConfig } from "../../../config/types.js";
import type { RealtimeVoicePublicClientHints } from "../../../plugins/provider-policy-surface.js";
import {
  assertSecretOwnerAvailable,
  isSecretOwnerAvailable,
} from "../../../secrets/runtime-degraded-state.js";
import { getCanonicalUserPreferences } from "../../../state/user-preferences.js";
import {
  projectInternalRealtimeVoicePublicConfig,
  projectInternalRealtimeVoicePublicProjection,
} from "../../../talk/provider-internal.js";
import {
  canonicalizeRealtimeVoiceProviderId,
  getRealtimeVoiceProvider,
} from "../../../talk/provider-registry.js";
import { canonicalizeSpeechProviderId, getSpeechProvider } from "../../../tts/provider-registry.js";
import { withSpeakerSelectionFallbackCompat } from "../../../tts/speaker.js";
import { CODE_HEAVY_SPOKEN_FALLBACK, isCodeHeavySpeechText } from "../../../tts/speech-text.js";
import { synthesizeTalkSpeech } from "../../../tts/tts-synthesis.js";
import type { TtsDirectiveOverrides } from "../../../tts/tts.js";
import { ADMIN_SCOPE, READ_SCOPE, TALK_SECRETS_SCOPE } from "../../operator-scopes.js";
import { respondUnavailable } from "../../server-methods/response.js";
import { inferSpeechMimeType } from "../../server-methods/speech-mime.js";
import type { GatewayRequestHandlers } from "../../server-methods/types.js";
import { assertValidParams } from "../../server-methods/validation.js";
import { formatForLog } from "../../ws-log.js";
import { buildTalkRealtimeConfig } from "../session-config.js";
import { talkCatalogHandler } from "./catalog.js";
import { talkClientHandlers } from "./client.js";
import { talkSessionHandlers } from "./session.js";
import {
  buildTalkTtsConfig,
  resolveTalkVoiceId,
  withTalkBaseTtsSpeakerSelectionCompat,
  type TalkSpeakReason,
} from "./speech-config.js";
import { talkVoiceHandlers } from "./voice.js";

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = client?.connect?.scopes ?? [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
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
  // source config so SecretRefs stay redacted.
  const runtimeRealtime = await buildTalkRealtimeConfig(params.runtimeConfig);
  const effectiveProvider = canonicalizeRealtimeVoiceProviderId(
    runtimeRealtime.provider,
    params.runtimeConfig,
  );
  const sourceProviders: Record<string, TalkProviderConfig> = {};
  const configuredProviders = params.sourceConfig.talk?.realtime?.providers ?? {};
  for (const [providerId, providerConfig] of Object.entries(configuredProviders)) {
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
  "talk.catalog": talkCatalogHandler,
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
