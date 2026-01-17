import type { MediaUnderstandingProvider } from "../../types.js";
import { describeImageWithModel } from "../image.js";

export const minimaxProvider: MediaUnderstandingProvider = {
  id: "minimax",
  capabilities: ["image"],
  describeImage: describeImageWithModel,
};
