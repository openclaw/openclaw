import type { ToolDisplaySpec as ToolDisplaySpecBase } from "./tool-display-common.js";
export type ToolDisplaySpec = ToolDisplaySpecBase & {
    emoji?: string;
};
export type ToolDisplayConfig = {
    version: number;
    fallback: ToolDisplaySpec;
    tools: Record<string, ToolDisplaySpec>;
};
export declare const TOOL_DISPLAY_CONFIG: ToolDisplayConfig;
export declare function serializeToolDisplayConfig(config?: ToolDisplayConfig): string;
