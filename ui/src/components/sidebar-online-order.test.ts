import { expect, it } from "vitest";
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
const runningCounts = (adaRunning: number, zedRunning: number) =>
  new Map<string, SidebarOnlineCount>([
    ["ada", { open: 2, running: adaRunning }],
    ["zed", { open: 5, running: zedRunning }],
  ]);
const counts = runningCounts(0, 1);
const names = (users: readonly PresenceViewer[]) => users.map((user) => user.name);
function restoredOrder(users = [zed, ada]) {
  const order = new SidebarOnlineOrder();
  order.restore(users, counts);
  return {
    order,
    resolve: (options: Partial<Parameters<SidebarOnlineOrder["resolve"]>[0]> = {}) =>
      order.resolve({
        users: [ada, zed],
        counts: null,
        sortMode: "presence",
        statusFilter: "all",
        now: 1,
        ...options,
      }),
  };
}

it("retains snapshot order through pending counts and an unchanged live summary", () => {
  const { resolve } = restoredOrder();
  const cached = resolve({ users: null });
  const pending = resolve();
  const settled = resolve({ counts: new Map(counts) });
  expect(names(cached.listUsers)).toEqual(["Zed", "Ada"]);
  expect(pending.listUsers).toBe(cached.listUsers);
  expect(settled.listUsers).toBe(cached.listUsers);

  const changed = resolve({ counts: runningCounts(1, 0) });
  expect(names(changed.listUsers)).toEqual(["Ada", "Zed"]);
});

it("keeps running-filter members while counts are pending, then accepts authoritative zero", () => {
  const { resolve } = restoredOrder();
  const options = { sortMode: "running", statusFilter: "running" } as const;
  expect(names(resolve(options).listUsers)).toEqual(["Zed"]);
  expect(resolve({ ...options, counts: new Map() }).listUsers).toEqual([]);
});

it.each(["pending", "snapshot"] as const)(
  "preserves saved presence order as activity expires during %s presentation",
  (presentation) => {
    const users = [activeAda, idleZed];
    const { resolve } = restoredOrder(users);
    const now = NOW + 180_000;
    const cached = resolve({
      now,
      users: presentation === "pending" ? null : users,
      presentation: presentation === "pending" ? "live" : "snapshot",
    });
    expect(names(cached.listUsers)).toEqual(["Ada", "Zed"]);
    const live = resolve({ now, users, presentation: "live" });
    expect(names(live.listUsers)).toEqual(["Zed", "Ada"]);
  },
);

it("ignores counts outside the selected sort key and retains active-before-idle grouping", () => {
  const order = new SidebarOnlineOrder();
  const options = { users: [idleZed, activeAda], statusFilter: "all", now: NOW } as const;
  const grouped = order.resolve({ ...options, sortMode: "presence", counts });
  expect(names(grouped.users)).toEqual(["Ada", "Zed"]);
  const before = order.resolve({ ...options, sortMode: "open", counts });
  const after = order.resolve({ ...options, sortMode: "open", counts: runningCounts(2, 0) });
  expect(names(after.listUsers)).toEqual(["Zed", "Ada"]);
  expect(after.listUsers).toBe(before.listUsers);
});

it("drops retained people and counts when the presentation scope changes", () => {
  const { order, resolve } = restoredOrder();
  order.clear();
  expect(resolve({ users: null })).toMatchObject({ users: [], counts: null });
});
