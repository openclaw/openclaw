import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveParentForkMaxTokens(cfg: OpenClawConfig): number;
export declare function forkSessionFromParent(params: {
    parentEntry: SessionEntry;
    agentId: string;
    sessionsDir: string;
}): Promise<{
    sessionId: string;
    sessionFile: string;
} | null>;
export declare function resolveParentForkTokenCount(params: {
    parentEntry: SessionEntry;
    storePath: string;
}): Promise<number | undefined>;
