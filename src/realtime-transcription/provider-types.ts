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

/** Callback hooks emitted by realtime transcription sessions. */
export type RealtimeTranscriptionSessionCallbacks = {
  /** Synchronous live-authority check; failure requires aborting without finalization. */
  assertCurrent?: () => void;
  onPartial?: (partial: string) => void;
  onTranscript?: (transcript: string) => void;
  onSpeechStart?: () => void;
  onError?: (error: Error) => void;
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
