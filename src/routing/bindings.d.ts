import type { AgentRouteBinding } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export declare function listBindings(cfg: OpenClawConfig): AgentRouteBinding[];
export declare function listBoundAccountIds(cfg: OpenClawConfig, channelId: string): string[];
export declare function resolveDefaultAgentBoundAccountId(cfg: OpenClawConfig, channelId: string): string | null;
export declare function buildChannelAccountBindings(cfg: OpenClawConfig): Map<string, Map<string, string[]>>;
export declare function resolvePreferredAccountId(params: {
    accountIds: string[];
    defaultAccountId: string;
    boundAccounts: string[];
}): string;
