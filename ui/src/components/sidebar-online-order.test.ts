import { describe, expect, it } from "vitest";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { SidebarOnlineOrder, type SidebarOnlineCount } from "./sidebar-online-order.ts";

const ada: PresenceViewer = {
  id: "ada",
  identity: { type: "profile", id: "ada" },
  name: "Ada",
  watchedSessions: [],
};
const zed: PresenceViewer = {
  id: "zed",
  identity: { type: "profile", id: "zed" },
  name: "Zed",
  watchedSessions: [],
};
const counts = new Map<string, SidebarOnlineCount>([
  ["ada", { open: 2, running: 0 }],
  ["zed", { open: 5, running: 1 }],
]);
const names = (users: readonly PresenceViewer[]) => users.map((user) => user.name);

describe("sidebar online ordering", () => {
  it("retains snapshot order through pending counts and an unchanged live summary", () => {
    const order = new SidebarOnlineOrder();
    order.restore([zed, ada], counts);
    const options = { sortMode: "presence", statusFilter: "all", now: 1 } as const;
    const cached = order.resolve({ ...options, users: null, counts: null });
    const pending = order.resolve({ ...options, users: [ada, zed], counts: null });
    const settled = order.resolve({ ...options, users: [ada, zed], counts: new Map(counts) });
    expect(names(cached.listUsers)).toEqual(["Zed", "Ada"]);
    expect(pending.listUsers).toBe(cached.listUsers);
    expect(settled.listUsers).toBe(cached.listUsers);

    const changed = order.resolve({
      ...options,
      users: [ada, zed],
      counts: new Map([
        ["ada", { open: 2, running: 1 }],
        ["zed", { open: 5, running: 0 }],
      ]),
    });
    expect(names(changed.listUsers)).toEqual(["Ada", "Zed"]);
  });

  it("keeps running-filter members while counts are pending, then accepts authoritative zero", () => {
    const order = new SidebarOnlineOrder();
    order.restore([zed, ada], counts);
    const options = { sortMode: "running", statusFilter: "running", now: 1 } as const;
    expect(names(order.resolve({ ...options, users: [ada, zed], counts: null }).listUsers)).toEqual(
      ["Zed"],
    );
    expect(order.resolve({ ...options, users: [ada, zed], counts: new Map() }).listUsers).toEqual(
      [],
    );
  });

  it.each(["pending", "snapshot"] as const)(
    "preserves saved presence order as activity expires during %s presentation",
    (presentation) => {
      const savedAt = 1_000_000;
      const activeAda = { ...ada, entries: [{ ts: savedAt, lastActivityAt: savedAt }] };
      const idleZed = {
        ...zed,
        entries: [{ ts: savedAt, lastActivityAt: savedAt - 180_000 }],
      };
      const users = [activeAda, idleZed];
      const order = new SidebarOnlineOrder();
      order.restore(users, counts);
      const options = {
        sortMode: "presence",
        statusFilter: "all",
        now: savedAt + 180_000,
        counts: null,
      } as const;
      const cached = order.resolve({
        ...options,
        users: presentation === "pending" ? null : users,
        presentation: presentation === "pending" ? "live" : "snapshot",
      });
      expect(names(cached.listUsers)).toEqual(["Ada", "Zed"]);
      const live = order.resolve({ ...options, users, presentation: "live" });
      expect(names(live.listUsers)).toEqual(["Zed", "Ada"]);
    },
  );

  it("ignores counts outside the selected sort key and retains active-before-idle grouping", () => {
    const order = new SidebarOnlineOrder();
    const now = 1_000_000;
    const activeAda = { ...ada, entries: [{ ts: now, lastActivityAt: now }] };
    const idleZed = { ...zed, entries: [{ ts: now, lastActivityAt: now - 180_000 }] };
    const options = { users: [idleZed, activeAda], statusFilter: "all", now } as const;
    expect(names(order.resolve({ ...options, sortMode: "presence", counts }).users)).toEqual([
      "Ada",
      "Zed",
    ]);
    const before = order.resolve({ ...options, sortMode: "open", counts });
    const after = order.resolve({
      ...options,
      sortMode: "open",
      counts: new Map([
        ["ada", { open: 2, running: 2 }],
        ["zed", { open: 5, running: 0 }],
      ]),
    });
    expect(names(after.listUsers)).toEqual(["Zed", "Ada"]);
    expect(after.listUsers).toBe(before.listUsers);
  });

  it("drops retained people and counts when the presentation scope changes", () => {
    const order = new SidebarOnlineOrder();
    order.restore([zed, ada], counts);
    order.clear();
    const empty = order.resolve({
      users: null,
      counts: null,
      sortMode: "presence",
      statusFilter: "all",
    });
    expect(empty.users).toEqual([]);
    expect(empty.counts).toBeNull();
  });
});
