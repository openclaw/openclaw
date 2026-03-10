import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeAzureAudio } from "./audio.js";

export const azureProvider: MediaUnderstandingProvider = {
  id: "azure-foundry",
  capabilities: ["audio"],
  transcribeAudio: transcribeAzureAudio,
};
