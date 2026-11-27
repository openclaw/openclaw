// Public contracts for realtime transcription provider plugins and sessions.
// Providers own config resolution; core owns session lifecycle shape.
export type RealtimeTranscriptionProviderId = string;

export type RealtimeTranscriptionProviderConfig = Record<string, unknown>;

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
  close(): void;
  isConnected(): boolean;
};
