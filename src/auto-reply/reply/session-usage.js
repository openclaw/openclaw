import { setCliSessionId } from "../../agents/cli-session.js";
import { deriveSessionTotalTokens, hasNonzeroUsage, } from "../../agents/usage.js";
import { updateSessionStoreEntry, } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
function applyCliSessionIdToSessionPatch(params, entry, patch) {
    const cliProvider = params.providerUsed ?? entry.modelProvider;
    if (params.cliSessionId && cliProvider) {
        const nextEntry = { ...entry, ...patch };
        setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
        return {
            ...patch,
            cliSessionIds: nextEntry.cliSessionIds,
            claudeCliSessionId: nextEntry.claudeCliSessionId,
        };
    }
    return patch;
}
export async function persistSessionUsageUpdate(params) {
    const { storePath, sessionKey } = params;
    if (!storePath || !sessionKey) {
        return;
    }
    const label = params.logLabel ? `${params.logLabel} ` : "";
    const hasUsage = hasNonzeroUsage(params.usage);
    const hasPromptTokens = typeof params.promptTokens === "number" &&
        Number.isFinite(params.promptTokens) &&
        params.promptTokens > 0;
    const hasFreshContextSnapshot = Boolean(params.lastCallUsage) || hasPromptTokens;
    if (hasUsage || hasFreshContextSnapshot) {
        try {
            await updateSessionStoreEntry({
                storePath,
                sessionKey,
                update: async (entry) => {
                    const resolvedContextTokens = params.contextTokensUsed ?? entry.contextTokens;
                    // Use last-call usage for totalTokens when available. The accumulated
                    // `usage.input` sums input tokens from every API call in the run
                    // (tool-use loops, compaction retries), overstating actual context.
                    // `lastCallUsage` reflects only the final API call — the true context.
                    const usageForContext = params.lastCallUsage ?? (hasUsage ? params.usage : undefined);
                    const totalTokens = hasFreshContextSnapshot
                        ? deriveSessionTotalTokens({
                            usage: usageForContext,
                            contextTokens: resolvedContextTokens,
                            promptTokens: params.promptTokens,
                        })
                        : undefined;
                    const patch = {
                        modelProvider: params.providerUsed ?? entry.modelProvider,
                        model: params.modelUsed ?? entry.model,
                        contextTokens: resolvedContextTokens,
                        systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
                        updatedAt: Date.now(),
                    };
                    if (hasUsage) {
                        patch.inputTokens = params.usage?.input ?? 0;
                        patch.outputTokens = params.usage?.output ?? 0;
                        // Cache counters should reflect the latest context snapshot when
                        // available, not accumulated per-call totals across a whole run.
                        const cacheUsage = params.lastCallUsage ?? params.usage;
                        patch.cacheRead = cacheUsage?.cacheRead ?? 0;
                        patch.cacheWrite = cacheUsage?.cacheWrite ?? 0;
                    }
                    // Missing a last-call snapshot (and promptTokens fallback) means
                    // context utilization is stale/unknown.
                    patch.totalTokens = totalTokens;
                    patch.totalTokensFresh = typeof totalTokens === "number";
                    return applyCliSessionIdToSessionPatch(params, entry, patch);
                },
            });
        }
        catch (err) {
            logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
        }
        return;
    }
    if (params.modelUsed || params.contextTokensUsed) {
        try {
            await updateSessionStoreEntry({
                storePath,
                sessionKey,
                update: async (entry) => {
                    const patch = {
                        modelProvider: params.providerUsed ?? entry.modelProvider,
                        model: params.modelUsed ?? entry.model,
                        contextTokens: params.contextTokensUsed ?? entry.contextTokens,
                        systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
                        updatedAt: Date.now(),
                    };
                    return applyCliSessionIdToSessionPatch(params, entry, patch);
                },
            });
        }
        catch (err) {
            logVerbose(`failed to persist ${label}model/context update: ${String(err)}`);
        }
    }
}
