// Pure helpers for custom session groups and their sidebar section tokens.
// Catalog storage and member updates live on the gateway (sessions.groups.*);
// the SessionCapability mirrors the catalog into state.groups.

const BUILT_IN_SESSION_SECTION_IDS = new Set(["ungrouped", "groups", "work"]);

export type SessionGroupSettings = {
  name: string;
  position: number;
  cwd?: string;
  worktree?: boolean;
};

export function readSessionCustomGroups(payload: unknown): SessionGroupSettings[] {
  const groups = (payload as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) {
    return [];
  }
  return groups.flatMap((entry, index) => {
    const group = entry as Record<string, unknown> | null;
    const name = typeof group?.name === "string" ? group.name.trim() : "";
    if (!name) {
      return [];
    }
    return [
      {
        name,
        position:
          typeof group?.position === "number" && Number.isSafeInteger(group.position)
            ? group.position
            : index,
      },
    ];
  });
}

/** Replace defaults from a complete snapshot, retaining only catalog names and positions. */
export function mergeSessionGroupDefaults(
  groups: readonly SessionGroupSettings[],
  payload: unknown,
): SessionGroupSettings[] {
  const values = (payload as { defaults?: unknown } | null)?.defaults;
  const defaults = new Map<string, { cwd?: string; worktree?: boolean }>();
  if (Array.isArray(values)) {
    for (const value of values) {
      const record = value as Record<string, unknown> | null;
      const name = typeof record?.name === "string" ? record.name.trim() : "";
      if (!name) {
        continue;
      }
      const cwd = typeof record?.cwd === "string" ? record.cwd.trim() : "";
      defaults.set(name, {
        ...(cwd ? { cwd } : {}),
        ...(typeof record?.worktree === "boolean" ? { worktree: record.worktree } : {}),
      });
    }
  }
  return groups.map(({ name, position }) => ({ name, position, ...defaults.get(name) }));
}

export function readSidebarSectionOrder(payload: unknown): string[] {
  return (
    normalizeSessionSectionOrderTokens(
      (payload as { sectionOrder?: unknown } | null)?.sectionOrder,
    ) ?? []
  );
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
