import { normalizeAgentId } from "../routing/session-key.js";

/** Resolves configured hook agent ids, or undefined when all agents are allowed. */
export function resolveAllowedAgentIds(raw: string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(raw)) {
    return undefined;
  }
  const allowed = new Set<string>();
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === "*") {
      return undefined;
    }
    allowed.add(normalizeAgentId(trimmed));
  }
  return allowed;
}
