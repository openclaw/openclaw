import { GoogleAsrEngine } from "../../../asr/engines/google.js";
import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";
import { describeGeminiVideo } from "./video.js";

const asrEngine = new GoogleAsrEngine();

export const googleProvider: MediaUnderstandingProvider = {
  id: "google",
  capabilities: ["image", "audio", "video"],
  describeImage: describeImageWithModel,
  transcribeAudio: (req) => asrEngine.transcribe(req),
  describeVideo: describeGeminiVideo,
};
