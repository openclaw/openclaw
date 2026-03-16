import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";
import { describeMoonshotVideo } from "./video.js";

export const moonshotProvider: MediaUnderstandingProvider = {
  id: "moonshot",
  capabilities: ["image", "video"],
  describeImage: describeImageWithModel,
  describeVideo: describeMoonshotVideo,
};
