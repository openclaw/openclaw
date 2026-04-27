import { type Api, type Model } from "@mariozechner/pi-ai";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import type { ImageModelConfig } from "./image-tool.helpers.js";
import { type ToolModelConfig } from "./model-config.helpers.js";
type TextToolAttempt = {
    provider: string;
    model: string;
    error: string;
};
type TextToolResult = {
    text: string;
    provider: string;
    model: string;
    attempts: TextToolAttempt[];
};
type GenerationModelRef = {
    provider: string;
    model: string;
};
type ParseGenerationModelRef = (raw: string | undefined) => GenerationModelRef | null;
type MediaReferenceDetailEntry = {
    rewrittenFrom?: string;
};
type TaskRunDetailHandle = {
    taskId: string;
    runId: string;
};
export declare function applyImageModelConfigDefaults(cfg: OpenClawConfig | undefined, imageModelConfig: ImageModelConfig): OpenClawConfig | undefined;
export declare function applyImageGenerationModelConfigDefaults(cfg: OpenClawConfig | undefined, imageGenerationModelConfig: ToolModelConfig): OpenClawConfig | undefined;
export declare function applyVideoGenerationModelConfigDefaults(cfg: OpenClawConfig | undefined, videoGenerationModelConfig: ToolModelConfig): OpenClawConfig | undefined;
export declare function applyMusicGenerationModelConfigDefaults(cfg: OpenClawConfig | undefined, musicGenerationModelConfig: ToolModelConfig): OpenClawConfig | undefined;
export declare function readGenerationTimeoutMs(args: Record<string, unknown>): number | undefined;
export declare function resolveRemoteMediaSsrfPolicy(cfg: OpenClawConfig | undefined): SsrFPolicy | undefined;
type CapabilityProvider = {
    id: string;
    aliases?: string[];
    defaultModel?: string;
    isConfigured?: (ctx: {
        cfg?: OpenClawConfig;
        agentDir?: string;
    }) => boolean;
};
export declare function findCapabilityProviderById<T extends CapabilityProvider>(params: {
    providers: T[];
    providerId?: string;
}): T | undefined;
export declare function isCapabilityProviderConfigured<T extends CapabilityProvider>(params: {
    providers: T[];
    provider?: T;
    providerId?: string;
    cfg?: OpenClawConfig;
    agentDir?: string;
}): boolean;
export declare function resolveSelectedCapabilityProvider<T extends CapabilityProvider>(params: {
    providers: T[];
    modelConfig: ToolModelConfig;
    modelOverride?: string;
    parseModelRef: ParseGenerationModelRef;
}): T | undefined;
export declare function resolveCapabilityModelCandidatesForTool(params: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    providers: CapabilityProvider[];
}): string[];
export declare function resolveCapabilityModelConfigForTool(params: {
    cfg?: OpenClawConfig;
    agentDir?: string;
    modelConfig?: AgentModelConfig;
    providers: CapabilityProvider[];
}): ToolModelConfig | null;
export declare function resolveGenerateAction<TAction extends string>(params: {
    args: Record<string, unknown>;
    allowed: readonly TAction[];
    defaultAction: TAction;
}): TAction;
export declare function readBooleanToolParam(params: Record<string, unknown>, key: string): boolean | undefined;
export declare function normalizeMediaReferenceInputs(params: {
    args: Record<string, unknown>;
    singularKey: string;
    pluralKey: string;
    maxCount: number;
    label: string;
}): string[];
export declare function buildMediaReferenceDetails<T extends MediaReferenceDetailEntry>(params: {
    entries: readonly T[];
    singleKey: string;
    pluralKey: string;
    getResolvedInput: (entry: T) => string | undefined;
    singleRewriteKey?: string;
}): Record<string, unknown>;
export declare function buildTaskRunDetails(handle: TaskRunDetailHandle | null | undefined): Record<string, unknown>;
export declare function resolveMediaToolLocalRoots(workspaceDirRaw: string | undefined, options?: {
    workspaceOnly?: boolean;
}, _mediaSources?: readonly string[]): string[];
export declare function resolvePromptAndModelOverride(args: Record<string, unknown>, defaultPrompt: string): {
    prompt: string;
    modelOverride?: string;
};
export declare function buildTextToolResult(result: TextToolResult, extraDetails: Record<string, unknown>): {
    content: Array<{
        type: "text";
        text: string;
    }>;
    details: Record<string, unknown>;
};
export declare function resolveModelFromRegistry(params: {
    modelRegistry: {
        find: (provider: string, modelId: string) => unknown;
    };
    provider: string;
    modelId: string;
}): Model<Api>;
export declare function resolveModelRuntimeApiKey(params: {
    model: Model<Api>;
    cfg: OpenClawConfig | undefined;
    agentDir: string;
    authStorage: {
        setRuntimeApiKey: (provider: string, apiKey: string) => void;
    };
}): Promise<string>;
export {};
