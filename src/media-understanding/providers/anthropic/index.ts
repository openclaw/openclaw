import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";

export const anthropicProvider: MediaUnderstandingProvider = {
  id: "anthropic",
  capabilities: ["image"],
  describeImage: describeImageWithModel,
};
