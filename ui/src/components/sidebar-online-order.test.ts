import { describe, expect, it } from "vitest";
import type { PresenceViewer } from "../lib/presence-users.ts";
import { SidebarOnlineOrder, type SidebarOnlineCount } from "./sidebar-online-order.ts";

const viewer = (id: string, name: string): PresenceViewer => ({
  id,
  identity: { type: "profile", id },
  name,
  watchedSessions: [],
});
const ada = viewer("ada", "Ada");
const zed = viewer("zed", "Zed");
const NOW = 1_000_000;
const activeAda = { ...ada, entries: [{ ts: NOW, lastActivityAt: NOW }] };
const idleZed = { ...zed, entries: [{ ts: NOW, lastActivityAt: NOW - 180_000 }] };
const counts = new Map<string, SidebarOnlineCount>([
  ["ada", { open: 2, running: 0 }],
  ["zed", { open: 5, running: 1 }],
]);
const names = (users: readonly PresenceViewer[]) => users.map((user) => user.name);
function restoredOrder(users = [zed, ada]) {
  const order = new SidebarOnlineOrder();
  order.restore(users, counts);
  return order;
}

describe("sidebar online ordering", () => {
  it("retains snapshot order through pending counts and an unchanged live summary", () => {
    const order = restoredOrder();
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
    const order = restoredOrder();
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
      const users = [activeAda, idleZed];
      const order = restoredOrder(users);
      const options = {
        sortMode: "presence",
        statusFilter: "all",
        now: NOW + 180_000,
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
    const options = { users: [idleZed, activeAda], statusFilter: "all", now: NOW } as const;
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
    const order = restoredOrder();
    order.clear();
    const empty = order.resolve({
      users: null,
      counts: null,
      sortMode: "presence",
      statusFilter: "all",
    });
    expect(empty).toMatchObject({ users: [], counts: null });
  });
});
