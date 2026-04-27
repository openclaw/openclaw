import { type SessionEntry } from "../../config/sessions/types.js";
export declare function resolveParentForkTokenCountRuntime(params: {
    parentEntry: SessionEntry;
    storePath: string;
}): number | undefined;
export declare function forkSessionFromParentRuntime(params: {
    parentEntry: SessionEntry;
    agentId: string;
    sessionsDir: string;
}): {
    sessionId: string;
    sessionFile: string;
} | null;
