import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** The provider fact that ended a run, as the run's error observation classified it. */
export type RunFailureCause = { provider: string; failoverReason?: string };

/** A diagnostic-only display row owned by the settled run, not a model attempt. */
export type RunFailureNotice = { runId: string; summary: string; cause?: RunFailureCause };

// Provider ids and failover reason codes are short identifiers; anything longer is not one.
const readCauseField = (value: unknown) =>
  typeof value === "string" && value.length <= 120 ? value.trim() || undefined : undefined;

/** Keeps only a bounded provider id and failover reason from an error observation. */
export function readRunFailureCause(value: unknown): RunFailureCause | undefined {
  const source = asOptionalRecord(value);
  const provider = readCauseField(source?.provider);
  const failoverReason = readCauseField(source?.failoverReason);
  return provider ? { provider, ...(failoverReason && { failoverReason }) } : undefined;
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
