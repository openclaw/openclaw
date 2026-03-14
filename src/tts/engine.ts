import type { TtsDirectiveOverrides } from "./tts.js";

export type TtsSynthesizeRequest = {
  text: string;
  outputFormat: string;
  timeoutMs: number;
  overrides?: TtsDirectiveOverrides;
};

export type TtsSynthesizeResult = {
  audio: Buffer;
  format: string;
};

export type TtsSynthesizeToFileResult = {
  audioPath: string;
  format: string;
  voiceCompatible: boolean;
};

export interface TtsEngine {
  readonly id: string;

  isConfigured(): boolean;

  synthesize(request: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>;

  /**
   * Edge TTS writes directly to a file; other engines buffer in memory then
   * write to a temp file. This optional method lets engines that need special
   * file-output handling (like Edge with its fallback logic) override the
   * default buffer-to-file path.
   */
  synthesizeToFile?(request: TtsSynthesizeRequest): Promise<TtsSynthesizeToFileResult>;

  supportsTelephony(): boolean;
}
