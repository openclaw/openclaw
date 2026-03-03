import { describeImageWithModel } from "../image.js";
import { describeMoonshotVideo } from "./video.js";
export const moonshotProvider = {
    id: "moonshot",
    capabilities: ["image", "video"],
    describeImage: describeImageWithModel,
    describeVideo: describeMoonshotVideo,
};
