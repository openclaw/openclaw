import type { AnyAgentTool } from "../agents/tools/common.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type GatewayScopedToolSurface = "http" | "loopback";
export declare function resolveGatewayScopedTools(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    messageProvider?: string;
    accountId?: string;
    agentTo?: string;
    agentThreadId?: string;
    allowGatewaySubagentBinding?: boolean;
    allowMediaInvokeCommands?: boolean;
    surface?: GatewayScopedToolSurface;
    excludeToolNames?: Iterable<string>;
    disablePluginTools?: boolean;
    senderIsOwner?: boolean;
}): {
    agentId: string | undefined;
    tools: AnyAgentTool[];
};
