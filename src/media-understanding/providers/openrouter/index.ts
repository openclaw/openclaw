import type { MediaUnderstandingProvider } from "../../types.js";
import { transcribeOpenRouterAudio } from "./audio.js";
import { describeOpenRouterVideo } from "./video.js";

export const openrouterProvider: MediaUnderstandingProvider = {
  id: "openrouter",
  capabilities: ["audio", "video"],
  transcribeAudio: transcribeOpenRouterAudio,
  describeVideo: describeOpenRouterVideo,
};
