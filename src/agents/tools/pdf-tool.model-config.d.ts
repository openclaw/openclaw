import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type ImageModelConfig } from "./image-tool.helpers.js";
export declare function resolvePdfModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir: string;
}): ImageModelConfig | null;
