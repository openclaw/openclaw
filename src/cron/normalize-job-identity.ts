/**
 * Align on-disk cron job identity with the canonical `id` field used by the scheduler.
 * Hand-edited or legacy JSON may use `jobId` without `id`; Gateway/API tools often refer to
 * the stable name as `jobId` in payloads while persisted jobs use `id`.
 */
export function normalizeCronJobIdentityFields(raw: Record<string, unknown>): {
  mutated: boolean;
  /** Matches doctor `normalizeStoredCronJobs` jobId issue bucket (alias migration or removal). */
  legacyJobIdIssue: boolean;
} {
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
  const legacyJobId = typeof raw.jobId === "string" ? raw.jobId.trim() : "";
  const hadJobIdKey = "jobId" in raw;

  let mutated = false;

  if (!rawId && legacyJobId) {
    raw.id = legacyJobId;
    mutated = true;
  } else if (rawId && raw.id !== rawId) {
    raw.id = rawId;
    mutated = true;
  }
  if (hadJobIdKey) {
    delete raw.jobId;
    mutated = true;
  }

  const legacyJobIdIssue = Boolean((!rawId && legacyJobId) || hadJobIdKey);
  return { mutated, legacyJobIdIssue };
}
