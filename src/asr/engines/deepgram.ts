import { transcribeDeepgramAudio } from "../../media-understanding/providers/deepgram/audio.js";
import type { AsrEngine, AsrTranscribeRequest, AsrTranscribeResult } from "../engine.js";

export class DeepgramAsrEngine implements AsrEngine {
  readonly id = "deepgram";

  async transcribe(request: AsrTranscribeRequest): Promise<AsrTranscribeResult> {
    return transcribeDeepgramAudio(request);
  }
}
