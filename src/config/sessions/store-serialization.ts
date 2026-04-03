/**
 * JSON.stringify replacer that excludes transient per-session fields which are
 * rebuilt from scratch on every gateway start.  Keeping them out of the on-disk
 * store prevents sessions.json from ballooning to tens of megabytes.
 *
 * NOTE: `systemPromptReport` is intentionally preserved because it carries
 * `bootstrapTruncation.warningSignaturesSeen` used for dedupe across restarts.
 */
export const SESSION_STORE_SERIALIZATION_REPLACER = (key: string, value: unknown): unknown =>
  key === "skillsSnapshot" ? undefined : value;
