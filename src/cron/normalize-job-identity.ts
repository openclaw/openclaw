export function normalizeCronJobIdentityFields(raw: Record<string, unknown>): {
  mutated: boolean;
  legacyJobIdIssue: boolean;
} {
  const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
  const legacyJobId = typeof raw.jobId === "string" ? raw.jobId.trim() : "";
  const hadJobIdKey = "jobId" in raw;
  const normalizedId = rawId || legacyJobId;
  const idChanged = Boolean(normalizedId && raw.id !== normalizedId);

  if (idChanged) {
    raw.id = normalizedId;
  }
  if (hadJobIdKey) {
    delete raw.jobId;
  }
  return { mutated: idChanged || hadJobIdKey, legacyJobIdIssue: hadJobIdKey };
}
