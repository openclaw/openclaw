// Shared tool-policy scope identification for doctor config migrations.

/**
 * Core-owned config roots only. plugins.entries.*.config is opaque plugin-owned
 * data; repairing tool policies there belongs to the owning plugin's doctor
 * contract (legacyConfigRules), never to a core migration.
 */
export const TOOL_POLICY_ROOTS = ["tools", "agents", "channels", "gateway"] as const;

/** True when a config path addresses a tool policy scope holding allow/alsoAllow/deny lists. */
export function isToolPolicyPath(path: readonly string[]): boolean {
  if (path.at(-1) === "tools" || path.includes("toolsBySender")) {
    return true;
  }
  const byProviderIndex = path.lastIndexOf("byProvider");
  return byProviderIndex >= 0 && path.slice(0, byProviderIndex).includes("tools");
}
