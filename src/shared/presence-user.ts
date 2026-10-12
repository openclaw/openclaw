import { normalizeOptionalString as normalized } from "@openclaw/normalization-core/string-coerce";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";

export type PresenceUserGroup = NonNullable<PresenceEntry["user"]> & {
  watchedSessions: readonly string[];
  entries: readonly PresenceEntry[];
};

function firstSorted(values: Iterable<string | null | undefined>): string | undefined {
  return [...values]
    .map(normalized)
    .filter((value): value is string => value !== undefined)
    .toSorted()[0];
}

function presenceEntrySortKey(entry: PresenceEntry): string {
  return [
    normalized(entry.host) ?? "",
    normalized(entry.platform) ?? "",
    normalized(entry.deviceFamily) ?? "",
    normalized(entry.instanceId) ?? "",
    String(entry.ts ?? 0).padStart(16, "0"),
  ].join("\u0000");
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Presence namespaces come from recorded identity, never display metadata or raw-id shape. */
export function presenceUserKey(
  user: Pick<NonNullable<PresenceEntry["user"]>, "id" | "identity">,
): string {
  return user.identity ? `profile:${user.identity.id}` : `raw:${user.id}`;
}

/** Online people use the identity namespace established by authentication. */
export function groupPresenceUsers(entries: readonly PresenceEntry[]): {
  users: readonly PresenceUserGroup[];
} {
  const grouped = new Map<string, PresenceEntry[]>();
  for (const entry of entries) {
    if (entry.reason === "disconnect" || !entry.user?.id) {
      continue;
    }
    const key = presenceUserKey(entry.user);
    const existing = grouped.get(key);
    if (existing) {
      existing.push(entry);
    } else {
      grouped.set(key, [entry]);
    }
  }
  return {
    users: [...grouped.entries()]
      .toSorted(([a], [b]) => compareText(a, b))
      .map(([, userEntries]) => ({
        id: userEntries[0]!.user!.id,
        identity: userEntries[0]!.user!.identity,
        name: firstSorted(userEntries.map((entry) => entry.user?.name)),
        email: firstSorted(userEntries.map((entry) => entry.user?.email)),
        avatarUrl: firstSorted(userEntries.map((entry) => entry.user?.avatarUrl)),
        watchedSessions: [
          ...new Set(userEntries.flatMap((entry) => entry.watchedSessions ?? [])),
        ].toSorted(),
        entries: userEntries.toSorted((a, b) =>
          compareText(presenceEntrySortKey(a), presenceEntrySortKey(b)),
        ),
      })),
  };
}
