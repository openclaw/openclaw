import type { OpenClawConfig } from "../config/types.openclaw.js";

// Public contracts for realtime transcription provider plugins and sessions.
// Providers own config resolution; core owns session lifecycle shape.
export type RealtimeTranscriptionProviderId = string;

export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;

/** Raw audio supplied by a finite-utterance consumer, without container headers. */
export type RealtimeTranscriptionAudioFormat = {
  encoding: "pcm_s16le";
  sampleRate: number;
  channels: 1;
};

export type RealtimeTranscriptionProviderResolveConfigContext = {
  cfg: OpenClawConfig;
  rawConfig: RealtimeTranscriptionProviderConfig;
};

export type RealtimeTranscriptionProviderConfiguredContext = {
  cfg?: OpenClawConfig;
  providerConfig: RealtimeTranscriptionProviderConfig;
};

/** Callback hooks emitted by realtime transcription sessions. */
export type RealtimeTranscriptionSessionCallbacks = {
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
};

/** Inputs passed to a provider when creating a transcription session. */
export type RealtimeTranscriptionSessionCreateRequest = RealtimeTranscriptionSessionCallbacks & {
  cfg?: OpenClawConfig;
  agentId?: string;
  providerConfig: RealtimeTranscriptionProviderConfig;
  utterance?: { format: RealtimeTranscriptionAudioFormat; signal: AbortSignal };
};

/** Runtime control surface for a realtime transcription session. */
export type RealtimeTranscriptionSession = {
  connect(): Promise<void>;
  sendAudio(audio: Buffer): void;
  /** Backpressured writes for advertised finite utterances; continuous writes remain synchronous. */
  writeAudio?(audio: Buffer): Promise<void>;
  /** Finalizes all accepted audio; available only for advertised finite utterances. */
  finishInput?(): Promise<{ text: string }>;
  /** Cancels a finite utterance; continuous sessions retain their close-flush contract. */
  close(): void;
  isConnected(): boolean;
};
