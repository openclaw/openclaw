import type { SessionScope } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type GatewayAgentListRow = {
    id: string;
    name?: string;
};
export declare function listGatewayAgentsBasic(cfg: OpenClawConfig): {
    defaultId: string;
    mainKey: string;
    scope: SessionScope;
    agents: GatewayAgentListRow[];
};
