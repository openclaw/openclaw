/**
 * Whitelist of hook names allowed for silent message ingestion.
 * 
 * NOTE: This validates config-level hook names only. The actual hooks that run
 * are determined by what plugins are installed and registered in the hook registry.
 * This whitelist prevents config-based attacks but doesn't control plugin installation.
 * 
 * SECURITY: Only add hooks that are safe to run on untrusted/public messages.
 * Hooks listed here will process messages without user mention or LLM oversight.
 */
export const ALLOWED_INGEST_HOOKS = ["session-memory", "command-logger"] as const;

export type AllowedIngestHook = typeof ALLOWED_INGEST_HOOKS[number];
