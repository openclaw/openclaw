export type AsrTranscribeRequest = {
  buffer: Buffer;
  fileName: string;
  mime?: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  model?: string;
  language?: string;
  prompt?: string;
  query?: Record<string, string | number | boolean>;
  timeoutMs: number;
  fetchFn?: typeof fetch;
};

export type AsrTranscribeResult = {
  text: string;
  model?: string;
};

/**
 * Dedicated engine interface for ASR (Automatic Speech Recognition).
 *
 * Unlike the broader {@link MediaUnderstandingProvider} where `transcribeAudio`
 * is optional, every `AsrEngine` **must** implement `transcribe`.
 */
export interface AsrEngine {
  readonly id: string;

  transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult>;
}
