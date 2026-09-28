import { TTS_CLIP_MAX_DURATION_MS } from "./tts-clip-recorder.ts";

const CONSENT_MIN_MS = 2_000;
const SOURCE_MIN_MS = 10_000;

export type StoredSpeechVoice = {
  id: string;
  name?: string;
  stored?: boolean;
};

export type VoiceLabSubmitBlock =
  | "disconnected"
  | "needName"
  | "needConsent"
  | "needSource"
  | "sourceTooLong"
  | "storeUncertain";

export function voiceLabSubmitBlock(input: {
  name: string;
  consentMs: number;
  sourceMs: number;
  connected: boolean;
  storeUncertain?: boolean;
}): VoiceLabSubmitBlock | null {
  if (input.storeUncertain) {
    return "storeUncertain";
  }
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

export function shouldAcceptMicStart(input: {
  session: number;
  currentSession: number;
  dialogOpen: boolean;
}): boolean {
  return input.dialogOpen && input.session === input.currentSession;
}

export function shouldClearCreateErrorOnClose(creating: boolean): boolean {
  return !creating;
}
