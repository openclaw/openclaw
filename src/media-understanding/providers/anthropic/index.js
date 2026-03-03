import { describeImageWithModel } from "../image.js";
export const anthropicProvider = {
    id: "anthropic",
    capabilities: ["image"],
    describeImage: describeImageWithModel,
};
