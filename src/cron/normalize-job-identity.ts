import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export function normalizeCronJobIdentityFields(raw: Record<string, unknown>): {
  mutated: boolean;
  legacyJobIdIssue: boolean;
  backfilledMissingId: boolean;
} {
  const rawId = normalizeOptionalString(raw.id) ?? "";
  const legacyJobId = normalizeOptionalString(raw.jobId) ?? "";
  const hadJobIdKey = "jobId" in raw;
  let normalizedId = rawId || legacyJobId;
  // When neither `id` nor legacy `jobId` is present, synthesize a UUID so
  // downstream `jobs.find((entry) => entry.id === result.jobId)` cannot
  // collide on `undefined === undefined` and write every job's runtime
  // outcome into the first entry's slot. (#72849)
  let backfilledMissingId = false;
  if (!normalizedId) {
    normalizedId = randomUUID();
    backfilledMissingId = true;
  }
  const idChanged = raw.id !== normalizedId;

  if (idChanged) {
    raw.id = normalizedId;
  }
  if (hadJobIdKey) {
    delete raw.jobId;
  }
  return {
    mutated: idChanged || hadJobIdKey,
    legacyJobIdIssue: hadJobIdKey,
    backfilledMissingId,
  };
}
