import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeWhisperAudio } from "./audio.js";

export const whisperProvider: MediaUnderstandingProvider = {
  id: "whisper",
  capabilities: ["audio"],
  transcribeAudio: transcribeWhisperAudio,
};
