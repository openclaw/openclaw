import {
  deriveContextPromptTokens,
  hasBillableUsage,
  toDiagnosticUsage,
} from "../../agents/usage.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { estimateAggregateUsageCostAsync } from "../../utils/usage-format.js";
import type { AccountedAgentTurn } from "./agent-runner-result-accounting.js";
import type { FinalizeReplyAgentRunInput } from "./agent-runner-result.types.js";

export async function emitReplyAgentUsageDiagnostic(state: {
  context: FinalizeReplyAgentRunInput;
  accounting: AccountedAgentTurn;
}): Promise<void> {
  const { cfg, followupRun, replyToChannel, runStartedAt, sessionKey } = state.context;
  const { contextTokensUsed, modelUsed, promptTokens, providerUsed, runResult, usage } =
    state.accounting;
  const diagnosticUsage = runResult.meta?.agentMeta?.diagnosticUsage ?? usage;
  if (!isDiagnosticsEnabled(cfg) || !hasBillableUsage(diagnosticUsage)) {
    return;
  }
  const contextUsedTokens = deriveContextPromptTokens({
    lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
    promptTokens,
    usage,
  });
  const costUsd = await estimateAggregateUsageCostAsync({
    usage: diagnosticUsage,
    prepareCost: async () =>
      (await state.accounting.preparePricing()).resolve(providerUsed, modelUsed),
  });
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    ...(runResult.diagnosticTrace
      ? {
          trace: freezeDiagnosticTraceContext(
            createChildDiagnosticTraceContext(runResult.diagnosticTrace),
          ),
        }
      : {}),
    sessionKey,
    sessionId: followupRun.run.sessionId,
    channel: replyToChannel,
    agentId: followupRun.run.agentId,
    provider: providerUsed,
    model: modelUsed,
    usage: toDiagnosticUsage(diagnosticUsage),
    lastCallUsage: runResult.meta?.agentMeta?.lastCallUsage,
    context: {
      limit: contextTokensUsed,
      ...(contextUsedTokens !== undefined ? { used: contextUsedTokens } : {}),
    },
    costUsd,
    durationMs: Date.now() - runStartedAt,
  });
}
