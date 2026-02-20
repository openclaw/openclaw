import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeSonioxAudio } from "./audio.js";

export const sonioxProvider: MediaUnderstandingProvider = {
  id: "soniox",
  capabilities: ["audio"],
  transcribeAudio: transcribeSonioxAudio,
};
