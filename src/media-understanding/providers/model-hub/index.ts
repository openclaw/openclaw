import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";
import { transcribeOpenAiCompatibleAudio } from "../openai/audio.js";

export const modelHubProvider: MediaUnderstandingProvider = {
  id: "model-hub",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  transcribeAudio: transcribeOpenAiCompatibleAudio,
};
