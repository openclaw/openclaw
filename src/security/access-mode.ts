import type { AccessMode } from "../config/types.base.js";

/**
 * Resolve effective access mode from config.
 * Supports new `accessMode` field with backward-compat fallback to `dmPolicy`.
 *
 * Mapping:
 *   dmPolicy "open"      → accessMode "open"
 *   dmPolicy "pairing"   → accessMode "subscribed"
 *   dmPolicy "allowlist"  → accessMode "subscribed"
 *   dmPolicy "disabled"  → accessMode "subscribed"
 *   (no config)          → "open" (default)
 */
export function resolveAccessMode(params: { accessMode?: string; dmPolicy?: string }): AccessMode {
  // Prefer explicit accessMode if set
  if (params.accessMode === "open" || params.accessMode === "subscribed") {
    return params.accessMode;
  }

  // Fall back to dmPolicy mapping
  if (params.dmPolicy) {
    switch (params.dmPolicy) {
      case "open":
        return "open";
      case "pairing":
      case "allowlist":
      case "disabled":
        return "subscribed";
      default:
        return "open";
    }
  }

  // Default
  return "open";
}

/**
 * Resolve whether group messages are enabled.
 * Checks `groupEnabled` first, falls back to legacy `groupPolicy`.
 *
 * Mapping:
 *   groupPolicy "open"      → true
 *   groupPolicy "disabled"  → false
 *   groupPolicy "allowlist" → true (allow-list still applies per-group)
 *   (no config)             → true (default)
 */
export function resolveGroupEnabled(params: {
  groupEnabled?: boolean;
  groupPolicy?: string;
}): boolean {
  // Prefer explicit groupEnabled if set
  if (typeof params.groupEnabled === "boolean") {
    return params.groupEnabled;
  }

  // Fall back to groupPolicy mapping
  if (params.groupPolicy) {
    return params.groupPolicy !== "disabled";
  }

  // Default
  return true;
}
