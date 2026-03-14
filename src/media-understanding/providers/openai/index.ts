import { OpenAiAsrEngine } from "../../../asr/engines/openai.js";
import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";

const asrEngine = new OpenAiAsrEngine();

export const openaiProvider: MediaUnderstandingProvider = {
  id: "openai",
  capabilities: ["image", "audio"],
  describeImage: describeImageWithModel,
  transcribeAudio: (req) => asrEngine.transcribe(req),
};
