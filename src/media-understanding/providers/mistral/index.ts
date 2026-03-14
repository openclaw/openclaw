import { MistralAsrEngine } from "../../../asr/engines/mistral.js";
import type { MediaUnderstandingProvider } from "../../types.js";

const engine = new MistralAsrEngine();

export const mistralProvider: MediaUnderstandingProvider = {
  id: "mistral",
  capabilities: ["audio"],
  transcribeAudio: (req) => engine.transcribe(req),
};
