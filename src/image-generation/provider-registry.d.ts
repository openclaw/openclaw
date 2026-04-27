import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";
export declare function listImageGenerationProviders(cfg?: OpenClawConfig): ImageGenerationProviderPlugin[];
export declare function getImageGenerationProvider(providerId: string | undefined, cfg?: OpenClawConfig): ImageGenerationProviderPlugin | undefined;
