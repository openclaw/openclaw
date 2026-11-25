import { presenceUserKey } from "../../../src/shared/presence-user.ts";
import {
  presenceViewerActivity,
  presenceViewerLabel,
  type PresenceViewer,
} from "../lib/presence-users.ts";
import type { SidebarPeopleSortMode, SidebarPeopleStatusFilter } from "./sidebar-people.ts";

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
    offlineUsers = [],
    presenceFilter = "online",
    counts,
    countsFailed = false,
    sortMode,
    statusFilter,
    presentation = "live",
    now = Date.now(),
  }: {
    users: readonly PresenceViewer[] | null;
    offlineUsers?: readonly PresenceViewer[];
    presenceFilter?: "online" | "all";
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
    const activityOrder = { active: 0, idle: 1, unknown: 2, offline: 3 };
    const activity = (user: PresenceViewer) =>
      user.entries?.length === 0 ? "offline" : presenceViewerActivity(user, now);
    const compare = (a: PresenceViewer, b: PresenceViewer) => {
      const order =
        sortMode === "presence"
          ? activityOrder[activity(a)] - activityOrder[activity(b)] || running(b) - running(a)
          : sortMode === "name"
            ? 0
            : (countsFor(b)?.[sortMode] ?? -1) - (countsFor(a)?.[sortMode] ?? -1);
      return (
        order ||
        presenceViewerLabel(a).localeCompare(presenceViewerLabel(b), undefined, {
          sensitivity: "base",
        })
      );
    };
    // Snapshot order is a recorded display fact; only live presence admits clock-based sorting.
    const sorted =
      presentation === "snapshot" || users === null
        ? (users ?? this.users)
        : users.toSorted(compare);
    // Retain the recorded online list for warm sidebar snapshots.
    if (
      this.users.length !== sorted.length ||
      sorted.some((user, index) => user !== this.users[index])
    ) {
      this.users = sorted;
    }
    let listUsers = this.users;
    if (presenceFilter === "all") {
      const onlineKeys = new Set(this.users.map(presenceUserKey));
      listUsers = [
        ...this.users,
        ...offlineUsers.filter((user) => !onlineKeys.has(presenceUserKey(user))),
      ].toSorted(compare);
    }
    return {
      users: this.users,
      listUsers:
        statusFilter === "running" ? listUsers.filter((user) => running(user) > 0) : listUsers,
      counts: this.counts,
    };
  }
}
