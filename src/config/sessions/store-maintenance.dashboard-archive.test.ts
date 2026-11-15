import { expect, it } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import {
  archiveStaleDashboardEntries,
  resolveMaintenanceConfigFromInput,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = 40 * DAY_MS;

function entry(updatedAt: number, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: `session-${updatedAt}`, updatedAt, ...extra };
}
function archive(store: Record<string, SessionEntry>, preservedKey: string) {
  return archiveStaleDashboardEntries(store, 7 * DAY_MS, {
    nowMs: now,
    preserveKeys: new Set([preservedKey]),
  });
}

it("uses the latest activity signal and preserves active keys", () => {
  const staleKey = "agent:main:dashboard:stale";
  const activeKey = "agent:main:dashboard:active";
  const preservedKey = "agent:main:dashboard:preserved";
  const store = {
    [staleKey]: entry(now - 10 * DAY_MS, {
      lastActivityAt: now - 9 * DAY_MS,
      lastInteractionAt: now - 8 * DAY_MS,
      sessionStartedAt: now - 20 * DAY_MS,
    }),
    [activeKey]: entry(now - 10 * DAY_MS, { lastInteractionAt: now - DAY_MS }),
    [preservedKey]: entry(now - 10 * DAY_MS),
  };

  expect(archive(store, preservedKey)).toBe(1);
  expect(store[staleKey]).toMatchObject({ archivedAt: now, archiveReason: "stale-dashboard" });
  expect(store[activeKey]?.archivedAt).toBeUndefined();
  expect(store[preservedKey]?.archivedAt).toBeUndefined();
});

it("leaves protected and non-dashboard sessions untouched", () => {
  const store: Record<string, SessionEntry> = {
    "agent:main:dashboard:pinned": entry(1, { pinnedAt: 2 }),
    "agent:main:dashboard:archived": entry(1, { archivedAt: now - DAY_MS }),
    "agent:main:dashboard:running": entry(1),
    "agent:main:dashboard:locked": entry(1, { modelSelectionLocked: true }),
    "agent:main:main": entry(1),
    "agent:main:slack:channel:C1": entry(1),
    "agent:main:subagent:child": entry(1),
    "dashboard:unscoped": entry(1),
  };

  const before = structuredClone(store);
  expect(archive(store, "agent:main:dashboard:running")).toBe(0);
  expect(store).toEqual(before);
});

it("supports the default and both disable values", () => {
  expect(
    ([undefined, { archiveDashboardAfter: false }, { archiveDashboardAfter: 0 }] as const).map(
      (config) => resolveMaintenanceConfigFromInput(config).archiveDashboardAfterMs,
    ),
  ).toEqual([7 * DAY_MS, null, null]);
});

it.each([
  ["enforce", 31],
  ["warn", 10],
] as const)("dashboard archival respects %s mode before pruning", async (mode, ageDays) => {
  const key = "agent:main:dashboard:stale";
  const store = { [key]: entry(Date.now() - ageDays * DAY_MS) };
  await applyFileBackedSessionStoreMaintenance({
    storePath: "/tmp/openclaw-sessions/sessions.json",
    store,
    maintenanceConfig: resolveMaintenanceConfigFromInput({
      mode,
      pruneAfter: "30d",
      archiveDashboardAfter: "7d",
      maxDiskBytes: false,
    }),
    log: { warn: () => {}, info: () => {} },
    artifacts: {
      archiveRemovedSessionTranscripts: async () => new Set<string>(),
      cleanupArchivedSessionTranscripts: async () => {},
    },
  });
  expect(store[key]?.archivedAt).toEqual(mode === "enforce" ? expect.any(Number) : undefined);
  expect(store[key]?.archiveReason).toBe(mode === "enforce" ? "stale-dashboard" : undefined);
});
