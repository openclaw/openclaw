import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeDeepgramAudio } from "./audio.js";

export const deepgramProvider: MediaUnderstandingProvider = {
  id: "deepgram",
  capabilities: ["audio"],
  transcribeAudio: transcribeDeepgramAudio,
};
