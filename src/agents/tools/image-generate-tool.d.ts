import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
import { type AnyAgentTool, type SandboxFsBridge, type ToolFsPolicy } from "./tool-runtime.helpers.js";
export declare function resolveImageGenerationModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir?: string;
}): ToolModelConfig | null;
type ImageGenerateSandboxConfig = {
    root: string;
    bridge: SandboxFsBridge;
};
export declare function createImageGenerateTool(options?: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    sandbox?: ImageGenerateSandboxConfig;
    fsPolicy?: ToolFsPolicy;
}): AnyAgentTool | null;
export {};
