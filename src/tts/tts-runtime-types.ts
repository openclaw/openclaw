/** Buffered speech synthesis result plus file/voice-note compatibility metadata. */
export type SpeechSynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  fileExtension: string;
  voiceCompatible: boolean;
};

/** Streaming speech synthesis result; release frees provider transport resources. */
export type SpeechSynthesisStreamResult = Omit<SpeechSynthesisResult, "audioBuffer"> & {
  audioStream: ReadableStream<Uint8Array>;
  release?: () => Promise<void>;
};

/** Telephony synthesis result with sample-rate metadata for call transports. */
export type SpeechTelephonySynthesisResult = {
  audioBuffer: Buffer;
  outputFormat: string;
  sampleRate: number;
};

export type TtsProviderAttempt = {
  provider: string;
  outcome: "success" | "skipped" | "failed";
  reasonCode:
    | "success"
    | "no_provider_registered"
    | "not_configured"
    | "unsupported_for_streaming"
    | "unsupported_for_telephony"
    | "timeout"
    | "provider_error";
  persona?: string;
  personaBinding?: "applied" | "missing" | "none";
  latencyMs?: number;
  error?: string;
};

type TtsAttemptOutcome = {
  success: boolean;
  error?: string;
  latencyMs?: number;
  provider?: string;
  persona?: string;
  fallbackFrom?: string;
  attemptedProviders?: string[];
  attempts?: TtsProviderAttempt[];
};

type TtsMediaOutcome = TtsAttemptOutcome & {
  outputFormat?: string;
};

type TtsProviderMediaOutcome = TtsMediaOutcome & {
  providerModel?: string;
  providerVoice?: string;
};

type TtsVoiceMediaOutcome = TtsProviderMediaOutcome & {
  voiceCompatible?: boolean;
  fileExtension?: string;
  target?: "audio-file" | "voice-note";
};

export type TtsResult = TtsMediaOutcome & {
  audioPath?: string;
  voiceCompatible?: boolean;
  audioAsVoice?: boolean;
  target?: "audio-file" | "voice-note";
};

export type TtsSynthesisResult = TtsVoiceMediaOutcome & {
  audioBuffer?: Buffer;
};

export type TtsStreamResult = TtsVoiceMediaOutcome & {
  audioStream?: ReadableStream<Uint8Array>;
  release?: () => Promise<void>;
};

export type TtsSynthesisStreamResult = TtsStreamResult;

export type TtsTelephonyResult = TtsProviderMediaOutcome & {
  audioBuffer?: Buffer;
  sampleRate?: number;
};

export type TtsStatusEntry = TtsAttemptOutcome & {
  timestamp: number;
  textLength: number;
  summarized: boolean;
};
