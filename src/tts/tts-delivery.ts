import { resolveChannelTtsVoiceDelivery } from "../channels/plugins/tts-capabilities.js";

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
