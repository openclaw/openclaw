import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
export type { GenerateVideoParams, GenerateVideoRuntimeResult } from "./runtime-types.js";
export declare function listRuntimeVideoGenerationProviders(params?: {
    config?: OpenClawConfig;
}): import("./types.js").VideoGenerationProvider[];
export declare function generateVideo(params: GenerateVideoParams): Promise<GenerateVideoRuntimeResult>;
