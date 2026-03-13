import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";
import { transcribeZaiAudio } from "./audio.js";

export const zaiProvider: MediaUnderstandingProvider = {
  id: "zai",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  transcribeAudio: transcribeZaiAudio,
};
