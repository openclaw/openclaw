import { describeImageWithModel } from "../image.js";
export const minimaxProvider = {
    id: "minimax",
    capabilities: ["image"],
    describeImage: describeImageWithModel,
};
