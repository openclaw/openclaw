import { GroqAsrEngine } from "../../../asr/engines/groq.js";
import type { MediaUnderstandingProvider } from "../../types.js";

const engine = new GroqAsrEngine();

export const groqProvider: MediaUnderstandingProvider = {
  id: "groq",
  capabilities: ["audio"],
  transcribeAudio: (req) => engine.transcribe(req),
};
