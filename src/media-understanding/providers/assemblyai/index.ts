import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeAssemblyAIAudio } from "./audio.js";

export const assemblyaiProvider: MediaUnderstandingProvider = {
  id: "assemblyai",
  capabilities: ["audio"],
  transcribeAudio: transcribeAssemblyAIAudio,
};
