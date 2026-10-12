import {
  presenceViewerActivity,
  presenceViewerLabel,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import type {
  SidebarPeopleSortMode,
  SidebarPeopleStatusFilter,
} from "./sidebar-people-controller.ts";

export type SidebarOnlineCount = { open: number; running: number };

export function sidebarOnlineCountFor(
  counts: ReadonlyMap<string, SidebarOnlineCount> | null,
  user: PresenceViewer,
): SidebarOnlineCount | null {
  return counts && user.identity?.type === "profile"
    ? (counts.get(user.identity.id) ?? { open: 0, running: 0 })
    : null;
}

/** Retains display sort inputs while the current connection's summary is pending. */
export class SidebarOnlineOrder {
  users: readonly PresenceViewer[] = [];
  counts: ReadonlyMap<string, SidebarOnlineCount> | null = null;

  restore(
    users: readonly PresenceViewer[],
    counts: ReadonlyMap<string, SidebarOnlineCount> | null,
  ): void {
    this.users = users;
    this.counts = counts;
  }

  clear(): void {
    this.restore([], null);
  }

  resolve({
    users,
    counts,
    countsFailed = false,
    sortMode,
    statusFilter,
    presentation = "live",
    now = Date.now(),
  }: {
    users: readonly PresenceViewer[] | null;
    counts: ReadonlyMap<string, SidebarOnlineCount> | null;
    countsFailed?: boolean;
    sortMode: SidebarPeopleSortMode;
    statusFilter: SidebarPeopleStatusFilter;
    presentation?: "snapshot" | "live";
    now?: number;
  }) {
    this.counts = countsFailed ? null : (counts ?? this.counts);
    const countsFor = (user: PresenceViewer) => sidebarOnlineCountFor(this.counts, user);
    const running = (user: PresenceViewer) => Number((countsFor(user)?.running ?? 0) > 0);
    const activityOrder = { active: 0, idle: 1, unknown: 2 };
    // Snapshot order is a recorded display fact; only live presence admits clock-based sorting.
    const sorted =
      presentation === "snapshot" || users === null
        ? (users ?? this.users)
        : users.toSorted((a, b) => {
            const order =
              sortMode === "presence"
                ? activityOrder[presenceViewerActivity(a, now)] -
                    activityOrder[presenceViewerActivity(b, now)] || running(b) - running(a)
                : sortMode === "name"
                  ? 0
                  : (countsFor(b)?.[sortMode] ?? -1) - (countsFor(a)?.[sortMode] ?? -1);
            return (
              order ||
              presenceViewerLabel(a).localeCompare(presenceViewerLabel(b), undefined, {
                sensitivity: "base",
              })
            );
          });
    // Stable facepile inputs avoid recreating its projection on unrelated updates.
    if (
      this.users.length !== sorted.length ||
      sorted.some((user, index) => user !== this.users[index])
    ) {
      this.users = sorted;
    }
    return {
      users: this.users,
      listUsers:
        statusFilter === "running" ? this.users.filter((user) => running(user) > 0) : this.users,
      counts: this.counts,
    };
  }
}
