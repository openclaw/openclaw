import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
export type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
export declare function listRuntimeMusicGenerationProviders(params?: {
    config?: OpenClawConfig;
}): import("./types.js").MusicGenerationProvider[];
export declare function generateMusic(params: GenerateMusicParams): Promise<GenerateMusicRuntimeResult>;
