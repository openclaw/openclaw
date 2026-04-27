import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearActiveMcpLoopbackRuntimeByOwnerToken, createMcpLoopbackServerConfig, getActiveMcpLoopbackRuntime, setActiveMcpLoopbackRuntime } from "./mcp-http.loopback-runtime.js";
import { type McpLoopbackTool, type McpToolSchemaEntry } from "./mcp-http.schema.js";
type CachedScopedTools = {
    agentId: string | undefined;
    tools: McpLoopbackTool[];
    toolSchema: McpToolSchemaEntry[];
    configRef: OpenClawConfig;
    time: number;
};
export declare class McpLoopbackToolCache {
    #private;
    resolve(params: {
        cfg: OpenClawConfig;
        sessionKey: string;
        messageProvider: string | undefined;
        accountId: string | undefined;
        senderIsOwner: boolean | undefined;
    }): CachedScopedTools;
}
export { clearActiveMcpLoopbackRuntimeByOwnerToken, createMcpLoopbackServerConfig, getActiveMcpLoopbackRuntime, setActiveMcpLoopbackRuntime, };
