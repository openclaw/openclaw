import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeOpenAiCompatibleAudio } from "../openai/audio.js";

const DEFAULT_TELNYX_AUDIO_BASE_URL = "https://api.telnyx.com/v2/ai";

export const telnyxProvider: MediaUnderstandingProvider = {
  id: "telnyx",
  capabilities: ["audio"],
  transcribeAudio: (req) =>
    transcribeOpenAiCompatibleAudio({
      ...req,
      baseUrl: req.baseUrl ?? DEFAULT_TELNYX_AUDIO_BASE_URL,
    }),
};
