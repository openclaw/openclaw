import { setCliSessionBinding, setCliSessionId } from "../../agents/cli-session.js";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  type NormalizedUsage,
} from "../../agents/usage.js";
import { loadConfig } from "../../config/config.js";
import {
  type SessionSystemPromptReport,
  type SessionEntry,
  updateSessionStoreEntry,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";

function applyCliSessionIdToSessionPatch(
  params: {
    providerUsed?: string;
    cliSessionId?: string;
    cliSessionBinding?: import("../../config/sessions.js").CliSessionBinding;
  },
  entry: SessionEntry,
  patch: Partial<SessionEntry>,
): Partial<SessionEntry> {
  const cliProvider = params.providerUsed ?? entry.modelProvider;
  if (params.cliSessionBinding && cliProvider) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionBinding(nextEntry, cliProvider, params.cliSessionBinding);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  if (params.cliSessionId && cliProvider) {
    const nextEntry = { ...entry, ...patch };
    setCliSessionId(nextEntry, cliProvider, params.cliSessionId);
    return {
      ...patch,
      cliSessionIds: nextEntry.cliSessionIds,
      cliSessionBindings: nextEntry.cliSessionBindings,
      claudeCliSessionId: nextEntry.claudeCliSessionId,
    };
  }
  return patch;
}

function resolveNonNegativeNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function estimateSessionRunCostUsd(params: {
  cfg: OpenClawConfig;
  usage?: NormalizedUsage;
  providerUsed?: string;
  modelUsed?: string;
}): number | undefined {
  if (!hasNonzeroUsage(params.usage)) {
    return undefined;
  }
  const cost = resolveModelCostConfig({
    provider: params.providerUsed,
    model: params.modelUsed,
    config: params.cfg,
  });
  return resolveNonNegativeNumber(estimateUsageCost({ usage: params.usage, cost }));
}

export async function persistSessionUsageUpdate(params: {
  storePath?: string;
  sessionKey?: string;
  cfg?: OpenClawConfig;
  usage?: NormalizedUsage;
  /**
   * Usage from the last individual API call (not accumulated). When provided,
   * this is used for `totalTokens` instead of the accumulated `usage` so that
   * context-window utilization reflects the actual current context size rather
   * than the sum of input tokens across all API calls in the run.
   */
  lastCallUsage?: NormalizedUsage;
  modelUsed?: string;
  providerUsed?: string;
  contextTokensUsed?: number;
  promptTokens?: number;
  usageIsContextSnapshot?: boolean;
  systemPromptReport?: SessionSystemPromptReport;
  cliSessionId?: string;
  cliSessionBinding?: import("../../config/sessions.js").CliSessionBinding;
  logLabel?: string;
}): Promise<void> {
  const { storePath, sessionKey } = params;
  if (!storePath || !sessionKey) {
    return;
  }

  const label = params.logLabel ? `${params.logLabel} ` : "";
  const cfg = params.cfg ?? loadConfig();
  const hasUsage = hasNonzeroUsage(params.usage);
  const hasLastCallUsage = hasNonzeroUsage(params.lastCallUsage);
  const hasPromptTokens =
    // Fixed: Prompt tokens >= 0 (not > 0) to handle fresh 0-token snapshots (Codex)
    typeof params.promptTokens === "number" &&
    Number.isFinite(params.promptTokens) &&
    params.promptTokens >= 0;
  const hasFreshContextSnapshot =
    hasLastCallUsage || hasPromptTokens || (params.usageIsContextSnapshot === true && hasUsage);

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
          const usageForContext =
            params.lastCallUsage ??
            (params.usageIsContextSnapshot === true ? params.usage : undefined);
          const totalTokens = hasFreshContextSnapshot
            ? deriveSessionTotalTokens({
                usage: usageForContext,
                contextTokens: resolvedContextTokens,
                promptTokens: params.promptTokens,
                isExplicitSnapshot: hasFreshContextSnapshot,
              })
            : undefined;
          const runEstimatedCostUsd = estimateSessionRunCostUsd({
            cfg,
            usage: params.usage,
            providerUsed: params.providerUsed ?? entry.modelProvider,
            modelUsed: params.modelUsed ?? entry.model,
          });
          const existingEstimatedCostUsd = resolveNonNegativeNumber(entry.estimatedCostUsd) ?? 0;

          const modelUsed = params.modelUsed ?? entry.model;
          const providerUsed = params.providerUsed ?? entry.modelProvider;
          const modelChanged =
            (entry.model !== undefined && entry.model !== modelUsed) ||
            (entry.modelProvider !== undefined && entry.modelProvider !== providerUsed);

          const patch: Partial<SessionEntry> = {
            modelProvider: providerUsed,
            model: modelUsed,
            contextTokens: resolvedContextTokens,
            systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
            updatedAt: Date.now(),
          };

          if (
            typeof totalTokens === "number" &&
            Number.isFinite(totalTokens) &&
            (totalTokens > 0 || (totalTokens === 0 && hasFreshContextSnapshot))
          ) {
            patch.totalTokens = totalTokens;
            patch.totalTokensFresh = true;
            patch.totalTokensEstimate = totalTokens;
          } else {
            patch.totalTokens = undefined;
            patch.totalTokensFresh = false;
            if (modelChanged) {
              patch.totalTokensEstimate = undefined;
            }
          }
          const hasCurrentUsage =
            hasUsage ||
            Boolean(params.lastCallUsage) ||
            (typeof params.promptTokens === "number" && params.promptTokens >= 0);

          if (hasCurrentUsage || hasFreshContextSnapshot) {
            patch.inputTokens = params.usage?.input;
            patch.outputTokens = params.usage?.output;
            // Cache counters should reflect the latest context snapshot when
            // available, not accumulated per-call totals across a whole run.
            const cacheUsage = params.lastCallUsage ?? params.usage;
            patch.cacheRead = cacheUsage?.cacheRead;
            patch.cacheWrite = cacheUsage?.cacheWrite;
          }
          if (runEstimatedCostUsd !== undefined) {
            patch.estimatedCostUsd = existingEstimatedCostUsd + runEstimatedCostUsd;
          } else if (entry.estimatedCostUsd !== undefined) {
            patch.estimatedCostUsd = entry.estimatedCostUsd;
          }

          return applyCliSessionIdToSessionPatch(params, entry, patch);
        },
      });
    } catch (err) {
      logVerbose(`failed to persist ${label}usage update: ${String(err)}`);
    }
    return;
  }

  if (!params.modelUsed && !params.contextTokensUsed) {
    return;
  }

  // A run completed with model/context info but no usage data at all (e.g.
  // because the provider failed or the run was aborted before any API calls
  // were made). Clear usage but preserve model/context if provided.
  try {
    await updateSessionStoreEntry({
      storePath,
      sessionKey,
      update: async (entry) => {
        const modelUsed = params.modelUsed ?? entry.model;
        const providerUsed = params.providerUsed ?? entry.modelProvider;
        const modelChanged =
          (entry.model !== undefined && entry.model !== modelUsed) ||
          (entry.modelProvider !== undefined && entry.modelProvider !== providerUsed);

        const patch: Partial<SessionEntry> = {
          modelProvider: providerUsed,
          model: modelUsed,
          contextTokens: params.contextTokensUsed ?? entry.contextTokens,
          systemPromptReport: params.systemPromptReport ?? entry.systemPromptReport,
          updatedAt: Date.now(),
        };

        if (modelChanged) {
          patch.inputTokens = undefined;
          patch.outputTokens = undefined;
          patch.totalTokens = undefined;
          patch.totalTokensFresh = false;
          patch.cacheRead = undefined;
          patch.cacheWrite = undefined;
          patch.totalTokensEstimate = undefined;
        } else {
          if (entry.totalTokens !== undefined && entry.totalTokensFresh !== false) {
            // Always prefer a confirmed fresh total as the estimate baseline.
            patch.totalTokensEstimate = entry.totalTokens;
          }
        }
        return applyCliSessionIdToSessionPatch(params, entry, patch);
      },
    });
  } catch (err) {
    logVerbose(`failed to clear ${label}usage update: ${String(err)}`);
  }
}
