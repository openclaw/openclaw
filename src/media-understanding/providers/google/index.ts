import type { MediaUnderstandingProvider } from "../../types.js";
import { describeGeminiVideo } from "./video.js";

export const googleProvider: MediaUnderstandingProvider = {
  id: "google",
  describeVideo: describeGeminiVideo,
};
