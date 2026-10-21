import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import {
  capEntryCount,
  pruneStaleEntries,
  resolveMaintenanceConfigFromInput,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const recentKey = "agent:main:dashboard:recent";
const staleKey = "agent:main:dashboard:stale";
const preserveRecentMs = 7 * DAY_MS;

afterEach(() => resetPluginRuntimeStateForTest());

function entry(id: string, at: number, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: id, updatedAt: at, ...extra };
}

function installThrowingConversationResolver() {
  const resolveSessionConversation = vi.fn(() => {
    throw new Error("channel resolver must not run during session maintenance");
  });
  const plugin = { id: "broken", messaging: { resolveSessionConversation } };
  setActivePluginRegistry(createTestRegistry([{ pluginId: "broken", source: "test", plugin }]));
  return resolveSessionConversation;
}

it.each(["pruning", "capping"] as const)(
  "preserves external conversations during %s without invoking channel plugins",
  (boundary) => {
    const resolveSessionConversation = installThrowingConversationResolver();
    const updatedAt = Date.now() - 31 * DAY_MS;
    const protectedKeys = [
      "agent:main:broken:group:room:thread:reply",
      "agent:main:broken:channel:room:with:colon",
      "agent:main:telegram:direct:user:topic:77",
      "agent:main:telegram:dm:user:topic:77",
      "agent:main:opaque:thread:reply",
      "agent:main:broken:direct:peer",
      "agent:main:broken:account:direct:peer",
      "agent:main:direct:peer",
    ];
    const removableKeys = [
      "agent:main:old",
      "agent:main:subagent:worker:thread:reply",
      "agent:main:opaque:topic:unrelated",
    ];
    const store: Record<string, SessionEntry> = Object.fromEntries(
      [...protectedKeys, ...removableKeys].map((key) => [key, entry(key, updatedAt)]),
    );
    if (boundary === "pruning") {
      expect(pruneStaleEntries(store, 30 * DAY_MS, { log: false })).toBe(1);
    } else {
      expect(capEntryCount(store, protectedKeys.length, { log: false })).toBe(3);
    }
    for (const key of protectedKeys) {
      expect(store[key]).toEqual({ sessionId: key, updatedAt });
    }
    expect(resolveSessionConversation).not.toHaveBeenCalled();
  },
);

it("is opt-in and keeps recent interactive sessions through prune and cap pressure", () => {
  const now = Date.now();
  const syntheticKey = "agent:main:subagent:recent-worker";
  const store: Record<string, SessionEntry> = {
    [recentKey]: entry("recent", now - DAY_MS),
    [staleKey]: entry("stale", now - 8 * DAY_MS),
    [syntheticKey]: entry("synthetic", now - DAY_MS),
  };

  expect(
    ([undefined, { preserveRecent: false }, { preserveRecent: "7d" }] as const).map(
      (config) => resolveMaintenanceConfigFromInput(config).preserveRecentMs,
    ),
  ).toEqual([null, null, preserveRecentMs]);
  expect(pruneStaleEntries(store, 12 * 60 * 60 * 1000, { preserveRecentMs })).toBe(1);
  expect(store).toHaveProperty(recentKey);
  expect(store[staleKey]?.archivedAt).toEqual(expect.any(Number));
  expect(store).not.toHaveProperty(syntheticKey);

  store[staleKey] = entry("stale-2", now - 8 * DAY_MS);
  expect(capEntryCount(store, 1, { preserveRecentMs })).toBe(1);
  expect(store).toHaveProperty(recentKey);
  expect(store[staleKey]?.archivedAt).toEqual(expect.any(Number));
});

it("keeps recent and external sessions under disk pressure without invoking plugins", async () => {
  const resolveSessionConversation = installThrowingConversationResolver();
  await withTestDir({ prefix: "openclaw-preserve-recent-budget-" }, async (dir) => {
    const now = Date.now();
    const externalKey = "agent:main:broken:group:room:thread:reply";
    const store: Record<string, SessionEntry> = {
      [recentKey]: entry("recent", now),
      [staleKey]: entry("stale", now - 8 * DAY_MS, {
        archivedAt: now - 8 * DAY_MS,
        archiveReason: "active-session-cap",
      }),
      [externalKey]: entry("external", now - 9 * DAY_MS),
    };

    const result = await enforceSessionDiskBudget({
      store,
      storePath: path.join(dir, "sessions.json"),
      maintenance: { highWaterBytes: 1, maxDiskBytes: 1, preserveRecentMs },
      warnOnly: false,
    });

    expect(result?.removedEntries).toBe(1);
    expect(store).toHaveProperty(recentKey);
    expect(store).toHaveProperty(externalKey);
    expect(store).not.toHaveProperty(staleKey);
    expect(resolveSessionConversation).not.toHaveBeenCalled();
  });
});
