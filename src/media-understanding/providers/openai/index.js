import { describeImageWithModel } from "../image.js";
import { transcribeOpenAiCompatibleAudio } from "./audio.js";
export const openaiProvider = {
    id: "openai",
    capabilities: ["image"],
    describeImage: describeImageWithModel,
    transcribeAudio: transcribeOpenAiCompatibleAudio,
};
