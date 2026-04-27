import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway as defaultCallGateway } from "../gateway/call.js";
type GatewayCaller = typeof defaultCallGateway;
/** Test hook: must stay aligned with `sessions-resolution` `__testing.setDepsForTest`. */
export declare const sessionVisibilityGatewayTesting: {
    setCallGatewayForListSpawned(overrides?: GatewayCaller): void;
};
export type SessionToolsVisibility = "self" | "tree" | "agent" | "all";
export type AgentToAgentPolicy = {
    enabled: boolean;
    matchesAllow: (agentId: string) => boolean;
    isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};
export type SessionAccessAction = "history" | "send" | "list" | "status";
export type SessionAccessResult = {
    allowed: true;
} | {
    allowed: false;
    error: string;
    status: "forbidden";
};
export declare function listSpawnedSessionKeys(params: {
    requesterSessionKey: string;
    limit?: number;
}): Promise<Set<string>>;
export declare function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility;
export declare function resolveEffectiveSessionToolsVisibility(params: {
    cfg: OpenClawConfig;
    sandboxed: boolean;
}): SessionToolsVisibility;
export declare function resolveSandboxSessionToolsVisibility(cfg: OpenClawConfig): "spawned" | "all";
export declare function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy;
export declare function createSessionVisibilityChecker(params: {
    action: SessionAccessAction;
    requesterSessionKey: string;
    visibility: SessionToolsVisibility;
    a2aPolicy: AgentToAgentPolicy;
    spawnedKeys: Set<string> | null;
}): {
    check: (targetSessionKey: string) => SessionAccessResult;
};
export declare function createSessionVisibilityGuard(params: {
    action: SessionAccessAction;
    requesterSessionKey: string;
    visibility: SessionToolsVisibility;
    a2aPolicy: AgentToAgentPolicy;
}): Promise<{
    check: (targetSessionKey: string) => SessionAccessResult;
}>;
export {};
