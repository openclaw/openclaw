import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";
import type { OpenClawConfig } from "../config/types.js";
import { logVerbose } from "../globals.js";
import { transcodeAudioBuffer } from "../media/media-services.js";
import { assertSecretOwnerAvailable } from "../secrets/runtime-degraded-state.js";
import type { TtsDirectiveOverrides } from "./provider-types.js";
import { assertSpeechRuntimeAvailable } from "./runtime-availability.js";
import { normalizeSpeechText } from "./speech-text.js";
import type { TtsResult, TtsSynthesisResult } from "./tts-runtime-types.js";
import {
  executeTtsProviderAttempts,
  sanitizeTtsErrorForLog,
  withOwnedTtsRequest,
} from "./tts-synthesis-support.js";

export type TtsAudioPersistence = (params: {
  audioBuffer: Buffer;
  cfg: OpenClawConfig;
  fileExtension: string;
  outputFormat?: string;
}) => Promise<string>;

export function supportsNativeVoiceNoteTts(channel: string | undefined): boolean {
  return resolveChannelTtsVoiceDelivery(channel) !== undefined;
}

export function supportsTranscodedVoiceNoteTts(channel: string | undefined): boolean {
  const delivery = resolveChannelTtsVoiceDelivery(channel);
  return delivery?.synthesisTarget === "voice-note" && delivery.transcodesAudio === true;
}

export function resolveTtsSynthesisTarget(
  channel: string | undefined,
): "audio-file" | "voice-note" {
  return resolveChannelTtsVoiceDelivery(channel)?.synthesisTarget ?? "audio-file";
}

export function shouldDeliverTtsAsVoice(params: {
  channel: string | undefined;
  target: "audio-file" | "voice-note" | undefined;
  voiceCompatible: boolean | undefined;
  fileExtension?: string;
  outputFormat?: string;
}): boolean {
  const delivery = resolveChannelTtsVoiceDelivery(params.channel);
  if (!delivery) {
    return false;
  }
  if (delivery.synthesisTarget === "audio-file") {
    if (params.target !== "audio-file") {
      return false;
    }
    const { fileExtension, outputFormat } = params;
    const formats = new Set(
      delivery.audioFileFormats?.map((format) => format.trim().toLowerCase()),
    );
    if (formats.size === 0) {
      return false;
    }
    const extension = fileExtension?.trim().toLowerCase();
    if (extension && formats.has(extension.replace(/^\./, ""))) {
      return true;
    }
    const normalizedOutputFormat = outputFormat?.trim().toLowerCase();
    return normalizedOutputFormat ? formats.has(normalizedOutputFormat) : false;
  }
  if (params.target !== "voice-note") {
    return false;
  }
  return params.voiceCompatible === true || delivery.transcodesAudio === true;
}

export async function textToSpeechCore(
  params: SpeechSynthesisParams,
  persistTtsAudio: TtsAudioPersistence,
): Promise<TtsResult> {
  const synthesis = await synthesizeSpeech(params);
  if (!synthesis.success || !synthesis.audioBuffer || !synthesis.fileExtension) {
    return {
      success: false,
      error: synthesis.error ?? "TTS conversion failed",
      persona: synthesis.persona,
      attemptedProviders: synthesis.attemptedProviders,
      attempts: synthesis.attempts,
    };
  }

  const transcodeChannel = params.channel;
  const transcodeTarget = synthesis.target;
  const transcodeBuffer = synthesis.audioBuffer;
  const transcodeExtension = synthesis.fileExtension;
  const transcoded = await (async () => {
    if (transcodeTarget !== "audio-file") {
      return undefined;
    }
    const delivery = resolveChannelTtsVoiceDelivery(transcodeChannel);
    const preferred = delivery?.preferAudioFileFormat?.trim().toLowerCase();
    if (!preferred) {
      return undefined;
    }
    const sourceExt = transcodeExtension.trim().toLowerCase().replace(/^\./, "");
    if (sourceExt === preferred) {
      return undefined;
    }
    const outcome = await transcodeAudioBuffer({
      audioBuffer: transcodeBuffer,
      sourceExtension: sourceExt,
      targetExtension: preferred,
    });
    if (!outcome.ok) {
      if (outcome.reason === "transcoder-failed") {
        // Surface only the case where the host actually attempted the transcode
        // and it broke. The other reasons are by-design skips and would just be log noise.
        logVerbose(
          `TTS: pre-transcode ${sourceExt}->${preferred} for channel=${transcodeChannel ?? "?"} failed: ${outcome.detail ?? "unknown"}`,
        );
      }
      return undefined;
    }
    return { audioBuffer: outcome.buffer, fileExtension: `.${preferred}`, outputFormat: preferred };
  })();
  const audioBuffer = transcoded ? transcoded.audioBuffer : synthesis.audioBuffer;
  const fileExtension = transcoded ? transcoded.fileExtension : synthesis.fileExtension;
  const outputFormat = transcoded ? transcoded.outputFormat : synthesis.outputFormat;
  const metadata = {
    latencyMs: synthesis.latencyMs,
    provider: synthesis.provider,
    persona: synthesis.persona,
    fallbackFrom: synthesis.fallbackFrom,
    attemptedProviders: synthesis.attemptedProviders,
    attempts: synthesis.attempts,
  };

  let audioPath: string;
  try {
    audioPath = await persistTtsAudio({
      audioBuffer,
      cfg: params.cfg,
      fileExtension,
      outputFormat,
    });
  } catch (err) {
    logVerbose(`TTS: audio persistence failed: ${sanitizeTtsErrorForLog(err)}`);
    return {
      success: false,
      error: "TTS audio persistence failed",
      ...metadata,
    };
  }

  return {
    success: true,
    audioPath,
    ...metadata,
    outputFormat,
    voiceCompatible: synthesis.voiceCompatible,
    audioAsVoice: shouldDeliverTtsAsVoice({
      channel: params.channel,
      target: synthesis.target,
      voiceCompatible: synthesis.voiceCompatible,
      fileExtension,
      outputFormat,
    }),
    target: synthesis.target,
  };
}

type SpeechSynthesisParams = {
  text: string;
  cfg: OpenClawConfig;
  prefsPath?: string;
  channel?: string;
  overrides?: TtsDirectiveOverrides;
  disableFallback?: boolean;
  timeoutMs?: number;
  agentId?: string;
  accountId?: string;
};

export async function synthesizeSpeech(params: SpeechSynthesisParams): Promise<TtsSynthesisResult> {
  assertSpeechRuntimeAvailable();
  return synthesizeSpeechInternal(params);
}

/** Host-only Talk synthesis retains its own capability boundary instead of bypassing public TTS. */
export async function synthesizeTalkSpeech(
  params: SpeechSynthesisParams,
): Promise<TtsSynthesisResult> {
  assertSecretOwnerAvailable("capability", "talk:speech");
  return synthesizeSpeechInternal(params);
}

async function synthesizeSpeechInternal(
  params: SpeechSynthesisParams,
): Promise<TtsSynthesisResult> {
  return await withOwnedTtsRequest(
    {
      text: params.text,
      cfg: params.cfg,
      prefsPath: params.prefsPath,
      providerOverride: params.overrides?.provider,
      disableFallback: params.disableFallback,
      agentId: params.agentId,
      channelId: params.channel,
      accountId: params.accountId,
    },
    async (setup) => {
      if ("error" in setup) {
        return { success: false, error: setup.error };
      }

      const target = resolveTtsSynthesisTarget(params.channel);
      return await executeTtsProviderAttempts({
        ...setup,
        synthesisText: normalizeSpeechText(params.text),
        providerOverrides: params.overrides?.providerOverrides,
        timeoutMs: params.timeoutMs,
        target,
        logLabel: "TTS",
        selectOperation: ({ resolvedProvider }) => ({
          kind: "ready",
          synthesize: (request) => resolvedProvider.provider.synthesize(request),
        }),
        buildSuccess: ({ synthesis, ...metadata }) => ({
          success: true,
          ...metadata,
          audioBuffer: synthesis.audioBuffer,
          outputFormat: synthesis.outputFormat,
          voiceCompatible: synthesis.voiceCompatible,
          fileExtension: synthesis.fileExtension,
          target,
        }),
      });
    },
  );
}
