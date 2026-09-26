import { asFiniteNumberInRange } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasRecordedUsageCost, normalizeUsage, type UsageLike } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent, isDiagnosticsEnabled } from "../../infra/diagnostic-events.js";
import { markHostPluginUsageDiagnosticEvent } from "../../infra/diagnostic-plugin-usage-provenance.js";
import {
  estimateAggregateUsageCost,
  estimateUsageCost,
  resolveModelCostConfig,
} from "../../utils/usage-format.js";
import type { LlmCompleteUsage } from "./types-core.js";

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0 });
}

function readExplicitCostUsd(raw: unknown): number | undefined {
  const cost = asOptionalRecord(raw)?.cost;
  if (typeof cost === "number") {
    return readFiniteNonNegativeNumber(cost);
  }
  const record = asOptionalRecord(cost);
  if (!record) {
    return undefined;
  }
  return (
    readFiniteNonNegativeNumber(record.totalUsd) ??
    (hasRecordedUsageCost(record) ? readFiniteNonNegativeNumber(record.total) : undefined)
  );
}

/** One usage/cost owner; typed result domains need not impersonate a chat completion. */
export function finalizePluginModelUsage(params: {
  cfg: OpenClawConfig;
  hostPluginId?: string;
  suppressUsage?: boolean;
  rawUsage: unknown;
  estimate: "direct" | "aggregate" | "none";
  /** Prepared route facts, never an ID-only lookup after request normalization. */
  declaredCost?: Parameters<typeof estimateUsageCost>[0]["declaredCost"];
  target: { provider: string; model: string; agentId?: string; sessionKey?: string };
  onUsage?: (usage: LlmCompleteUsage) => void;
}): LlmCompleteUsage {
  // SAFETY: normalizeUsage narrows each optional provider counter before returning typed facts.
  const normalized = normalizeUsage(params.rawUsage as UsageLike | undefined);
  const costConfig =
    params.estimate === "none"
      ? undefined
      : resolveModelCostConfig({
          provider: params.target.provider,
          model: params.target.model,
          config: params.cfg,
        });
  // Isolated runtimes may report a whole run; only direct calls retain tier boundaries here.
  const estimateCost =
    params.estimate === "direct" ? estimateUsageCost : estimateAggregateUsageCost;
  const explicitCostUsd = readExplicitCostUsd(params.rawUsage);
  const costUsd =
    explicitCostUsd ??
    (params.declaredCost
      ? estimateUsageCost({ usage: normalized, declaredCost: params.declaredCost })
      : params.estimate === "none"
        ? undefined
        : estimateCost({ usage: normalized, cost: costConfig }));
  const usage: LlmCompleteUsage = {
    ...(normalized?.input !== undefined ? { inputTokens: normalized.input } : {}),
    ...(normalized?.output !== undefined ? { outputTokens: normalized.output } : {}),
    ...(normalized?.cacheRead !== undefined ? { cacheReadTokens: normalized.cacheRead } : {}),
    ...(normalized?.cacheWrite !== undefined ? { cacheWriteTokens: normalized.cacheWrite } : {}),
    ...(normalized?.total !== undefined ? { totalTokens: normalized.total } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
  params.onUsage?.(usage);
  const input = normalized?.input ?? 0;
  const output = normalized?.output ?? 0;
  const cacheRead = normalized?.cacheRead ?? 0;
  const cacheWrite = normalized?.cacheWrite ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;
  const total = normalized?.total ?? promptTokens + output;
  const hasPositiveUsage = [input, output, cacheRead, cacheWrite, total, usage.costUsd].some(
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  // Explicit billed zero and sparse native counters are observations, unlike empty
  // chat adapter snapshots. Keep the ordinary no-evidence suppression for those.
  const hasObservedUsage =
    hasPositiveUsage ||
    explicitCostUsd !== undefined ||
    (params.estimate === "none" && normalized !== undefined);
  if (params.suppressUsage !== true && isDiagnosticsEnabled(params.cfg) && hasObservedUsage) {
    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent(
        {
          type: "model.usage",
          ...(params.target.sessionKey ? { sessionKey: params.target.sessionKey } : {}),
          agentId: params.target.agentId,
          provider: params.target.provider,
          model: params.target.model,
          usage:
            params.estimate === "none"
              ? {
                  ...(normalized?.input !== undefined ? { input } : {}),
                  ...(normalized?.output !== undefined ? { output } : {}),
                  ...(normalized?.cacheRead !== undefined ? { cacheRead } : {}),
                  ...(normalized?.cacheWrite !== undefined ? { cacheWrite } : {}),
                  ...(normalized?.total !== undefined ? { total: normalized.total } : {}),
                }
              : { input, output, cacheRead, cacheWrite, promptTokens, total },
          ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}),
        },
        params.hostPluginId,
      ),
    );
  }
  return usage;
}
