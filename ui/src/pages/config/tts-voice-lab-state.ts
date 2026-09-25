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

export function voiceLabCanSubmit(input: {
  name: string;
  consentMs: number;
  sourceMs: number;
}): boolean {
  return (
    Boolean(input.name.trim()) &&
    input.consentMs >= CONSENT_MIN_MS &&
    input.sourceMs >= SOURCE_MIN_MS &&
    input.sourceMs <= TTS_CLIP_MAX_DURATION_MS
  );
}
