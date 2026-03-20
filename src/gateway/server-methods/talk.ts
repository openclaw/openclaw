import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import { buildTalkConfigResponse, resolveActiveTalkProviderConfig } from "../../config/talk.js";
import type { TalkProviderConfig } from "../../config/types.gateway.js";
import type { OpenClawConfig, TtsConfig } from "../../config/types.js";
import { normalizeSpeechProviderId } from "../../tts/provider-registry.js";
import { synthesizeSpeech, type TtsDirectiveOverrides } from "../../tts/tts.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkConfigParams,
  validateTalkModeParams,
  validateTalkSpeakParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

const ADMIN_SCOPE = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";
type ElevenLabsVoiceSettings = NonNullable<NonNullable<TtsConfig["elevenlabs"]>["voiceSettings"]>;

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeTextNormalization(value: unknown): "auto" | "on" | "off" | undefined {
  const normalized = trimString(value)?.toLowerCase();
  return normalized === "auto" || normalized === "on" || normalized === "off"
    ? normalized
    : undefined;
}

function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase();
}

function resolveTalkVoiceId(
  providerConfig: TalkProviderConfig,
  requested: string | undefined,
): string | undefined {
  if (!requested) {
    return undefined;
  }
  const aliases = providerConfig.voiceAliases;
  if (!aliases) {
    return requested;
  }
  return aliases[normalizeAliasKey(requested)] ?? requested;
}

function readTalkVoiceSettings(
  providerConfig: TalkProviderConfig,
): ElevenLabsVoiceSettings | undefined {
  const source = plainObject(providerConfig.voiceSettings);
  if (!source) {
    return undefined;
  }
  const stability = finiteNumber(source.stability);
  const similarityBoost = finiteNumber(source.similarityBoost);
  const style = finiteNumber(source.style);
  const useSpeakerBoost = optionalBoolean(source.useSpeakerBoost);
  const speed = finiteNumber(source.speed);
  const voiceSettings = {
    ...(stability == null ? {} : { stability }),
    ...(similarityBoost == null ? {} : { similarityBoost }),
    ...(style == null ? {} : { style }),
    ...(useSpeakerBoost == null ? {} : { useSpeakerBoost }),
    ...(speed == null ? {} : { speed }),
  };
  return Object.keys(voiceSettings).length > 0 ? voiceSettings : undefined;
}

function buildTalkTtsConfig(
  config: OpenClawConfig,
):
  | { cfg: OpenClawConfig; provider: string; providerConfig: TalkProviderConfig }
  | { error: string } {
  const resolved = resolveActiveTalkProviderConfig(config.talk);
  const provider = normalizeSpeechProviderId(resolved?.provider);
  if (!resolved || !provider) {
    return { error: "talk.speak unavailable: talk provider not configured" };
  }

  const baseTts = config.messages?.tts ?? {};
  const providerConfig = resolved.config;
  const talkTts: TtsConfig = {
    ...baseTts,
    auto: "always",
    provider,
  };

  if (provider === "elevenlabs") {
    talkTts.elevenlabs = {
      ...baseTts.elevenlabs,
      ...(providerConfig.apiKey === undefined ? {} : { apiKey: providerConfig.apiKey }),
      ...(trimString(providerConfig.baseUrl) == null
        ? {}
        : { baseUrl: trimString(providerConfig.baseUrl) }),
      ...(trimString(providerConfig.voiceId) == null
        ? {}
        : { voiceId: trimString(providerConfig.voiceId) }),
      ...(trimString(providerConfig.modelId) == null
        ? {}
        : { modelId: trimString(providerConfig.modelId) }),
      ...(finiteNumber(providerConfig.seed) == null
        ? {}
        : { seed: finiteNumber(providerConfig.seed) }),
      ...(normalizeTextNormalization(providerConfig.applyTextNormalization) == null
        ? {}
        : {
            applyTextNormalization: normalizeTextNormalization(
              providerConfig.applyTextNormalization,
            ),
          }),
      ...(trimString(providerConfig.languageCode) == null
        ? {}
        : { languageCode: trimString(providerConfig.languageCode) }),
      ...(readTalkVoiceSettings(providerConfig) == null
        ? {}
        : { voiceSettings: readTalkVoiceSettings(providerConfig) }),
    };
  } else if (provider === "openai") {
    talkTts.openai = {
      ...baseTts.openai,
      ...(providerConfig.apiKey === undefined ? {} : { apiKey: providerConfig.apiKey }),
      ...(trimString(providerConfig.baseUrl) == null
        ? {}
        : { baseUrl: trimString(providerConfig.baseUrl) }),
      ...(trimString(providerConfig.modelId) == null
        ? {}
        : { model: trimString(providerConfig.modelId) }),
      ...(trimString(providerConfig.voiceId) == null
        ? {}
        : { voice: trimString(providerConfig.voiceId) }),
      ...(finiteNumber(providerConfig.speed) == null
        ? {}
        : { speed: finiteNumber(providerConfig.speed) }),
      ...(trimString(providerConfig.instructions) == null
        ? {}
        : { instructions: trimString(providerConfig.instructions) }),
    };
  } else if (provider === "microsoft") {
    talkTts.microsoft = {
      ...baseTts.microsoft,
      enabled: true,
      ...(trimString(providerConfig.voiceId) == null
        ? {}
        : { voice: trimString(providerConfig.voiceId) }),
      ...(trimString(providerConfig.languageCode) == null
        ? {}
        : { lang: trimString(providerConfig.languageCode) }),
      ...(trimString(providerConfig.outputFormat) == null
        ? {}
        : { outputFormat: trimString(providerConfig.outputFormat) }),
      ...(trimString(providerConfig.pitch) == null
        ? {}
        : { pitch: trimString(providerConfig.pitch) }),
      ...(trimString(providerConfig.rate) == null ? {} : { rate: trimString(providerConfig.rate) }),
      ...(trimString(providerConfig.volume) == null
        ? {}
        : { volume: trimString(providerConfig.volume) }),
      ...(trimString(providerConfig.proxy) == null
        ? {}
        : { proxy: trimString(providerConfig.proxy) }),
      ...(finiteNumber(providerConfig.timeoutMs) == null
        ? {}
        : { timeoutMs: finiteNumber(providerConfig.timeoutMs) }),
    };
  } else {
    return { error: `talk.speak unavailable: unsupported talk provider '${resolved.provider}'` };
  }

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

function buildTalkSpeakOverrides(
  provider: string,
  providerConfig: TalkProviderConfig,
  params: Record<string, unknown>,
): TtsDirectiveOverrides {
  const voiceId = resolveTalkVoiceId(providerConfig, trimString(params.voiceId));
  const modelId = trimString(params.modelId);
  const speed = finiteNumber(params.speed);
  const seed = finiteNumber(params.seed);
  const normalize = normalizeTextNormalization(params.normalize);
  const language = trimString(params.language)?.toLowerCase();
  const overrides: TtsDirectiveOverrides = { provider };

  if (provider === "elevenlabs") {
    const voiceSettings = {
      ...(speed == null ? {} : { speed }),
      ...(finiteNumber(params.stability) == null
        ? {}
        : { stability: finiteNumber(params.stability) }),
      ...(finiteNumber(params.similarity) == null
        ? {}
        : { similarityBoost: finiteNumber(params.similarity) }),
      ...(finiteNumber(params.style) == null ? {} : { style: finiteNumber(params.style) }),
      ...(optionalBoolean(params.speakerBoost) == null
        ? {}
        : { useSpeakerBoost: optionalBoolean(params.speakerBoost) }),
    };
    overrides.elevenlabs = {
      ...(voiceId == null ? {} : { voiceId }),
      ...(modelId == null ? {} : { modelId }),
      ...(seed == null ? {} : { seed }),
      ...(normalize == null ? {} : { applyTextNormalization: normalize }),
      ...(language == null ? {} : { languageCode: language }),
      ...(Object.keys(voiceSettings).length === 0 ? {} : { voiceSettings }),
    };
    return overrides;
  }

  if (provider === "openai") {
    overrides.openai = {
      ...(voiceId == null ? {} : { voice: voiceId }),
      ...(modelId == null ? {} : { model: modelId }),
      ...(speed == null ? {} : { speed }),
    };
    return overrides;
  }

  if (provider === "microsoft") {
    overrides.microsoft = voiceId == null ? undefined : { voice: voiceId };
  }

  return overrides;
}

function inferMimeType(
  outputFormat: string | undefined,
  fileExtension: string | undefined,
): string | undefined {
  const normalizedOutput = outputFormat?.trim().toLowerCase();
  const normalizedExtension = fileExtension?.trim().toLowerCase();
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

export const talkHandlers: GatewayRequestHandlers = {
  "talk.config": async ({ params, respond, client }) => {
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
    const configPayload: Record<string, unknown> = {};

    const talkSource = includeSecrets
      ? snapshot.config.talk
      : redactConfigObject(snapshot.config.talk);
    const talk = buildTalkConfigResponse(talkSource);
    if (talk) {
      configPayload.talk = talk;
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
  "talk.speak": async ({ params, respond }) => {
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

    const text = trimString((params as { text?: unknown }).text);
    if (!text) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "talk.speak requires text"));
      return;
    }

    try {
      const snapshot = await readConfigFileSnapshot();
      const setup = buildTalkTtsConfig(snapshot.config);
      if ("error" in setup) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, setup.error));
        return;
      }

      const overrides = buildTalkSpeakOverrides(setup.provider, setup.providerConfig, params);
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
          errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "talk synthesis failed"),
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
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedMobileNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected iOS/Android nodes"),
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
