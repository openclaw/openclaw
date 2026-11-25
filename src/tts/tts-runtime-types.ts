/** Canonical speech provider identifier after provider registry normalization. */
export type SpeechProviderId = string;

/** Output context requested from a speech provider. */
export type SpeechSynthesisTarget = "audio-file" | "voice-note" | "telephony";

/** Provider-owned normalized config map. */
export type SpeechProviderConfig = Record<string, unknown>;

/** Provider-owned per-request directive/persona overrides. */
export type SpeechProviderOverrides = Record<string, unknown>;

/** Parsed directive overrides grouped by provider. */
export type TtsDirectiveOverrides = {
  ttsText?: string;
  provider?: SpeechProviderId;
  providerOverrides?: Record<string, SpeechProviderOverrides>;
};

/** Result of parsing TTS directives from message text. */
export type TtsDirectiveParseResult = {
  cleanedText: string;
  ttsText?: string;
  hasDirective: boolean;
  overrides: TtsDirectiveOverrides;
  warnings: string[];
};

/** Optional provider-prepared synthesis overrides. */
export type SpeechProviderPreparedSynthesis = {
  text?: string;
  providerConfig?: SpeechProviderConfig;
  providerOverrides?: SpeechProviderOverrides;
};

/** Voice metadata returned by provider list-voices hooks. */
export type SpeechVoiceOption = {
  id: string;
  name?: string;
  category?: string;
  description?: string;
  locale?: string;
  gender?: string;
  personalities?: string[];
};

/** Provider directive parser result. */
export type SpeechDirectiveTokenParseResult = {
  handled: boolean;
  overrides?: SpeechProviderOverrides;
  warnings?: string[];
};

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
