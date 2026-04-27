import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import type { AnyAgentTool } from "./common.js";
type GatewayCaller = typeof callGateway;
export declare function createSessionsHistoryTool(opts?: {
    agentSessionKey?: string;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    callGateway?: GatewayCaller;
}): AnyAgentTool;
export {};
