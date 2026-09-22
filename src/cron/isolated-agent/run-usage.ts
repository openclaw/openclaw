import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import {
  createUsageAccumulator,
  mergeUsageIntoAccumulator,
  toNormalizedUsage,
} from "../../agents/embedded-agent-runner/usage-accumulator.js";
import { deriveContextPromptTokens, hasBillableUsage } from "../../agents/usage.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronRunTelemetry } from "../types.js";
import type { CronCompletedPromptRun } from "./run-executor.js";
import type { PreparedCronRunContext } from "./run-prepare.js";
import { DEFAULT_CONTEXT_TOKENS, hasNonzeroUsage } from "./run.runtime.js";

const cronContextRuntimeLoader = createLazyImportLoader(() => import("./run-context.runtime.js"));

export function resolveCronRunUsage(runs: readonly CronCompletedPromptRun[]) {
  if (runs.length === 1) {
    return runs[0]?.runResult.meta?.agentMeta?.usage;
  }
  const accumulated = createUsageAccumulator();
  for (const { runResult } of runs) {
    const usage = runResult.meta?.agentMeta?.usage;
    if (!usage) {
      continue;
    }
    const bucketTotal =
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    mergeUsageIntoAccumulator(accumulated, {
      ...usage,
      total: Math.max(bucketTotal, asNonNegativeFiniteNumber(usage.total) ?? 0),
    });
  }
  return toNormalizedUsage(accumulated);
}

export function applyCronRunUsage(
  prepared: PreparedCronRunContext,
  runs: readonly CronCompletedPromptRun[],
): CronRunTelemetry["usage"] {
  const usage = resolveCronRunUsage(runs);
  if (!hasNonzeroUsage(usage) && !hasNonzeroUsage(runs.at(-1)?.runResult.meta?.agentMeta?.usage)) {
    return undefined;
  }
  const input = usage?.input ?? 0;
  const output = usage?.output ?? 0;
  const cacheRead = usage?.cacheRead ?? 0;
  const cacheWrite = usage?.cacheWrite ?? 0;
  prepared.cronSession.sessionEntry.inputTokens = input;
  prepared.cronSession.sessionEntry.outputTokens = output;
  prepared.cronSession.sessionEntry.cacheRead = cacheRead;
  prepared.cronSession.sessionEntry.cacheWrite = cacheWrite;
  const bucketTotalTokens = input + output + cacheRead + cacheWrite;
  const totalTokens =
    typeof usage?.total === "number" && Number.isFinite(usage.total)
      ? Math.max(bucketTotalTokens, usage.total)
      : bucketTotalTokens;
  return {
    input_tokens: input,
    output_tokens: output,
    ...(totalTokens > 0 ? { total_tokens: totalTokens } : {}),
    ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
  };
}

/** Preserve each completed prompt's prices and diagnostics across a continuation. */
export async function recordCronRunUsage(params: {
  prepared: PreparedCronRunContext;
  runs: readonly CronCompletedPromptRun[];
  contextTokens?: number;
}): Promise<void> {
  const { prepared, runs } = params;
  const billableRuns = runs.filter(({ runResult }) => {
    const meta = runResult.meta?.agentMeta;
    return hasBillableUsage(meta?.usage) || hasBillableUsage(meta?.diagnosticUsage);
  });
  if (billableRuns.length === 0) {
    return;
  }
  const { estimateAggregateUsageCost, resolveModelCostConfig } =
    await import("../../utils/usage-format.js");
  let estimatedCostUsd: number | undefined = 0;
  let hasSessionUsage = false;
  for (const run of billableRuns) {
    const result = run.runResult;
    const meta = result.meta?.agentMeta;
    const usage = meta?.usage;
    const diagnosticUsage = meta?.diagnosticUsage ?? usage;
    const provider = meta?.provider ?? run.fallbackProvider;
    const model = meta?.model ?? run.fallbackModel;
    const costConfig = resolveModelCostConfig({
      provider,
      model,
      config: prepared.cfgWithAgentDefaults,
      agentDir: prepared.agentDir,
    });
    if (hasBillableUsage(usage)) {
      hasSessionUsage = true;
      const cost = asNonNegativeFiniteNumber(
        estimateAggregateUsageCost({ usage, cost: costConfig }),
      );
      estimatedCostUsd =
        estimatedCostUsd !== undefined && cost !== undefined ? estimatedCostUsd + cost : undefined;
    }
    if (
      !isDiagnosticsEnabled(prepared.cfgWithAgentDefaults) ||
      !hasBillableUsage(diagnosticUsage)
    ) {
      continue;
    }
    const input = diagnosticUsage.input ?? 0;
    const output = diagnosticUsage.output ?? 0;
    const cacheRead = diagnosticUsage.cacheRead ?? 0;
    const cacheWrite = diagnosticUsage.cacheWrite ?? 0;
    const promptTokens = input + cacheRead + cacheWrite;
    const bucketTotalTokens = promptTokens + output;
    const total =
      typeof diagnosticUsage.total === "number" && Number.isFinite(diagnosticUsage.total)
        ? Math.max(bucketTotalTokens, diagnosticUsage.total)
        : bucketTotalTokens;
    const costUsd = asNonNegativeFiniteNumber(
      estimateAggregateUsageCost({ usage: diagnosticUsage, cost: costConfig }),
    );
    const contextUsedTokens = deriveContextPromptTokens({
      lastCallUsage: meta?.lastCallUsage,
      promptTokens: meta?.promptTokens,
      usage,
    });
    const contextTokens =
      (result === runs.at(-1)?.runResult ? params.contextTokens : undefined) ??
      asPositiveFiniteNumber(meta?.contextTokens) ??
      (await cronContextRuntimeLoader.load()).resolveModelContextTokenProjection({
        cfg: prepared.cfgWithAgentDefaults,
        provider,
        model,
        allowAsyncLoad: false,
      }).contextTokens ??
      DEFAULT_CONTEXT_TOKENS;
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      ...(result.diagnosticTrace
        ? {
            trace: freezeDiagnosticTraceContext(
              createChildDiagnosticTraceContext(result.diagnosticTrace),
            ),
          }
        : {}),
      sessionKey: prepared.runSessionKey,
      sessionId: prepared.currentRunSessionId(),
      channel: "cron",
      agentId: prepared.agentId,
      provider,
      model,
      usage: { input, output, cacheRead, cacheWrite, promptTokens, total },
      lastCallUsage: meta?.lastCallUsage,
      context: {
        limit: contextTokens,
        ...(contextUsedTokens !== undefined ? { used: contextUsedTokens } : {}),
      },
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: run.runEndedAt - run.runStartedAt,
    });
  }
  if (hasSessionUsage) {
    // Missing prices stay unknown; repricing the sum with the final model would misbill earlier prompts.
    prepared.cronSession.sessionEntry.estimatedCostUsd = estimatedCostUsd;
  }
}
