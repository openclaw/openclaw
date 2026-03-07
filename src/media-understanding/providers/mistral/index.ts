import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeOpenAiCompatibleAudio } from "../openai/audio.js";

const DEFAULT_MISTRAL_AUDIO_BASE_URL = "https://api.mistral.ai/v1";

export const mistralProvider: MediaUnderstandingProvider = {
  id: "mistral",
  capabilities: ["audio"],
  transcribeAudio: (req) =>
    transcribeOpenAiCompatibleAudio({
      ...req,
      baseUrl: req.baseUrl ?? DEFAULT_MISTRAL_AUDIO_BASE_URL,
    }),
};
