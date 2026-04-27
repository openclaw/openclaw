import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import { type GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
type GatewayCaller = typeof callGateway;
export declare function createSessionsSendTool(opts?: {
    agentSessionKey?: string;
    agentChannel?: GatewayMessageChannel;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    callGateway?: GatewayCaller;
}): AnyAgentTool;
export {};
