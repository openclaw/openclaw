import { loadConfig } from "../../config/config.js";
import {
  OPENAI_TTS_MODELS,
  OPENAI_TTS_VOICES,
  getTtsProvider,
  isTtsEnabled,
  resolveTtsApiKey,
  resolveTtsConfig,
  resolveTtsPrefsPath,
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
      respond(true, {
        enabled: isTtsEnabled(config, prefsPath),
        provider,
        fallbackProvider: provider === "openai" ? "elevenlabs" : "openai",
        prefsPath,
        hasOpenAIKey: Boolean(resolveTtsApiKey(config, "openai")),
        hasElevenLabsKey: Boolean(resolveTtsApiKey(config, "elevenlabs")),
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
      const channel = typeof params.channel === "string" ? params.channel.trim() : undefined;
      const result = await textToSpeech({ text, cfg, channel });
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
    if (provider !== "openai" && provider !== "elevenlabs") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid provider. Use openai or elevenlabs."),
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
        ],
        active: getTtsProvider(config, prefsPath),
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
