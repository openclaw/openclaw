import { randomUUID } from "node:crypto";
import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  buildTalkConfigResponse,
  normalizeTalkSection,
  resolveActiveTalkProviderConfig,
} from "../../config/talk.js";
import type { TalkConfigResponse, TalkProviderConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig, TtsProviderConfigMap } from "../../config/types.js";
import { listRealtimeTranscriptionProviders } from "../../realtime-transcription/provider-registry.js";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  buildRealtimeVoiceAgentConsultChatMessage,
} from "../../realtime-voice/agent-consult-tool.js";
import {
  canonicalizeRealtimeVoiceProviderId,
  listRealtimeVoiceProviders,
} from "../../realtime-voice/provider-registry.js";
import { resolveConfiguredRealtimeVoiceProvider } from "../../realtime-voice/provider-resolver.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import {
  canonicalizeSpeechProviderId,
  getSpeechProvider,
  listSpeechProviders,
} from "../../tts/provider-registry.js";
import {
  getResolvedSpeechProviderConfig,
  resolveTtsConfig,
  synthesizeSpeech,
  type TtsDirectiveOverrides,
} from "../../tts/tts.js";
import { ADMIN_SCOPE, TALK_SECRETS_SCOPE } from "../operator-scopes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type ErrorShape,
  type TalkSpeakParams,
  validateTalkCatalogParams,
  validateTalkConfigParams,
  validateTalkHandoffCreateParams,
  validateTalkHandoffJoinParams,
  validateTalkHandoffRevokeParams,
  validateTalkHandoffTurnCancelParams,
  validateTalkHandoffTurnEndParams,
  validateTalkHandoffTurnStartParams,
  validateTalkModeParams,
  validateTalkRealtimeRelayAudioParams,
  validateTalkRealtimeRelayCancelParams,
  validateTalkRealtimeRelayMarkParams,
  validateTalkRealtimeRelayStopParams,
  validateTalkRealtimeRelayToolResultParams,
  validateTalkRealtimeSessionParams,
  validateTalkRealtimeToolCallParams,
  validateTalkTranscriptionRelayAudioParams,
  validateTalkTranscriptionRelayCancelParams,
  validateTalkTranscriptionRelayStopParams,
  validateTalkTranscriptionSessionParams,
  validateTalkSpeakParams,
} from "../protocol/index.js";
import { resolveSessionKeyFromResolveParams } from "../sessions-resolve.js";
import {
  cancelTalkHandoffTurn,
  createTalkHandoff,
  endTalkHandoffTurn,
  joinTalkHandoff,
  revokeTalkHandoff,
  startTalkHandoffTurn,
} from "../talk-handoff.js";
import {
  acknowledgeTalkRealtimeRelayMark,
  cancelTalkRealtimeRelayTurn,
  createTalkRealtimeRelaySession,
  registerTalkRealtimeRelayAgentRun,
  sendTalkRealtimeRelayAudio,
  stopTalkRealtimeRelaySession,
  submitTalkRealtimeRelayToolResult,
} from "../talk-realtime-relay.js";
import {
  cancelTalkTranscriptionRelayTurn,
  createTalkTranscriptionRelaySession,
  sendTalkTranscriptionRelayAudio,
  stopTalkTranscriptionRelaySession,
} from "../talk-transcription-relay.js";
import { formatForLog } from "../ws-log.js";
import { chatHandlers } from "./chat.js";
import { asRecord } from "./record-shared.js";
import { talkSessionHandlers } from "./talk-session.js";
import {
  broadcastTalkRoomEvents,
  buildRealtimeInstructions,
  buildTalkRealtimeConfig,
  buildTalkTranscriptionConfig,
  canUseTalkDirectTools,
  configuredOrFalse,
  getVoiceCallStreamingConfig,
  isUnsupportedBrowserWebRtcSession,
  resolveConfiguredRealtimeTranscriptionProvider,
  talkHandoffErrorCode,
  withRealtimeBrowserOverrides,
} from "./talk-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

type TalkSpeakReason =
  | "talk_unconfigured"
  | "talk_provider_unsupported"
  | "method_unavailable"
  | "synthesis_failed"
  | "invalid_audio_result";

type TalkSpeakErrorDetails = {
  reason: TalkSpeakReason;
  fallbackEligible: boolean;
};
function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function asStringRecord(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(record)) {
    if (typeof entryValue === "string") {
      next[key] = entryValue;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function normalizeAliasKey(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = asStringRecord(providerConfig.voiceAliases);
  if (!aliases) {
    return requested;
  }
  const normalizedRequested = normalizeAliasKey(requested);
  for (const [alias, voiceId] of Object.entries(aliases)) {
    if (normalizeAliasKey(alias) === normalizedRequested) {
      return voiceId;
    }
  }
  return requested;
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

  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider) {
    return {
      error: `talk.speak unavailable: speech provider "${provider}" does not support Talk mode`,
      reason: "talk_provider_unsupported",
    };
  }

  const baseTts = config.messages?.tts ?? {};
  const providerConfig = resolved.config;
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
      ...((asRecord(baseTts.providers) ?? {}) as TtsProviderConfigMap),
      [provider]: resolvedProviderConfig,
    },
  };

  return {
    provider,
    providerConfig,
    cfg: {
      ...config,
      messages: {
        ...config.messages,
        tts: talkTts,
      },
    },
  };
}

function buildTalkCatalog(config: OpenClawConfig) {
  const ttsConfig = resolveTtsConfig(config);
  const talkResolved = resolveActiveTalkProviderConfig(config.talk);
  const activeSpeechProvider = canonicalizeSpeechProviderId(talkResolved?.provider, config);
  const streamingConfig = getVoiceCallStreamingConfig(config);
  const realtimeConfig = buildTalkRealtimeConfig(config);
  const activeRealtimeProvider = canonicalizeRealtimeVoiceProviderId(
    realtimeConfig.provider,
    config,
  );

  return {
    modes: ["realtime", "stt-tts", "transcription"],
    transports: ["webrtc", "provider-websocket", "gateway-relay", "managed-room"],
    brains: ["agent-consult", "direct-tools", "none"],
    speech: {
      ...(activeSpeechProvider ? { activeProvider: activeSpeechProvider } : {}),
      providers: listSpeechProviders(config).map((provider) => {
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({
              cfg: config,
              providerConfig: getResolvedSpeechProviderConfig(ttsConfig, provider.id, config),
              timeoutMs: ttsConfig.timeoutMs,
            }),
          ),
          modes: ["stt-tts"],
          brains: ["agent-consult"],
        };
        if (provider.models) {
          entry.models = [...provider.models];
        }
        if (provider.voices) {
          entry.voices = [...provider.voices];
        }
        return entry;
      }),
    },
    transcription: {
      ...(streamingConfig.provider ? { activeProvider: streamingConfig.provider } : {}),
      providers: listRealtimeTranscriptionProviders(config).map((provider) => {
        const rawConfig = streamingConfig.providers?.[provider.id] ?? {};
        const providerConfig = provider.resolveConfig?.({ cfg: config, rawConfig }) ?? rawConfig;
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({ cfg: config, providerConfig }),
          ),
          modes: ["transcription"],
          transports: ["gateway-relay"],
          brains: ["none"],
        };
        if (provider.defaultModel) {
          entry.defaultModel = provider.defaultModel;
        }
        return entry;
      }),
    },
    realtime: {
      ...(activeRealtimeProvider ? { activeProvider: activeRealtimeProvider } : {}),
      providers: listRealtimeVoiceProviders(config).map((provider) => {
        const rawConfig = realtimeConfig.providers?.[provider.id] ?? {};
        const providerConfig = provider.resolveConfig?.({ cfg: config, rawConfig }) ?? rawConfig;
        const capabilities = provider.capabilities;
        const entry: Record<string, unknown> = {
          id: provider.id,
          label: provider.label,
          configured: configuredOrFalse(() =>
            provider.isConfigured({ cfg: config, providerConfig }),
          ),
          modes: ["realtime"],
          brains: capabilities?.supportsToolCalls === false ? ["none"] : ["agent-consult"],
          supportsBrowserSession: Boolean(
            capabilities?.supportsBrowserSession ?? provider.createBrowserSession,
          ),
        };
        if (provider.defaultModel) {
          entry.defaultModel = provider.defaultModel;
        }
        if (capabilities?.transports) {
          entry.transports = [...capabilities.transports];
        }
        if (capabilities?.inputAudioFormats) {
          entry.inputAudioFormats = capabilities.inputAudioFormats.map((format) => ({ ...format }));
        }
        if (capabilities?.outputAudioFormats) {
          entry.outputAudioFormats = capabilities.outputAudioFormats.map((format) => ({
            ...format,
          }));
        }
        if (capabilities?.supportsBargeIn !== undefined) {
          entry.supportsBargeIn = capabilities.supportsBargeIn;
        }
        if (capabilities?.supportsToolCalls !== undefined) {
          entry.supportsToolCalls = capabilities.supportsToolCalls;
        }
        if (capabilities?.supportsVideoFrames !== undefined) {
          entry.supportsVideoFrames = capabilities.supportsVideoFrames;
        }
        if (capabilities?.supportsSessionResumption !== undefined) {
          entry.supportsSessionResumption = capabilities.supportsSessionResumption;
        }
        return entry;
      }),
    },
  };
}

function isFallbackEligibleTalkReason(reason: TalkSpeakReason): boolean {
  return (
    reason === "talk_unconfigured" ||
    reason === "talk_provider_unsupported" ||
    reason === "method_unavailable"
  );
}

function talkSpeakError(reason: TalkSpeakReason, message: string) {
  const details: TalkSpeakErrorDetails = {
    reason,
    fallbackEligible: isFallbackEligibleTalkReason(reason),
  };
  return errorShape(ErrorCodes.UNAVAILABLE, message, { details });
}

function resolveTalkSpeed(params: TalkSpeakParams): number | undefined {
  if (typeof params.speed === "number") {
    return params.speed;
  }
  if (typeof params.rateWpm !== "number" || params.rateWpm <= 0) {
    return undefined;
  }
  const resolved = params.rateWpm / 175;
  if (resolved <= 0.5 || resolved >= 2.0) {
    return undefined;
  }
  return resolved;
}

function buildTalkSpeakOverrides(
  provider: string,
  providerConfig: TalkProviderConfig,
  config: OpenClawConfig,
  params: TalkSpeakParams,
): TtsDirectiveOverrides {
  const speechProvider = getSpeechProvider(provider, config);
  if (!speechProvider?.resolveTalkOverrides) {
    return { provider };
  }
  const resolvedSpeed = resolveTalkSpeed(params);
  const resolvedVoiceId = resolveTalkVoiceId(
    providerConfig,
    normalizeOptionalString(params.voiceId),
  );
  const providerOverrides = speechProvider.resolveTalkOverrides({
    talkProviderConfig: providerConfig,
    params: {
      ...params,
      ...(resolvedVoiceId == null ? {} : { voiceId: resolvedVoiceId }),
      ...(resolvedSpeed == null ? {} : { speed: resolvedSpeed }),
    },
  });
  if (!providerOverrides || Object.keys(providerOverrides).length === 0) {
    return { provider };
  }
  return {
    provider,
    providerOverrides: {
      [provider]: providerOverrides,
    },
  };
}

function inferMimeType(
  outputFormat: string | undefined,
  fileExtension: string | undefined,
): string | undefined {
  const normalizedOutput = normalizeOptionalLowercaseString(outputFormat);
  const normalizedExtension = normalizeOptionalLowercaseString(fileExtension);
  if (
    normalizedOutput === "mp3" ||
    normalizedOutput?.startsWith("mp3_") ||
    normalizedOutput?.endsWith("-mp3") ||
    normalizedExtension === ".mp3"
  ) {
    return "audio/mpeg";
  }
  if (
    normalizedOutput === "opus" ||
    normalizedOutput?.startsWith("opus_") ||
    normalizedExtension === ".opus" ||
    normalizedExtension === ".ogg"
  ) {
    return "audio/ogg";
  }
  if (normalizedOutput?.endsWith("-wav") || normalizedExtension === ".wav") {
    return "audio/wav";
  }
  if (normalizedOutput?.endsWith("-webm") || normalizedExtension === ".webm") {
    return "audio/webm";
  }
  return undefined;
}

function resolveTalkResponseFromConfig(params: {
  includeSecrets: boolean;
  sourceConfig: OpenClawConfig;
  runtimeConfig: OpenClawConfig;
}): TalkConfigResponse | undefined {
  const normalizedTalk = normalizeTalkSection(params.sourceConfig.talk);
  if (!normalizedTalk) {
    return undefined;
  }

  const payload = buildTalkConfigResponse(normalizedTalk);
  if (!payload) {
    return undefined;
  }

  if (params.includeSecrets) {
    return payload;
  }

  const sourceResolved = resolveActiveTalkProviderConfig(normalizedTalk);
  const runtimeResolved = resolveActiveTalkProviderConfig(params.runtimeConfig.talk);
  const activeProviderId = sourceResolved?.provider ?? runtimeResolved?.provider;
  const provider = canonicalizeSpeechProviderId(activeProviderId, params.runtimeConfig);
  if (!provider) {
    return payload;
  }

  const speechProvider = getSpeechProvider(provider, params.runtimeConfig);
  const sourceBaseTts = asRecord(params.sourceConfig.messages?.tts) ?? {};
  const runtimeBaseTts = asRecord(params.runtimeConfig.messages?.tts) ?? {};
  const sourceProviderConfig = sourceResolved?.config ?? {};
  const runtimeProviderConfig = runtimeResolved?.config ?? {};
  const selectedBaseTts =
    Object.keys(runtimeBaseTts).length > 0
      ? runtimeBaseTts
      : stripUnresolvedSecretApiKeysFromBaseTtsProviders(sourceBaseTts);
  // Prefer runtime-resolved provider config (already-substituted secrets) and
  // fall back to source. Strip any apiKey that is still a SecretRef wrapper —
  // provider plugins (ElevenLabs/OpenAI) call strict secret helpers that throw
  // on unresolved wrappers, and the discovery path doesn't need the resolved
  // value: the response's apiKey is restored from source so the UI keeps the
  // SecretRef shape, and redaction strips the value when includeSecrets=false.
  const providerInputConfig = stripUnresolvedSecretApiKey(
    Object.keys(runtimeProviderConfig).length > 0 ? runtimeProviderConfig : sourceProviderConfig,
  );
  const resolvedConfig =
    speechProvider?.resolveTalkConfig?.({
      cfg: params.runtimeConfig,
      baseTtsConfig: selectedBaseTts,
      talkProviderConfig: providerInputConfig,
      timeoutMs: typeof selectedBaseTts.timeoutMs === "number" ? selectedBaseTts.timeoutMs : 30_000,
    }) ?? providerInputConfig;
  const responseConfig =
    sourceProviderConfig.apiKey === undefined
      ? resolvedConfig
      : { ...resolvedConfig, apiKey: sourceProviderConfig.apiKey };

  return {
    ...payload,
    provider,
    resolved: {
      provider,
      config: responseConfig,
    },
  };
}

function stripUnresolvedSecretApiKey(config: TalkProviderConfig): TalkProviderConfig {
  return stripUnresolvedSecretApiKeyFromRecord(config) as TalkProviderConfig;
}

function stripUnresolvedSecretApiKeysFromBaseTtsProviders(
  base: Record<string, unknown>,
): Record<string, unknown> {
  const providers = asRecord(base.providers);
  if (!providers) {
    return base;
  }
  let mutated = false;
  // Null-prototype map so an attacker-influenced provider id like `__proto__`,
  // `constructor`, or `prototype` cannot pollute Object.prototype via the
  // dynamic `cleaned[providerId] = ...` assignment below. Provider-id keys
  // come from operator config and may be plain JSON, so we cannot assume
  // they're already validated upstream.
  const cleaned: Record<string, unknown> = Object.create(null);
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    const cfg = asRecord(providerConfig);
    if (!cfg) {
      cleaned[providerId] = providerConfig;
      continue;
    }
    const next = stripUnresolvedSecretApiKeyFromRecord(cfg);
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

function stripUnresolvedSecretApiKeyFromRecord(
  config: Record<string, unknown>,
): Record<string, unknown> {
  if (config.apiKey === undefined || typeof config.apiKey === "string") {
    return config;
  }
  const { apiKey: _omit, ...rest } = config;
  return rest;
}

async function startRealtimeToolCallAgentConsult(params: {
  sessionKey: string;
  callId: string;
  args: unknown;
  relaySessionId?: string;
  connId?: string;
  request: Parameters<GatewayRequestHandlers[string]>[0];
}): Promise<
  { ok: true; runId: string; idempotencyKey: string } | { ok: false; error: ErrorShape }
> {
  let message: string;
  try {
    message = buildRealtimeVoiceAgentConsultChatMessage(params.args);
  } catch (err) {
    return { ok: false, error: errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)) };
  }
  const idempotencyKey = `talk-${params.callId}-${randomUUID()}`;
  let chatResponse: { ok: true; result: unknown } | { ok: false; error: ErrorShape } | undefined;
  await chatHandlers["chat.send"]({
    ...params.request,
    req: {
      type: "req",
      id: `${params.request.req.id}:talk-tool-call`,
      method: "chat.send",
    },
    params: {
      sessionKey: params.sessionKey,
      message,
      idempotencyKey,
    },
    respond: (ok: boolean, result?: unknown, error?: ErrorShape) => {
      chatResponse = ok
        ? { ok: true, result }
        : {
            ok: false,
            error: error ?? errorShape(ErrorCodes.UNAVAILABLE, "chat.send failed without error"),
          };
    },
  } as never);

  if (!chatResponse) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "chat.send did not return a realtime tool result"),
    };
  }
  if (!chatResponse.ok) {
    return { ok: false, error: chatResponse.error };
  }
  const runId = normalizeOptionalString(asRecord(chatResponse.result)?.runId) ?? idempotencyKey;
  if (params.relaySessionId && params.connId) {
    registerTalkRealtimeRelayAgentRun({
      relaySessionId: params.relaySessionId,
      connId: params.connId,
      sessionKey: params.sessionKey,
      runId,
    });
  }
  return { ok: true, runId, idempotencyKey };
}

export const talkHandlers: GatewayRequestHandlers = {
  ...talkSessionHandlers,
  "talk.catalog": async ({ params, respond, context }) => {
    const catalogParams = params ?? {};
    if (!validateTalkCatalogParams(catalogParams)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.catalog params: ${formatValidationErrors(validateTalkCatalogParams.errors)}`,
        ),
      );
      return;
    }

    try {
      respond(true, buildTalkCatalog(context.getRuntimeConfig()), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.config": async ({ params, respond, client, context }) => {
    if (!validateTalkConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
        ),
      );
      return;
    }

    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    if (includeSecrets && !canReadTalkSecrets(client)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${TALK_SECRETS_SCOPE}`),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const runtimeConfig = context.getRuntimeConfig();
    const configPayload: Record<string, unknown> = {};

    const talk = resolveTalkResponseFromConfig({
      includeSecrets,
      sourceConfig: snapshot.config,
      runtimeConfig,
    });
    if (talk) {
      configPayload.talk = includeSecrets ? talk : redactConfigObject(talk);
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
  "talk.handoff.create": async ({ params, respond, client, context }) => {
    if (!validateTalkHandoffCreateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.handoff.create params: ${formatValidationErrors(validateTalkHandoffCreateParams.errors)}`,
        ),
      );
      return;
    }
    if (params.brain === "direct-tools" && !canUseTalkDirectTools(client)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `talk.handoff.create brain="direct-tools" requires gateway scope: ${ADMIN_SCOPE}`,
        ),
      );
      return;
    }
    const resolvedSession = await resolveSessionKeyFromResolveParams({
      cfg: context.getRuntimeConfig(),
      p: {
        key: params.sessionKey,
        includeGlobal: true,
        includeUnknown: true,
      },
    });
    if (!resolvedSession.ok) {
      respond(false, undefined, resolvedSession.error);
      return;
    }
    respond(true, createTalkHandoff({ ...params, sessionKey: resolvedSession.key }), undefined);
  },
  "talk.handoff.join": async ({ params, respond, client, context }) => {
    if (!validateTalkHandoffJoinParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.handoff.join params: ${formatValidationErrors(validateTalkHandoffJoinParams.errors)}`,
        ),
      );
      return;
    }
    const result = joinTalkHandoff(params.id, params.token, { clientId: client?.connId });
    if (!result.ok) {
      respond(
        false,
        undefined,
        errorShape(
          result.reason === "invalid_token" ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
          `talk handoff join failed: ${result.reason}`,
        ),
      );
      return;
    }
    broadcastTalkRoomEvents(context, result.replacedClientId, {
      handoffId: result.record.id,
      roomId: result.record.roomId,
      events: result.replacementEvents,
    });
    broadcastTalkRoomEvents(context, client?.connId, {
      handoffId: result.record.id,
      roomId: result.record.roomId,
      events: result.activeClientEvents,
    });
    respond(true, result.record, undefined);
  },
  "talk.handoff.revoke": async ({ params, respond, context }) => {
    if (!validateTalkHandoffRevokeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.handoff.revoke params: ${formatValidationErrors(validateTalkHandoffRevokeParams.errors)}`,
        ),
      );
      return;
    }
    const result = revokeTalkHandoff(params.id);
    broadcastTalkRoomEvents(context, result.activeClientId, {
      handoffId: params.id,
      roomId: result.roomId ?? "",
      events: result.events,
    });
    respond(true, { ok: true, revoked: result.revoked }, undefined);
  },
  "talk.handoff.turnStart": async ({ params, respond, client, context }) => {
    if (!validateTalkHandoffTurnStartParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.handoff.turnStart params: ${formatValidationErrors(validateTalkHandoffTurnStartParams.errors)}`,
        ),
      );
      return;
    }
    const result = startTalkHandoffTurn(params.id, params.token, {
      turnId: params.turnId,
      clientId: client?.connId,
    });
    if (!result.ok) {
      respond(
        false,
        undefined,
        errorShape(
          talkHandoffErrorCode(result.reason),
          `talk handoff turn start failed: ${result.reason}`,
        ),
      );
      return;
    }
    broadcastTalkRoomEvents(context, result.record.room.activeClientId, {
      handoffId: result.record.id,
      roomId: result.record.roomId,
      events: result.events,
    });
    respond(true, result, undefined);
  },
  "talk.handoff.turnEnd": async ({ params, respond, context }) => {
    if (!validateTalkHandoffTurnEndParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.handoff.turnEnd params: ${formatValidationErrors(validateTalkHandoffTurnEndParams.errors)}`,
        ),
      );
      return;
    }
    const result = endTalkHandoffTurn(params.id, params.token, {
      turnId: params.turnId,
    });
    if (!result.ok) {
      respond(
        false,
        undefined,
        errorShape(
          talkHandoffErrorCode(result.reason),
          `talk handoff turn end failed: ${result.reason}`,
        ),
      );
      return;
    }
    broadcastTalkRoomEvents(context, result.record.room.activeClientId, {
      handoffId: result.record.id,
      roomId: result.record.roomId,
      events: result.events,
    });
    respond(true, result, undefined);
  },
  "talk.handoff.turnCancel": async ({ params, respond, context }) => {
    if (!validateTalkHandoffTurnCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.handoff.turnCancel params: ${formatValidationErrors(validateTalkHandoffTurnCancelParams.errors)}`,
        ),
      );
      return;
    }
    const result = cancelTalkHandoffTurn(params.id, params.token, {
      turnId: params.turnId,
      reason: params.reason,
    });
    if (!result.ok) {
      respond(
        false,
        undefined,
        errorShape(
          talkHandoffErrorCode(result.reason),
          `talk handoff turn cancel failed: ${result.reason}`,
        ),
      );
      return;
    }
    broadcastTalkRoomEvents(context, result.record.room.activeClientId, {
      handoffId: result.record.id,
      roomId: result.record.roomId,
      events: result.events,
    });
    respond(true, result, undefined);
  },
  "talk.realtime.session": async ({ params, respond, context, client }) => {
    if (!validateTalkRealtimeSessionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.session params: ${formatValidationErrors(validateTalkRealtimeSessionParams.errors)}`,
        ),
      );
      return;
    }
    const typedParams = params as {
      provider?: string;
      model?: string;
      voice?: string;
      mode?: string;
      transport?: string;
      brain?: string;
    };
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const realtimeConfig = buildTalkRealtimeConfig(runtimeConfig, typedParams.provider);
      const mode =
        normalizeOptionalLowercaseString(typedParams.mode) ?? realtimeConfig.mode ?? "realtime";
      if (mode !== "realtime") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.realtime.session only supports mode="realtime"; use talk.catalog for ${mode} provider discovery`,
          ),
        );
        return;
      }
      const brain =
        normalizeOptionalLowercaseString(typedParams.brain) ??
        realtimeConfig.brain ??
        "agent-consult";
      if (brain !== "agent-consult") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `talk.realtime.session only supports brain="agent-consult"`,
          ),
        );
        return;
      }
      const transport =
        normalizeOptionalLowercaseString(typedParams.transport) ?? realtimeConfig.transport;
      if (transport === "managed-room") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "managed-room realtime Talk sessions are not available in the browser UI yet",
          ),
        );
        return;
      }
      const resolution = resolveConfiguredRealtimeVoiceProvider({
        configuredProviderId: realtimeConfig.provider,
        providerConfigs: realtimeConfig.providers,
        cfg: runtimeConfig,
        cfgForResolve: runtimeConfig,
        noRegisteredProviderMessage: "No realtime voice provider registered",
      });
      if (resolution.provider.createBrowserSession && transport !== "gateway-relay") {
        const session = await resolution.provider.createBrowserSession({
          providerConfig: resolution.providerConfig,
          instructions: buildRealtimeInstructions(),
          tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
          model: normalizeOptionalString(typedParams.model) ?? realtimeConfig.model,
          voice: normalizeOptionalString(typedParams.voice) ?? realtimeConfig.voice,
        });
        if (
          !isUnsupportedBrowserWebRtcSession(session) &&
          (!transport || session.transport === transport)
        ) {
          respond(true, session, undefined);
          return;
        }
        if (transport) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `Realtime provider "${resolution.provider.id}" does not support requested browser transport "${transport}"`,
            ),
          );
          return;
        }
      }

      const connId = client?.connId;
      if (!connId) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "Realtime relay requires a connected browser client"),
        );
        return;
      }
      const model = normalizeOptionalString(typedParams.model) ?? realtimeConfig.model;
      const voice = normalizeOptionalString(typedParams.voice) ?? realtimeConfig.voice;
      const session = createTalkRealtimeRelaySession({
        context,
        connId,
        provider: resolution.provider,
        providerConfig: withRealtimeBrowserOverrides(resolution.providerConfig, { model, voice }),
        instructions: buildRealtimeInstructions(),
        tools: [REALTIME_VOICE_AGENT_CONSULT_TOOL],
        model,
        voice,
      });
      respond(true, session, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.toolCall": async (request) => {
    const { params, respond } = request;
    if (!validateTalkRealtimeToolCallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.toolCall params: ${formatValidationErrors(validateTalkRealtimeToolCallParams.errors)}`,
        ),
      );
      return;
    }
    if (params.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unsupported realtime Talk tool: ${params.name}`),
      );
      return;
    }

    const result = await startRealtimeToolCallAgentConsult({
      sessionKey: params.sessionKey,
      callId: params.callId,
      args: params.args ?? {},
      relaySessionId: normalizeOptionalString(params.relaySessionId),
      connId: normalizeOptionalString(request.client?.connId),
      request,
    });
    if (!result.ok) {
      respond(false, undefined, result.error);
      return;
    }
    respond(
      true,
      {
        runId: result.runId,
        idempotencyKey: result.idempotencyKey,
      },
      undefined,
    );
  },
  "talk.realtime.relayAudio": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayAudioParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayAudio params: ${formatValidationErrors(validateTalkRealtimeRelayAudioParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      sendTalkRealtimeRelayAudio({
        relaySessionId: params.relaySessionId,
        connId,
        audioBase64: params.audioBase64,
        timestamp: params.timestamp,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayMark": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayMarkParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayMark params: ${formatValidationErrors(validateTalkRealtimeRelayMarkParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      acknowledgeTalkRealtimeRelayMark({ relaySessionId: params.relaySessionId, connId });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayCancel": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayCancel params: ${formatValidationErrors(validateTalkRealtimeRelayCancelParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      cancelTalkRealtimeRelayTurn({
        relaySessionId: params.relaySessionId,
        connId,
        reason: normalizeOptionalString(params.reason),
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayStop": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayStopParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayStop params: ${formatValidationErrors(validateTalkRealtimeRelayStopParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      stopTalkRealtimeRelaySession({ relaySessionId: params.relaySessionId, connId });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.realtime.relayToolResult": async ({ params, respond, client }) => {
    if (!validateTalkRealtimeRelayToolResultParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.realtime.relayToolResult params: ${formatValidationErrors(validateTalkRealtimeRelayToolResultParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "realtime relay unavailable"));
      return;
    }
    try {
      submitTalkRealtimeRelayToolResult({
        relaySessionId: params.relaySessionId,
        connId,
        callId: params.callId,
        result: params.result,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.transcription.session": async ({ params, respond, context, client }) => {
    if (!validateTalkTranscriptionSessionParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.transcription.session params: ${formatValidationErrors(validateTalkTranscriptionSessionParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "transcription relay requires a connected client"),
      );
      return;
    }
    try {
      const runtimeConfig = context.getRuntimeConfig();
      const transcriptionConfig = buildTalkTranscriptionConfig(runtimeConfig, params.provider);
      const resolution = resolveConfiguredRealtimeTranscriptionProvider({
        config: runtimeConfig,
        configuredProviderId: transcriptionConfig.provider,
        providerConfigs: transcriptionConfig.providers,
      });
      const session = createTalkTranscriptionRelaySession({
        context,
        connId,
        provider: resolution.provider,
        providerConfig: resolution.providerConfig,
      });
      respond(true, session, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.transcription.relayAudio": async ({ params, respond, client }) => {
    if (!validateTalkTranscriptionRelayAudioParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.transcription.relayAudio params: ${formatValidationErrors(validateTalkTranscriptionRelayAudioParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "transcription relay unavailable"),
      );
      return;
    }
    try {
      sendTalkTranscriptionRelayAudio({
        transcriptionSessionId: params.transcriptionSessionId,
        connId,
        audioBase64: params.audioBase64,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.transcription.relayCancel": async ({ params, respond, client }) => {
    if (!validateTalkTranscriptionRelayCancelParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.transcription.relayCancel params: ${formatValidationErrors(validateTalkTranscriptionRelayCancelParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "transcription relay unavailable"),
      );
      return;
    }
    try {
      cancelTalkTranscriptionRelayTurn({
        transcriptionSessionId: params.transcriptionSessionId,
        connId,
        reason: normalizeOptionalString(params.reason),
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.transcription.relayStop": async ({ params, respond, client }) => {
    if (!validateTalkTranscriptionRelayStopParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.transcription.relayStop params: ${formatValidationErrors(validateTalkTranscriptionRelayStopParams.errors)}`,
        ),
      );
      return;
    }
    const connId = client?.connId;
    if (!connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "transcription relay unavailable"),
      );
      return;
    }
    try {
      stopTalkTranscriptionRelaySession({
        transcriptionSessionId: params.transcriptionSessionId,
        connId,
      });
      respond(true, { ok: true }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.speak": async ({ params, respond, context }) => {
    if (!validateTalkSpeakParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.speak params: ${formatValidationErrors(validateTalkSpeakParams.errors)}`,
        ),
      );
      return;
    }

    const typedParams = params;
    const text = normalizeOptionalString(typedParams.text);
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak requires text"));
      return;
    }

    if (
      typedParams.speed == null &&
      typedParams.rateWpm != null &&
      resolveTalkSpeed(typedParams) == null
    ) {
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

      const overrides = buildTalkSpeakOverrides(
        setup.provider,
        setup.providerConfig,
        runtimeConfig,
        typedParams,
      );
      const result = await synthesizeSpeech({
        text,
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
      if ((result.provider ?? setup.provider).trim().length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty provider"),
        );
        return;
      }
      if (result.audioBuffer.length === 0) {
        respond(
          false,
          undefined,
          talkSpeakError("invalid_audio_result", "talk synthesis returned empty audio"),
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
          mimeType: inferMimeType(result.outputFormat, result.fileExtension),
          fileExtension: result.fileExtension,
        },
        undefined,
      );
    } catch (err) {
      respond(false, undefined, talkSpeakError("synthesis_failed", formatForLog(err)));
    }
  },
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedTalkNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected Talk-capable nodes"),
      );
      return;
    }
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
