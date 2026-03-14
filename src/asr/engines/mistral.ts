import { transcribeOpenAiCompatibleAudio } from "../../media-understanding/providers/openai/audio.js";
import type { AsrEngine, AsrTranscribeRequest, AsrTranscribeResult } from "../engine.js";

const DEFAULT_MISTRAL_ASR_BASE_URL = "https://api.mistral.ai/v1";

export class MistralAsrEngine implements AsrEngine {
  readonly id = "mistral";

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return transcribeOpenAiCompatibleAudio({
      ...request,
      baseUrl: request.baseUrl ?? DEFAULT_MISTRAL_ASR_BASE_URL,
    });
  }
}
