import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
/** @deprecated Use ChatType from channels/chat-type.js */
export type RoutePeerKind = ChatType;
export type RoutePeer = {
    kind: ChatType;
    id: string;
};
export type ResolveAgentRouteInput = {
    cfg: OpenClawConfig;
    channel: string;
    accountId?: string | null;
    peer?: RoutePeer | null;
    /** Parent peer for threads — used for binding inheritance when peer doesn't match directly. */
    parentPeer?: RoutePeer | null;
    guildId?: string | null;
    teamId?: string | null;
    /** Discord member role IDs — used for role-based agent routing. */
    memberRoleIds?: string[];
};
export type ResolvedAgentRoute = {
    agentId: string;
    channel: string;
    accountId: string;
    /** Internal session key used for persistence + concurrency. */
    sessionKey: string;
    /** Convenience alias for direct-chat collapse. */
    mainSessionKey: string;
    /** Which session should receive inbound last-route updates. */
    lastRoutePolicy: "main" | "session";
    /** Match description for debugging/logging. */
    matchedBy: "binding.peer" | "binding.peer.parent" | "binding.peer.wildcard" | "binding.guild+roles" | "binding.guild" | "binding.team" | "binding.account" | "binding.channel" | "default";
};
export { DEFAULT_ACCOUNT_ID, DEFAULT_AGENT_ID } from "./session-key.js";
export declare function deriveLastRoutePolicy(params: {
    sessionKey: string;
    mainSessionKey: string;
}): ResolvedAgentRoute["lastRoutePolicy"];
export declare function resolveInboundLastRouteSessionKey(params: {
    route: Pick<ResolvedAgentRoute, "lastRoutePolicy" | "mainSessionKey">;
    sessionKey: string;
}): string;
export declare function buildAgentSessionKey(params: {
    agentId: string;
    channel: string;
    accountId?: string | null;
    peer?: RoutePeer | null;
    /** DM session scope. */
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
    identityLinks?: Record<string, string[]>;
}): string;
export declare function pickFirstExistingAgentId(cfg: OpenClawConfig, agentId: string): string;
export declare function resolveAgentRoute(input: ResolveAgentRouteInput): ResolvedAgentRoute;
