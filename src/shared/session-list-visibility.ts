import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Display/discovery classification; routing validates canonical keys separately. */
export function isCronSessionDisplayKey(key: string): boolean {
  // Display keys historically ignore empty segments and accept whitespace owners.
  // Match those nonempty segments directly, without allocating an array per row.
  return /^(?:cron:|agent::*[^:]+:+cron:+[^:])/u.test(normalizeLowercaseStringOrEmpty(key));
}

/**
 * Classify probes from recorded provenance, never transcript text. Legacy rows
 * without provenance and operator-named CLI sessions remain discoverable. Cron
 * rows belong to the separate automation filter even when a system created them.
 */
export function isSystemCreatedSessionRow(row: {
  key: string;
  createdActor?: { type: string };
  createdVia?: string;
  label?: string;
  displayName?: string;
  subject?: string;
}): boolean {
  if (isCronSessionDisplayKey(row.key)) {
    return false;
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
