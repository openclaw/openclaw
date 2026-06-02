import { normalizeAgentId } from "../routing/session-key.js";

/** Resolves hook agent routing allowlist; undefined means unrestricted routing. */
export function resolveAllowedAgentIds(raw: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed = new Set<string>();
  let hasWildcard = false;
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      // Wildcard is intentionally represented as undefined, matching the
      // unconfigured policy path used by runtime hooks and security audits.
      hasWildcard = true;
      break;
    }
    allowed.add(normalizeAgentId(trimmed));
  }
  if (hasWildcard) {
    return undefined;
  }
  return allowed;
}
