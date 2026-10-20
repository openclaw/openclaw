import { describe, expect, it } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import {
  archiveStaleDashboardEntries,
  resolveMaintenanceConfigFromInput,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function entry(updatedAt: number, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: `session-${updatedAt}`, updatedAt, ...extra };
}

describe("archiveStaleDashboardEntries", () => {
  it("uses the latest activity signal and preserves active keys", () => {
    const now = 40 * DAY_MS;
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

    expect(
      archiveStaleDashboardEntries(store, 7 * DAY_MS, {
        nowMs: now,
        preserveKeys: new Set([preservedKey]),
      }),
    ).toBe(1);
    expect(store[staleKey]).toMatchObject({ archivedAt: now, archiveReason: "stale-dashboard" });
    expect(store[activeKey]?.archivedAt).toBeUndefined();
    expect(store[preservedKey]?.archivedAt).toBeUndefined();
  });

  it("leaves protected and non-dashboard sessions untouched", () => {
    const now = 40 * DAY_MS;
    const archivedAt = now - DAY_MS;
    const store: Record<string, SessionEntry> = {
      "agent:main:dashboard:pinned": entry(1, { pinnedAt: 2 }),
      "agent:main:dashboard:archived": entry(1, { archivedAt }),
      "agent:main:dashboard:running": entry(1),
      "agent:main:dashboard:locked": entry(1, { modelSelectionLocked: true }),
      "agent:main:main": entry(1),
      "agent:main:slack:channel:C1": entry(1),
      "agent:main:subagent:child": entry(1),
      "dashboard:unscoped": entry(1),
    };

    const before = structuredClone(store);
    expect(
      archiveStaleDashboardEntries(store, 7 * DAY_MS, {
        nowMs: now,
        preserveKeys: new Set(["agent:main:dashboard:running"]),
      }),
    ).toBe(0);
    expect(store).toEqual(before);
  });

  it("supports the default and both disable values", () => {
    expect(resolveMaintenanceConfigFromInput().archiveDashboardAfterMs).toBe(7 * DAY_MS);
    for (const archiveDashboardAfter of [false, 0] as const) {
      expect(
        resolveMaintenanceConfigFromInput({ archiveDashboardAfter }).archiveDashboardAfterMs,
      ).toBeNull();
    }
  });
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
  if (mode === "enforce") {
    expect(store[key]?.archiveReason).toBe("stale-dashboard");
  }
});
