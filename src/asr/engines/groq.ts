import { transcribeOpenAiCompatibleAudio } from "../../media-understanding/providers/openai/audio.js";
import type { AsrEngine, AsrTranscribeRequest, AsrTranscribeResult } from "../engine.js";

const DEFAULT_GROQ_ASR_BASE_URL = "https://api.groq.com/openai/v1";

export class GroqAsrEngine implements AsrEngine {
  readonly id = "groq";

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return transcribeOpenAiCompatibleAudio({
      ...request,
      baseUrl: request.baseUrl ?? DEFAULT_GROQ_ASR_BASE_URL,
    });
  }
}
