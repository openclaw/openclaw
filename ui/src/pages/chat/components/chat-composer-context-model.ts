import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { asNullableObjectRecord as readCostRecord } from "@openclaw/normalization-core/record-coerce";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../../../../src/shared/transcript-only-openclaw-assistant.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import type { ApplicationGateway } from "../../../app/gateway.ts";
import { formatCompactTokenCount } from "../../../lib/format.ts";
import type { ProviderUsageDisplayProps } from "../../../lib/provider-quota-summary.ts";
import { resolveSessionContextLimit } from "../../../lib/sessions/context-budget.ts";

const CONTEXT_NOTICE_RATIO = 0.85;

export function latestAssistantProvider(messages: unknown[] | undefined): string | null {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = readCostRecord(messages?.[index]);
    if (message?.role !== "assistant" || isTranscriptOnlyOpenClawAssistantMessage(message)) {
      continue;
    }
    return typeof message.provider === "string" ? message.provider.trim() || null : null;
  }
  return null;
}

export function getContextNoticeViewModel(session: GatewaySessionRow | undefined) {
  const used = asNonNegativeFiniteNumber(session?.totalTokens);
  const { tokens: limit, fromLastPrompt } = resolveSessionContextLimit(session);
  if (used === undefined || !limit) {
    return null;
  }
  const approximate = session?.totalTokensFresh === false;
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  // A stale total is still useful orientation, but must not drive warning or
  // compaction decisions because the session may already have compacted.
  const warning = !approximate && ratio >= CONTEXT_NOTICE_RATIO;
  // Session rows expose the latest run snapshot; totalTokens is the separate context snapshot.
  const input = Number.isFinite(session?.inputTokens) ? (session?.inputTokens ?? null) : null;
  const output = Number.isFinite(session?.outputTokens) ? (session?.outputTokens ?? null) : null;
  const cost = asNonNegativeFiniteNumber(session?.estimatedCostUsd) ?? null;
  let color = "var(--muted)";
  let bg = "color-mix(in srgb, var(--muted) 8%, transparent)";
  if (warning) {
    const mix = Math.min(Math.max((ratio - CONTEXT_NOTICE_RATIO) / 0.1, 0), 1);
    color = `color-mix(in srgb, var(--warn), var(--danger) ${mix * 100}%)`;
    bg = `color-mix(in srgb, ${color} ${8 + 8 * mix}%, transparent)`;
  }
  return {
    pct,
    fromLastPrompt,
    used,
    limit,
    input,
    output,
    cost,
    detail: `${approximate ? "~" : ""}${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
    color,
    bg,
    warning,
    approximate,
  };
}

export type ContextNoticeProps = {
  messages?: unknown[];
  providerUsage?: ProviderUsageDisplayProps;
} & {
  session?: GatewaySessionRow;
  gateway?: ApplicationGateway;
  agentId?: string;
  onOpenContext?: () => void;
};
