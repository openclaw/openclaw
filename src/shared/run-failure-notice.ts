import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

/** Run failure code: the harness runtime must be updated; clients may offer a new session elsewhere. */
export const HARNESS_UPDATE_REQUIRED_CODE = "harness_update_required";

/** Bounded classification facts retained by the failed run. */
export type RunFailureCause = {
  provider?: string;
  failoverReason?: string;
  providerRuntimeFailureKind?: string;
  errorKind?: string;
  stopReason?: string;
  code?: typeof HARNESS_UPDATE_REQUIRED_CODE | "model_request_policy_denied";
};

/** A diagnostic-only display row owned by the settled run, not a model attempt. */
export type RunFailureNotice = { runId: string; summary: string; cause?: RunFailureCause };

// Provider ids and failover reason codes are short identifiers; anything longer is not one.
const readCauseField = (value: unknown) =>
  typeof value === "string" && value.length <= 120 ? value.trim() || undefined : undefined;

/**
 * Keeps bounded classification fields and known recovery codes, never raw provider diagnostics.
 */
export function readRunFailureCause(value: unknown): RunFailureCause | undefined {
  const source = asOptionalRecord(value);
  const cause: RunFailureCause = {
    provider: readCauseField(source?.provider),
    failoverReason: readCauseField(source?.failoverReason),
    providerRuntimeFailureKind: readCauseField(source?.providerRuntimeFailureKind),
    errorKind: readCauseField(source?.errorKind),
    stopReason: readCauseField(source?.stopReason),
    code: [source?.code, source?.providerErrorCode].find(
      (candidate): candidate is NonNullable<RunFailureCause["code"]> =>
        candidate === HARNESS_UPDATE_REQUIRED_CODE || candidate === "model_request_policy_denied",
    ),
  };
  return Object.values(cause).some(Boolean) ? cause : undefined;
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
