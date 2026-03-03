import { describeImageWithModel } from "../image.js";
import { transcribeGeminiAudio } from "./audio.js";
import { describeGeminiVideo } from "./video.js";
export const googleProvider = {
    id: "google",
    capabilities: ["image", "audio", "video"],
    describeImage: describeImageWithModel,
    transcribeAudio: transcribeGeminiAudio,
    describeVideo: describeGeminiVideo,
};
