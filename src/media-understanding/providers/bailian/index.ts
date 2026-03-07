import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeBailianAudio } from "./audio.js";

export const bailianProvider: MediaUnderstandingProvider = {
  id: "bailian",
  capabilities: ["audio"],
  transcribeAudio: transcribeBailianAudio,
};
