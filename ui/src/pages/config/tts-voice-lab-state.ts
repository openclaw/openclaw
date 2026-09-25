import { TTS_CLIP_MAX_DURATION_MS } from "./tts-clip-recorder.ts";

const CONSENT_MIN_MS = 2_000;
const SOURCE_MIN_MS = 10_000;

export type StoredSpeechVoice = {
  id: string;
  name?: string;
  category?: string;
};

export function isStoredSpeechVoice(voice: StoredSpeechVoice): boolean {
  return (
    voice.id.startsWith("voice_") ||
    voice.category === "prompted" ||
    voice.category === "replicated"
  );
}

export type VoiceLabSubmitBlock =
  | "disconnected"
  | "needName"
  | "needConsent"
  | "needSource"
  | "sourceTooLong";

export function voiceLabSubmitBlock(input: {
  name: string;
  consentMs: number;
  sourceMs: number;
  connected: boolean;
}): VoiceLabSubmitBlock | null {
  if (!input.connected) {
    return "disconnected";
  }
  if (!input.name.trim()) {
    return "needName";
  }
  if (input.consentMs < CONSENT_MIN_MS) {
    return "needConsent";
  }
  if (input.sourceMs < SOURCE_MIN_MS) {
    return "needSource";
  }
  if (input.sourceMs > TTS_CLIP_MAX_DURATION_MS) {
    return "sourceTooLong";
  }
  return null;
}

export function voiceLabCanSubmit(input: {
  name: string;
  consentMs: number;
  sourceMs: number;
}): boolean {
  return (
    voiceLabSubmitBlock({
      ...input,
      connected: true,
    }) === null
  );
}

export function isGoogleVoiceStoreBusy(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b503\b|UNAVAILABLE|currently unavailable/i.test(text);
}

export function isGoogleVoiceStoreInternal(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return /\b500\b|INTERNAL error|Internal error encountered/i.test(text);
}
