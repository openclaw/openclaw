import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeOpenAiCompatibleAudio } from "./audio.js";

export const openaiProvider: MediaUnderstandingProvider = {
  id: "openai",
  transcribeAudio: transcribeOpenAiCompatibleAudio,
};
