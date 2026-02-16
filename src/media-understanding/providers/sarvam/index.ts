import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeSarvamAudio } from "./audio.js";

export const sarvamProvider: MediaUnderstandingProvider = {
  id: "sarvam",
  capabilities: ["audio"],
  transcribeAudio: transcribeSarvamAudio,
};
