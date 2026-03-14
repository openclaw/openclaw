import { transcribeOpenAiCompatibleAudio } from "../../media-understanding/providers/openai/audio.js";
import type { AsrEngine, AsrTranscribeRequest, AsrTranscribeResult } from "../engine.js";

export const DEFAULT_OPENAI_ASR_BASE_URL = "https://api.openai.com/v1";

export class OpenAiAsrEngine implements AsrEngine {
  readonly id = "openai";

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return transcribeOpenAiCompatibleAudio(request);
  }
}
