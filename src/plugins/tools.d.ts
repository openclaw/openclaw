import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawPluginToolContext } from "./types.js";
export type PluginToolMeta = {
    pluginId: string;
    optional: boolean;
};
export declare function setPluginToolMeta(tool: AnyAgentTool, meta: PluginToolMeta): void;
export declare function getPluginToolMeta(tool: AnyAgentTool): PluginToolMeta | undefined;
export declare function copyPluginToolMeta(source: AnyAgentTool, target: AnyAgentTool): void;
export declare function resolvePluginTools(params: {
    context: OpenClawPluginToolContext;
    existingToolNames?: Set<string>;
    toolAllowlist?: string[];
    suppressNameConflicts?: boolean;
    allowGatewaySubagentBinding?: boolean;
    env?: NodeJS.ProcessEnv;
}): AnyAgentTool[];
