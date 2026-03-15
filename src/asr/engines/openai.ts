import { transcribeOpenAiCompatibleAudio } from "../../media-understanding/providers/openai/audio.js";
import type { AsrEngine, AsrTranscribeRequest, AsrTranscribeResult } from "../engine.js";

export class OpenAiAsrEngine implements AsrEngine {
  readonly id = "openai";

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return transcribeOpenAiCompatibleAudio(request);
  }
}
