import type { PresenceEntry } from "../api/types.ts";

export type PresenceViewer = {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
  watchedSessions: readonly string[];
};

export function readPresenceEntries(value: unknown): PresenceEntry[] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const presence = (value as { presence?: unknown }).presence;
  return Array.isArray(presence) ? (presence as PresenceEntry[]) : undefined;
}

function normalized(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function firstSorted(values: Iterable<string | null | undefined>): string | undefined {
  return [...values]
    .map(normalized)
    .filter((value): value is string => value !== undefined)
    .toSorted()[0];
}

export function projectPresenceViewers(
  entries: readonly PresenceEntry[],
  selfInstanceId?: string,
): { users: readonly PresenceViewer[]; selfUserId?: string } {
  const grouped = new Map<string, PresenceEntry[]>();
  let selfUserId: string | undefined;
  for (const entry of entries) {
    if (entry.reason === "disconnect" || !entry.user?.id) {
      continue;
    }
    const userId = entry.user.id;
    const existing = grouped.get(userId);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(userId, [entry]);
    }
    if (selfInstanceId && entry.instanceId === selfInstanceId) {
      selfUserId = userId;
    }
  }
  const users = [...grouped.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, userEntries]) => ({
      id,
      name: firstSorted(userEntries.map((entry) => entry.user?.name)),
      email: firstSorted(userEntries.map((entry) => entry.user?.email)),
      avatarUrl: firstSorted(userEntries.map((entry) => entry.user?.avatarUrl)),
      watchedSessions: [
        ...new Set(userEntries.flatMap((entry) => entry.watchedSessions ?? [])),
      ].toSorted(),
    }));
  return { users, selfUserId };
}
