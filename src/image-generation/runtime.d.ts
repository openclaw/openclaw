import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
export type { GenerateImageParams, GenerateImageRuntimeResult } from "./runtime-types.js";
export declare function listRuntimeImageGenerationProviders(params?: {
    config?: OpenClawConfig;
}): import("./types.js").ImageGenerationProvider[];
export declare function generateImage(params: GenerateImageParams): Promise<GenerateImageRuntimeResult>;
