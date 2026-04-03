/**
 * Whitelist of plugin IDs allowed for silent message ingestion.
 *
 * NOTE: `ingest.hooks` values are treated as plugin IDs to target in the
 * `message_ingest` pipeline. Entries are first validated against this allowlist,
 * then dispatched only to matching plugin IDs (when installed + registered).
 * This prevents config-based escalation and avoids running unrelated ingest handlers.
 *
 * SECURITY: Only add hooks that are safe to run on untrusted/public messages.
 * Hooks listed here will process messages without user mention or LLM oversight.
 */
export const ALLOWED_INGEST_HOOKS = ["session-memory", "command-logger"] as const;

export type AllowedIngestHook = (typeof ALLOWED_INGEST_HOOKS)[number];

/**
 * Configuration for silent ingest: running hooks on non-mentioned group messages.
 */
export type IngestConfig = {
  /** Enable silent ingest for this group. */
  enabled: boolean;
  /** List of plugin IDs to run. Only ids in ALLOWED_INGEST_HOOKS are accepted. */
  hooks: AllowedIngestHook[];
};
