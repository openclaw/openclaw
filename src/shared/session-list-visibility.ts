import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Display/discovery classification; routing validates canonical keys separately. */
export function isCronSessionDisplayKey(key: string): boolean {
  // Display keys historically ignore empty segments and accept whitespace owners.
  // Match those nonempty segments directly, without allocating an array per row.
  return /^(?:cron:|agent::*[^:]+:+cron:+[^:])/u.test(normalizeLowercaseStringOrEmpty(key));
}

/**
 * Classify internal lanes from provenance or reserved keys, never transcript text.
 * Legacy rows without either and operator-named CLI sessions remain discoverable.
 * Cron rows belong to the separate automation filter even when a system created them.
 */
export function isSystemCreatedSessionRow(row: {
  key: string;
  createdActor?: { type: string };
  createdVia?: string;
  label?: string;
  displayName?: string;
  subject?: string;
  classification?: string;
}): boolean {
  if (isCronSessionDisplayKey(row.key)) {
    return false;
  }
  // Recall rows predate creation provenance. Their producer-owned suffix also
  // identifies existing rows while the recall is running or awaiting cleanup.
  if (/^agent:[^:]+:(?:.+:)?active-memory:[a-f0-9]{12}$/iu.test(row.key.trim())) {
    return true;
  }
  // Isolated heartbeat lanes are Gateway-owned background work surfaced with a
  // recorded classification. Hide them from default views, while keeping
  // operator-named lanes discoverable and reachable via the system toggle.
  if (row.classification === "heartbeat") {
    return !(row.label?.trim() || row.displayName?.trim() || row.subject?.trim());
  }
  if (row.createdActor?.type === "system") {
    return true;
  }
  if (row.createdVia !== "run" && row.createdVia !== "internal") {
    return false;
  }
  if (row.createdActor?.type === "human") {
    return false;
  }
  return !(row.label?.trim() || row.displayName?.trim() || row.subject?.trim());
}
