import { transcribeGeminiAudio } from "../../media-understanding/providers/google/audio.js";
import type { AsrEngine, AsrTranscribeRequest, AsrTranscribeResult } from "../engine.js";

export class GoogleAsrEngine implements AsrEngine {
  readonly id = "google";

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return transcribeGeminiAudio(request);
  }
}
