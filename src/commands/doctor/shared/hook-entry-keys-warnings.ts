import type { OpenClawConfig } from "../../config/types.openclaw.js";

/**
 * Collect warnings for hook entries that use keys that are not recognized
 * by the hook discovery/loading system.
 *
 * Currently the only entry types that actually load handlers are those defined
 * by a discovered hook directory (bundled, managed, or workspace). The only
 * recognized config key for entries is `enabled` + `env`.
 *
 * Configured keys such as `handler`, `extraDirs`, or `installs` directly under
 * an entry are silently ignored — the entry is treated as enabled but no handler
 * is ever loaded, because the hook name doesn't match any discovered hook.
 */
export function collectUnknownHookEntryKeysWarnings(cfg: OpenClawConfig): string[] {
  const entries = cfg.hooks?.internal?.entries;
  if (!entries || typeof entries !== "object") {
    return [];
  }

  // Known keys that have runtime effect when placed under an entry
  const KNOWN_ENTRY_KEYS = new Set(["enabled", "env"]);

  const warnings: string[] = [];

  for (const [entryName, entryValue] of Object.entries(entries)) {
    if (!entryValue || typeof entryValue !== "object") {
      continue;
    }

    // Only check top-level entry keys (not nested properties)
    // The passthrough on HookConfigSchema means Zod doesn't reject extra keys,
    // and the loader only looks at hook name + enabled flag from the discovered hook registry.
    const extraKeys = Object.keys(entryValue as object).filter((key) => !KNOWN_ENTRY_KEYS.has(key));

    if (extraKeys.length === 0) {
      continue;
    }

    warnings.push(
      `- hooks.internal.entries["${entryName}"]: contains unrecognized key(s) [${extraKeys.map((k) => `"${k}"`).join(", ")}]. ` +
        'Only the hook name (matching a discovered hook directory) and the "enabled" flag are used; ' +
        'keys such as "handler", "extraDirs", "installs" have no effect here. ' +
        "To configure a hook, add the hook name to hooks.internal.entries and ensure the hook " +
        "is discoverable (bundled, managed, or workspace hook directory with HOOK.md). " +
        "See https://docs.openclaw.ai/automation/hooks for the supported configuration shape.",
    );
  }

  return warnings;
}
