import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Run failure code: the harness runtime must be updated; clients may offer a new session elsewhere. */
export const HARNESS_UPDATE_REQUIRED_CODE = "harness_update_required";

/** The provider fact that ended a run, as the run's error observation classified it. */
export type RunFailureCause = {
  provider: string;
  failoverReason?: string;
  code?: typeof HARNESS_UPDATE_REQUIRED_CODE;
};

/** A diagnostic-only display row owned by the settled run, not a model attempt. */
export type RunFailureNotice = { runId: string; summary: string; cause?: RunFailureCause };

// Provider ids and failover reason codes are short identifiers; anything longer is not one.
const readCauseField = (value: unknown) =>
  typeof value === "string" && value.length <= 120 ? value.trim() || undefined : undefined;

/**
 * Keeps only a bounded provider id and failover reason from an error observation, plus the
 * host-authored update code (observation `providerErrorCode`, recorded cause `code`).
 */
export function readRunFailureCause(value: unknown): RunFailureCause | undefined {
  const source = asOptionalRecord(value);
  const provider = readCauseField(source?.provider);
  const failoverReason = readCauseField(source?.failoverReason);
  const updateRequired = [source?.code, source?.providerErrorCode].includes(
    HARNESS_UPDATE_REQUIRED_CODE,
  );
  return provider
    ? {
        provider,
        ...(failoverReason && { failoverReason }),
        ...(updateRequired && { code: HARNESS_UPDATE_REQUIRED_CODE }),
      }
    : undefined;
}

export function readRunFailureNotice(
  message: unknown,
  options?: { audience: "desktop" },
): RunFailureNotice | undefined {
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
  const summary =
    options?.audience === "desktop" &&
    typeof notice.desktopSummary === "string" &&
    notice.desktopSummary.trim()
      ? notice.desktopSummary
      : notice.summary;
  return { runId: notice.runId, summary, ...(cause ? { cause } : {}) };
}
