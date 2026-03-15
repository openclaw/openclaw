import { DeepgramAsrEngine } from "../../../asr/engines/deepgram.js";
import type { MediaUnderstandingProvider } from "../../types.js";

const engine = new DeepgramAsrEngine();

export const deepgramProvider: MediaUnderstandingProvider = {
  id: "deepgram",
  capabilities: ["audio"],
  transcribeAudio: (req) => engine.transcribe(req),
};
