import { deriveSessionTotalTokens } from "../../agents/usage.js";
import { incrementCompactionCount } from "./session-updates.js";
import { persistSessionUsageUpdate } from "./session-usage.js";
export async function persistRunSessionUsage(params) {
    await persistSessionUsageUpdate(params);
}
export async function incrementRunCompactionCount(params) {
    const tokensAfterCompaction = params.lastCallUsage
        ? deriveSessionTotalTokens({
            usage: params.lastCallUsage,
            contextTokens: params.contextTokensUsed,
        })
        : undefined;
    return incrementCompactionCount({
        sessionEntry: params.sessionEntry,
        sessionStore: params.sessionStore,
        sessionKey: params.sessionKey,
        storePath: params.storePath,
        tokensAfter: tokensAfterCompaction,
    });
}
