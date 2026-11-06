import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { FAILOVER_REASONS } from "../../packages/gateway-protocol/src/failover-reasons.js";

type FailoverReason = (typeof FAILOVER_REASONS)[number];

/** The provider fact that ended a run, as the run's error observation classified it. */
export type RunFailureCause = { provider?: string; failoverReason?: FailoverReason };

/** A diagnostic-only display row owned by the settled run, not a model attempt. */
export type RunFailureNotice = { runId: string; summary: string; cause?: RunFailureCause };

const PROVIDER_ID_MAX_CHARS = 120;

/** Keeps only the bounded provider id and known failover reason from an observation. */
export function readRunFailureCause(value: unknown): RunFailureCause | undefined {
  const source = asOptionalRecord(value);
  const provider =
    typeof source?.provider === "string" &&
    source.provider.trim() &&
    source.provider.length <= PROVIDER_ID_MAX_CHARS
      ? source.provider.trim()
      : undefined;
  const failoverReason = FAILOVER_REASONS.find((reason) => reason === source?.failoverReason);
  return provider || failoverReason
    ? { ...(provider ? { provider } : {}), ...(failoverReason ? { failoverReason } : {}) }
    : undefined;
}

export function readRunFailureNotice(message: unknown): RunFailureNotice | undefined {
  const notice = asOptionalRecord(asOptionalRecord(message)?.openclawRunError);
  if (
    typeof notice?.runId !== "string" ||
    !notice.runId.trim() ||
    typeof notice.summary !== "string" ||
    !notice.summary.trim()
  ) {
    return undefined;
  }
  const cause = readRunFailureCause(notice.cause);
  return { runId: notice.runId, summary: notice.summary, ...(cause ? { cause } : {}) };
}
