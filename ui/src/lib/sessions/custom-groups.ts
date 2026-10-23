// Catalog storage and member updates live on the gateway (sessions.groups.*);
// the SessionCapability mirrors the catalog into state.groups.
import type {
  SessionGroup,
  SessionGroupDefaults,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";

const BUILT_IN_SESSION_SECTION_IDS = new Set(["ungrouped", "groups", "work"]);

export type SessionGroupSettings = SessionGroup & SessionGroupDefaults;

/** Replace defaults from a complete snapshot, retaining only catalog names and positions. */
export function mergeSessionGroupDefaults(
  groups: readonly SessionGroupSettings[],
  values: readonly SessionGroupDefaults[],
): SessionGroupSettings[] {
  const defaults = new Map(
    values.map(({ name, cwd, worktree }) => [
      name,
      {
        ...(cwd === undefined ? {} : { cwd }),
        ...(worktree === undefined ? {} : { worktree }),
      },
    ]),
  );
  return groups.map(({ name, position }) => ({ name, position, ...defaults.get(name) }));
}

/** Validate and deduplicate a persisted partial section order. */
export function normalizeSessionSectionOrderTokens(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    const prefix = ["catalog:", "category:"].find((candidate) => trimmed.startsWith(candidate));
    const name = prefix ? trimmed.slice(prefix.length).trim() : "";
    const token = prefix
      ? name && `${prefix}${name}`
      : BUILT_IN_SESSION_SECTION_IDS.has(trimmed) && trimmed;
    if (token && !normalized.includes(token)) {
      normalized.push(token);
    }
  }
  return normalized;
}
