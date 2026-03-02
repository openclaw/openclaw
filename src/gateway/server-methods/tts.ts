import { loadConfig } from "../../config/config.js";
import {
  OPENAI_TTS_MODELS,
  OPENAI_TTS_RESPONSE_FORMATS,
  OPENAI_TTS_STREAM_FORMATS,
  OPENAI_TTS_VOICES,
  type TtsDirectiveOverrides,
  getTtsProvider,
  isTtsEnabled,
  isTtsProviderConfigured,
  resolveTtsAutoMode,
  resolveTtsApiKey,
  resolveTtsConfig,
  resolveTtsPrefsPath,
  resolveTtsProviderOrder,
  setTtsEnabled,
  setTtsProvider,
  textToSpeech,
} from "../../tts/tts.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const ttsHandlers: GatewayRequestHandlers = {
  "tts.status": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      const provider = getTtsProvider(config, prefsPath);
      const autoMode = resolveTtsAutoMode({ config, prefsPath });
      const fallbackProviders = resolveTtsProviderOrder(provider)
        .slice(1)
        .filter((candidate) => isTtsProviderConfigured(config, candidate));
      respond(true, {
        enabled: isTtsEnabled(config, prefsPath),
        auto: autoMode,
        provider,
        fallbackProvider: fallbackProviders[0] ?? null,
        fallbackProviders,
        prefsPath,
        hasOpenAIKey: Boolean(resolveTtsApiKey(config, "openai")),
        hasElevenLabsKey: Boolean(resolveTtsApiKey(config, "elevenlabs")),
        edgeEnabled: isTtsProviderConfigured(config, "edge"),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.enable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, true);
      respond(true, { enabled: true });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.disable": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsEnabled(prefsPath, false);
      respond(true, { enabled: false });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.convert": async ({ params, respond }) => {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "tts.convert requires text"),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const channel =
        typeof params.channel === "string" ? params.channel.trim() || undefined : undefined;
      const instructions =
        typeof params.instructions === "string"
          ? params.instructions.trim() || undefined
          : undefined;
      const stream = typeof params.stream === "boolean" ? params.stream : undefined;
      const responseFormatRaw =
        typeof params.responseFormat === "string"
          ? params.responseFormat.trim().toLowerCase()
          : undefined;
      if (
        responseFormatRaw != null &&
        !OPENAI_TTS_RESPONSE_FORMATS.includes(
          responseFormatRaw as (typeof OPENAI_TTS_RESPONSE_FORMATS)[number],
        )
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Invalid responseFormat. Use one of: ${OPENAI_TTS_RESPONSE_FORMATS.join(", ")}.`,
          ),
        );
        return;
      }
      const responseFormat = responseFormatRaw as
        | (typeof OPENAI_TTS_RESPONSE_FORMATS)[number]
        | undefined;
      const streamFormatRaw =
        typeof params.streamFormat === "string"
          ? params.streamFormat.trim().toLowerCase()
          : undefined;
      if (
        streamFormatRaw != null &&
        !OPENAI_TTS_STREAM_FORMATS.includes(
          streamFormatRaw as (typeof OPENAI_TTS_STREAM_FORMATS)[number],
        )
      ) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Invalid streamFormat. Use one of: ${OPENAI_TTS_STREAM_FORMATS.join(", ")}.`,
          ),
        );
        return;
      }
      const streamFormat = streamFormatRaw as
        | (typeof OPENAI_TTS_STREAM_FORMATS)[number]
        | undefined;
      const speedRaw =
        typeof params.speed === "number"
          ? params.speed
          : typeof params.speed === "string"
            ? Number.parseFloat(params.speed)
            : undefined;
      if (speedRaw != null && (!Number.isFinite(speedRaw) || speedRaw < 0.25 || speedRaw > 4)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "Invalid speed. Use a number between 0.25 and 4.0.",
          ),
        );
        return;
      }
      const overrides: TtsDirectiveOverrides | undefined =
        instructions != null ||
        stream !== undefined ||
        responseFormat != null ||
        streamFormat != null ||
        speedRaw != null
          ? {
              openai: {
                ...(instructions != null ? { instructions } : {}),
                ...(stream !== undefined ? { stream } : {}),
                ...(responseFormat != null ? { responseFormat } : {}),
                ...(streamFormat != null ? { streamFormat } : {}),
                ...(speedRaw != null ? { speed: speedRaw } : {}),
              },
            }
          : undefined;
      const result = await textToSpeech({ text, cfg, channel, overrides });
      if (result.success && result.audioPath) {
        respond(true, {
          audioPath: result.audioPath,
          provider: result.provider,
          outputFormat: result.outputFormat,
          voiceCompatible: result.voiceCompatible,
        });
        return;
      }
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, result.error ?? "TTS conversion failed"),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.setProvider": async ({ params, respond }) => {
    const provider = typeof params.provider === "string" ? params.provider.trim() : "";
    if (provider !== "openai" && provider !== "elevenlabs" && provider !== "edge") {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Invalid provider. Use openai, elevenlabs, or edge.",
        ),
      );
      return;
    }
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      setTtsProvider(prefsPath, provider);
      respond(true, { provider });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
  "tts.providers": async ({ respond }) => {
    try {
      const cfg = loadConfig();
      const config = resolveTtsConfig(cfg);
      const prefsPath = resolveTtsPrefsPath(config);
      respond(true, {
        providers: [
          {
            id: "openai",
            name: "OpenAI",
            configured: Boolean(resolveTtsApiKey(config, "openai")),
            models: [...OPENAI_TTS_MODELS],
            voices: [...OPENAI_TTS_VOICES],
          },
          {
            id: "elevenlabs",
            name: "ElevenLabs",
            configured: Boolean(resolveTtsApiKey(config, "elevenlabs")),
            models: ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_monolingual_v1"],
          },
          {
            id: "edge",
            name: "Edge TTS",
            configured: isTtsProviderConfigured(config, "edge"),
            models: [],
          },
        ],
        active: getTtsProvider(config, prefsPath),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
