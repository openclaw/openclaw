import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RoutePeer } from "../../routing/resolve-route.js";
export declare function buildOutboundBaseSessionKey(params: {
    cfg: OpenClawConfig;
    agentId: string;
    channel: string;
    accountId?: string | null;
    peer: RoutePeer;
}): string;
