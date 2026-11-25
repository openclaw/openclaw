import {
  hasNonzeroUsage,
  normalizeUsage,
  type NormalizedUsage,
  type UsageLike,
} from "../agents/usage.js";

type AgentRunUsageMeta = {
  usage?: UsageLike;
  lastCallUsage?: UsageLike;
};

/** An explicit aggregate report owns completeness; legacy counters may use the last call. */
export function resolveAgentRunUsage(result: unknown): NormalizedUsage | undefined {
  const agentMeta = (result as { meta?: { agentMeta?: AgentRunUsageMeta } } | null)?.meta
    ?.agentMeta;
  const aggregate = normalizeUsage(agentMeta?.usage);
  if (aggregate?.usageReport || hasNonzeroUsage(aggregate)) {
    return aggregate;
  }
  const lastCall = normalizeUsage(agentMeta?.lastCallUsage);
  if (hasNonzeroUsage(lastCall)) {
    return lastCall;
  }
  return aggregate ?? lastCall;
}
