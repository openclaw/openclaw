import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { abortEmbeddedPiRun } from "../../agents/pi-embedded-runner/runs.js";
import { getLatestSubagentRunByChildSessionKey, listSubagentRunsForController, markSubagentRunTerminated } from "../../agents/subagent-registry.js";
import { type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { FinalizedMsgContext } from "../templating.js";
import { getAbortMemory, getAbortMemorySizeForTest, isAbortRequestText, isAbortTrigger, resetAbortMemoryForTest, setAbortMemory } from "./abort-primitives.js";
export { resolveAbortCutoffFromContext, shouldSkipMessageByAbortCutoff } from "./abort-cutoff.js";
export { getAbortMemory, getAbortMemorySizeForTest, isAbortRequestText, isAbortTrigger, resetAbortMemoryForTest, setAbortMemory, };
declare const defaultAbortDeps: {
    getAcpSessionManager: typeof getAcpSessionManager;
    abortEmbeddedPiRun: typeof abortEmbeddedPiRun;
    getLatestSubagentRunByChildSessionKey: typeof getLatestSubagentRunByChildSessionKey;
    listSubagentRunsForController: typeof listSubagentRunsForController;
    markSubagentRunTerminated: typeof markSubagentRunTerminated;
};
export declare const __testing: {
    setDepsForTests(deps: Partial<typeof defaultAbortDeps> | undefined): void;
    resetDepsForTests(): void;
};
export declare function formatAbortReplyText(stoppedSubagents?: number): string;
export declare function resolveSessionEntryForKey(store: Record<string, SessionEntry> | undefined, sessionKey: string | undefined): {
    entry?: SessionEntry;
    key?: string;
    legacyKeys?: string[];
};
export declare function stopSubagentsForRequester(params: {
    cfg: OpenClawConfig;
    requesterSessionKey?: string;
}): {
    stopped: number;
};
export declare function tryFastAbortFromMessage(params: {
    ctx: FinalizedMsgContext;
    cfg: OpenClawConfig;
}): Promise<{
    handled: boolean;
    aborted: boolean;
    stoppedSubagents?: number;
}>;
