import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TtsProvider } from "../config/types.tts.js";
import { logVerbose } from "../globals.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { isVoiceCompatibleAudio } from "../media/audio.js";
import {
  edgeTTS,
  elevenLabsTTS,
  inferEdgeExtension,
  openaiTTS,
  scheduleCleanup,
} from "../tts/tts-core.js";
import type { TtsDirectiveOverrides, TtsResult, TtsTelephonyResult } from "../tts/tts.js";
import type { ResolvedTtsConfig } from "./tts-config.js";
import {
  resolveExtensionHostTtsApiKey,
  supportsExtensionHostTtsTelephony,
} from "./tts-runtime-registry.js";

const TELEGRAM_OUTPUT = {
  openai: "opus" as const,
  // ElevenLabs output formats use codec_sample_rate_bitrate naming.
  // Opus @ 48kHz/64kbps is a good voice-note tradeoff for Telegram.
  elevenlabs: "opus_48000_64",
  extension: ".opus",
  voiceCompatible: true,
};

const DEFAULT_OUTPUT = {
  openai: "mp3" as const,
  elevenlabs: "mp3_44100_128",
  extension: ".mp3",
  voiceCompatible: false,
};

const TELEPHONY_OUTPUT = {
  openai: { format: "pcm" as const, sampleRate: 24000 },
  elevenlabs: { format: "pcm_22050", sampleRate: 22050 },
};

const DEFAULT_EDGE_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";

const VOICE_BUBBLE_CHANNELS = new Set(["telegram", "feishu", "whatsapp"]);

type ExtensionHostTtsOutputFormat = {
  openai: "opus" | "mp3";
  elevenlabs: string;
  extension: ".opus" | ".mp3";
  voiceCompatible: boolean;
};

export function isExtensionHostTtsVoiceBubbleChannel(channel?: string | null): boolean {
  const channelId = channel?.trim().toLowerCase();
  return typeof channelId === "string" && VOICE_BUBBLE_CHANNELS.has(channelId);
}

export function resolveExtensionHostTtsOutputFormat(
  channel?: string | null,
): ExtensionHostTtsOutputFormat {
  if (isExtensionHostTtsVoiceBubbleChannel(channel)) {
    return TELEGRAM_OUTPUT;
  }
  return DEFAULT_OUTPUT;
}

export function resolveExtensionHostEdgeOutputFormat(config: ResolvedTtsConfig): string {
  return config.edge.outputFormat || DEFAULT_EDGE_OUTPUT_FORMAT;
}

export function formatExtensionHostTtsProviderError(provider: TtsProvider, err: unknown): string {
  const error = err instanceof Error ? err : new Error(String(err));
  if (error.name === "AbortError") {
    return `${provider}: request timed out`;
  }
  return `${provider}: ${error.message}`;
}

export function buildExtensionHostTtsFailureResult(errors: string[]): {
  success: false;
  error: string;
} {
  return {
    success: false,
    error: `TTS conversion failed: ${errors.join("; ") || "no providers available"}`,
  };
}

export async function executeExtensionHostTextToSpeech(params: {
  text: string;
  config: ResolvedTtsConfig;
  providers: TtsProvider[];
  channel?: string;
  overrides?: TtsDirectiveOverrides;
}): Promise<TtsResult> {
  const { config, providers } = params;
  const output = resolveExtensionHostTtsOutputFormat(params.channel);
  const errors: string[] = [];

  for (const provider of providers) {
    const providerStart = Date.now();
    try {
      if (provider === "edge") {
        if (!config.edge.enabled) {
          errors.push("edge: disabled");
          continue;
        }

        const tempRoot = resolvePreferredOpenClawTmpDir();
        mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
        const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
        let edgeOutputFormat = resolveExtensionHostEdgeOutputFormat(config);
        const fallbackEdgeOutputFormat =
          edgeOutputFormat !== DEFAULT_EDGE_OUTPUT_FORMAT ? DEFAULT_EDGE_OUTPUT_FORMAT : undefined;

        const attemptEdgeTts = async (outputFormat: string) => {
          const extension = inferEdgeExtension(outputFormat);
          const audioPath = path.join(tempDir, `voice-${Date.now()}${extension}`);
          await edgeTTS({
            text: params.text,
            outputPath: audioPath,
            config: {
              ...config.edge,
              outputFormat,
            },
            timeoutMs: config.timeoutMs,
          });
          return { audioPath, outputFormat };
        };

        let edgeResult: { audioPath: string; outputFormat: string };
        try {
          edgeResult = await attemptEdgeTts(edgeOutputFormat);
        } catch (err) {
          if (fallbackEdgeOutputFormat && fallbackEdgeOutputFormat !== edgeOutputFormat) {
            logVerbose(
              `TTS: Edge output ${edgeOutputFormat} failed; retrying with ${fallbackEdgeOutputFormat}.`,
            );
            edgeOutputFormat = fallbackEdgeOutputFormat;
            try {
              edgeResult = await attemptEdgeTts(edgeOutputFormat);
            } catch (fallbackErr) {
              try {
                rmSync(tempDir, { recursive: true, force: true });
              } catch {}
              throw fallbackErr;
            }
          } else {
            try {
              rmSync(tempDir, { recursive: true, force: true });
            } catch {}
            throw err;
          }
        }

        scheduleCleanup(tempDir);
        const voiceCompatible = isVoiceCompatibleAudio({ fileName: edgeResult.audioPath });

        return {
          success: true,
          audioPath: edgeResult.audioPath,
          latencyMs: Date.now() - providerStart,
          provider,
          outputFormat: edgeResult.outputFormat,
          voiceCompatible,
        };
      }

      const apiKey = resolveExtensionHostTtsApiKey(config, provider);
      if (!apiKey) {
        errors.push(`${provider}: no API key`);
        continue;
      }

      let audioBuffer: Buffer;
      if (provider === "elevenlabs") {
        const voiceIdOverride = params.overrides?.elevenlabs?.voiceId;
        const modelIdOverride = params.overrides?.elevenlabs?.modelId;
        const voiceSettings = {
          ...config.elevenlabs.voiceSettings,
          ...params.overrides?.elevenlabs?.voiceSettings,
        };
        const seedOverride = params.overrides?.elevenlabs?.seed;
        const normalizationOverride = params.overrides?.elevenlabs?.applyTextNormalization;
        const languageOverride = params.overrides?.elevenlabs?.languageCode;
        audioBuffer = await elevenLabsTTS({
          text: params.text,
          apiKey,
          baseUrl: config.elevenlabs.baseUrl,
          voiceId: voiceIdOverride ?? config.elevenlabs.voiceId,
          modelId: modelIdOverride ?? config.elevenlabs.modelId,
          outputFormat: output.elevenlabs,
          seed: seedOverride ?? config.elevenlabs.seed,
          applyTextNormalization: normalizationOverride ?? config.elevenlabs.applyTextNormalization,
          languageCode: languageOverride ?? config.elevenlabs.languageCode,
          voiceSettings,
          timeoutMs: config.timeoutMs,
        });
      } else {
        const openaiModelOverride = params.overrides?.openai?.model;
        const openaiVoiceOverride = params.overrides?.openai?.voice;
        audioBuffer = await openaiTTS({
          text: params.text,
          apiKey,
          baseUrl: config.openai.baseUrl,
          model: openaiModelOverride ?? config.openai.model,
          voice: openaiVoiceOverride ?? config.openai.voice,
          speed: config.openai.speed,
          instructions: config.openai.instructions,
          responseFormat: output.openai,
          timeoutMs: config.timeoutMs,
        });
      }

      const tempRoot = resolvePreferredOpenClawTmpDir();
      mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
      const tempDir = mkdtempSync(path.join(tempRoot, "tts-"));
      const audioPath = path.join(tempDir, `voice-${Date.now()}${output.extension}`);
      writeFileSync(audioPath, audioBuffer);
      scheduleCleanup(tempDir);

      return {
        success: true,
        audioPath,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat: provider === "openai" ? output.openai : output.elevenlabs,
        voiceCompatible: output.voiceCompatible,
      };
    } catch (err) {
      errors.push(formatExtensionHostTtsProviderError(provider, err));
    }
  }

  return buildExtensionHostTtsFailureResult(errors);
}

export async function executeExtensionHostTextToSpeechTelephony(params: {
  text: string;
  config: ResolvedTtsConfig;
  providers: TtsProvider[];
}): Promise<TtsTelephonyResult> {
  const { config, providers } = params;
  const errors: string[] = [];

  for (const provider of providers) {
    const providerStart = Date.now();
    try {
      if (!supportsExtensionHostTtsTelephony(provider)) {
        errors.push("edge: unsupported for telephony");
        continue;
      }

      const apiKey = resolveExtensionHostTtsApiKey(config, provider);
      if (!apiKey) {
        errors.push(`${provider}: no API key`);
        continue;
      }

      if (provider === "elevenlabs") {
        const output = TELEPHONY_OUTPUT.elevenlabs;
        const audioBuffer = await elevenLabsTTS({
          text: params.text,
          apiKey,
          baseUrl: config.elevenlabs.baseUrl,
          voiceId: config.elevenlabs.voiceId,
          modelId: config.elevenlabs.modelId,
          outputFormat: output.format,
          seed: config.elevenlabs.seed,
          applyTextNormalization: config.elevenlabs.applyTextNormalization,
          languageCode: config.elevenlabs.languageCode,
          voiceSettings: config.elevenlabs.voiceSettings,
          timeoutMs: config.timeoutMs,
        });

        return {
          success: true,
          audioBuffer,
          latencyMs: Date.now() - providerStart,
          provider,
          outputFormat: output.format,
          sampleRate: output.sampleRate,
        };
      }

      const output = TELEPHONY_OUTPUT.openai;
      const audioBuffer = await openaiTTS({
        text: params.text,
        apiKey,
        baseUrl: config.openai.baseUrl,
        model: config.openai.model,
        voice: config.openai.voice,
        speed: config.openai.speed,
        instructions: config.openai.instructions,
        responseFormat: output.format,
        timeoutMs: config.timeoutMs,
      });

      return {
        success: true,
        audioBuffer,
        latencyMs: Date.now() - providerStart,
        provider,
        outputFormat: output.format,
        sampleRate: output.sampleRate,
      };
    } catch (err) {
      errors.push(formatExtensionHostTtsProviderError(provider, err));
    }
  }

  return buildExtensionHostTtsFailureResult(errors);
}
