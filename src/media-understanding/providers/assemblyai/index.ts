import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeAssemblyAiAudio } from "./audio.js";

export const assemblyaiProvider: MediaUnderstandingProvider = {
  id: "assemblyai",
  capabilities: ["audio"],
  transcribeAudio: transcribeAssemblyAiAudio,
};
