// Session store pruning tests cover pruning decisions and retention ordering.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { saveLegacySessionStore as saveSessionStore } from "../../infra/state-migrations.legacy-session-store.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import { registerSessionMaintenancePreserveKeysProvider } from "./store-maintenance-preserve.js";
import {
  capEntryCount,
  countUnarchivedSessionEntries,
  pruneStaleEntries,
  pruneStaleModelRunEntries,
  resolveMaintenanceConfigFromInput,
  resolveQuotaSuspensionEntryMaintenance,
  shouldPreserveMaintenanceEntry,
  shouldRunModelRunPrune,
  shouldRunSessionEntryMaintenance,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

function isProtectedSessionMaintenanceEntry(key: string, entry: SessionEntry | undefined): boolean {
  return shouldPreserveMaintenanceEntry({ key, entry });
}

function resolveSessionEntryMaintenanceHighWater(maxEntries: number): number {
  let entryCount = 0;
  while (!shouldRunSessionEntryMaintenance({ entryCount, maxEntries })) {
    entryCount += 1;
  }
  return entryCount;
}

function createMaintenanceArtifacts() {
  return {
    archiveRemovedSessionTranscripts: async () => new Set<string>(),
    cleanupArchivedSessionTranscripts: async () => {},
  };
}

describe("pruneStaleEntries", () => {
  it.each([
    ["agent:main:dashboard:child", { spawnedBy: "agent:main:main" }, "age-retention"],
    ["agent:main:subagent:child", {}, undefined],
  ] as const)("drops a stale child pin on %s %j", (key, lineage, archiveReason) => {
    const stale = { ...makeEntry(Date.now() - 31 * DAY_MS), pinnedAt: 1, ...lineage };
    const store = makeStore([[key, stale]]);
    pruneStaleEntries(store, 30 * DAY_MS);
    expect(store[key]).toEqual(
      archiveReason ? expect.objectContaining({ archiveReason }) : undefined,
    );
  });

  it.each([["pinnedAt", "protected", {}]] as const)(
    "preserves %s on %s until protection is removed, then archives the same identity",
    (field, key, lineage) => {
      const now = Date.now();
      const original = { ...makeEntry(now - 31 * DAY_MS), [field]: now - DAY_MS, ...lineage };
      const store = makeStore([[key, { ...original }]]);

      expect(pruneStaleEntries(store, 30 * DAY_MS)).toBe(0);
      expect(store[key]).toEqual(original);

      delete store[key]?.[field];
      expect(pruneStaleEntries(store, 30 * DAY_MS)).toBe(0);
      expect(store[key]).toMatchObject({
        sessionId: original.sessionId,
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });
    },
  );
});

describe("resolveQuotaSuspensionEntryMaintenance", () => {
  it("returns an entry-scoped patch when a suspended session should resume", () => {
    const now = Date.now();
    const result = resolveQuotaSuspensionEntryMaintenance({
      entry: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 30_000,
          expectedResumeBy: now - 1,
          state: "suspended",
          reason: "quota_exhausted",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
        },
      },
      now,
      ttlMs: 30_000,
    });

    expect(result).toEqual({
      patch: {
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 30_000,
          expectedResumeBy: now - 1,
          state: "resuming",
          reason: "quota_exhausted",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
        },
      },
      cleared: false,
    });
  });

  it("returns an entry-scoped cleanup patch after the resume window expires", () => {
    const now = Date.now();
    const result = resolveQuotaSuspensionEntryMaintenance({
      entry: {
        ...makeEntry(now),
        quotaSuspension: {
          schemaVersion: 1,
          suspendedAt: now - 61_000,
          expectedResumeBy: now - 31_000,
          state: "active",
          reason: "circuit_open",
          failedProvider: "anthropic",
          failedModel: "claude-opus-4-6",
        },
      },
      now,
      ttlMs: 30_000,
    });

    expect(result).toEqual({
      patch: { quotaSuspension: undefined },
      cleared: true,
    });
  });
});

describe("applyFileBackedSessionStoreMaintenance", () => {
  const baseMaintenance = {
    mode: "enforce" as const,
    pruneAfterMs: 30 * DAY_MS,
    maxEntries: 500,
    modelRunPruneAfterMs: DAY_MS,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  };

  it("reports archive retention failure without aborting file-backed maintenance", async () => {
    const now = Date.now();
    const store = makeStore([
      ["agent:main:hook:stale", { sessionId: "stale-session", updatedAt: now - 30 * DAY_MS }],
      ["fresh", { sessionId: "fresh-session", updatedAt: now }],
    ]);
    const cleanupError = new Error("archive cleanup denied");
    const warn = vi.fn();

    await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      maintenanceConfig: {
        ...baseMaintenance,
        pruneAfterMs: 7 * DAY_MS,
        resetArchiveRetentionMs: 0,
      },
      log: { warn, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async () => new Set(),
        cleanupArchivedSessionTranscripts: async () => {
          throw cleanupError;
        },
      },
    });

    expect(store["agent:main:hook:stale"]).toBeUndefined();
    expect(store).toHaveProperty("fresh");
    expect(warn).toHaveBeenCalledWith("session transcript archive retention cleanup failed", {
      error: String(cleanupError),
    });
  });

  it.each([
    { modelRunPruneAfterMs: DAY_MS, modelRunPruned: 1, capped: 25, probePresent: false },
    { modelRunPruneAfterMs: 0, modelRunPruned: 0, capped: 26, probePresent: true },
  ])(
    "applies model-run retention $modelRunPruneAfterMs before high-water capping",
    async ({ modelRunPruneAfterMs, modelRunPruned, capped, probePresent }) => {
      const now = Date.now();
      const staleProbe = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174099";
      const store: Record<string, SessionEntry> = {
        [staleProbe]: makeEntry(now - 2 * DAY_MS),
      };
      for (let i = 0; i < 75; i++) {
        store[`agent:main:explicit:real-${i}`] = makeEntry(now - 3 * DAY_MS);
      }

      await applyFileBackedSessionStoreMaintenance({
        storePath: "/tmp/openclaw-sessions/sessions.json",
        store,
        maintenanceConfig: {
          ...baseMaintenance,
          pruneAfterMs: 7 * DAY_MS,
          maxEntries: 50,
          modelRunPruneAfterMs,
        },
        log: { warn: () => {}, info: () => {} },
        artifacts: {
          archiveRemovedSessionTranscripts: async () => new Set(),
          cleanupArchivedSessionTranscripts: async () => {},
        },
      });

      expect(
        Object.values(store).filter((entry) => entry.archiveReason === "active-session-cap"),
      ).toHaveLength(capped);
      expect(store[staleProbe] != null).toBe(probePresent);
      expect(Object.keys(store)).toHaveLength(76 - modelRunPruned);
      expect(countUnarchivedSessionEntries(store)).toBe(50);
      expect(Object.keys(store).filter((key) => key.includes(":real-"))).toHaveLength(75);
    },
  );

  it.each([
    {
      name: "preserves a cloud-owned session independently of the active writer",
      storeName: "active-cloud-placement",
      preserved: [["agent:main:explicit:cloud-owned", "cloud-placement-session"]],
      identities: ["unrelated-writer-session"],
      providerKeys: ["agent:main:explicit:cloud-owned"],
    },
  ] as const)("$name", async (scenario) => {
    const { storeName, preserved, identities } = scenario;
    const now = Date.now();
    const storePath = `/tmp/openclaw-sessions/${storeName}.json`;
    const store = makeStore([
      ...preserved.map(([key, sessionId], index): [string, SessionEntry] => [
        key,
        { sessionId, updatedAt: now - preserved.length - 1 + index },
      ]),
      ["removable-old", { sessionId: "removable-old-session", updatedAt: now - 2 }],
      ["removable-recent", { sessionId: "removable-recent-session", updatedAt: now - 1 }],
    ]);
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [...identities],
      assertAllowed: () => {},
    });
    const unregisterProvider =
      "providerKeys" in scenario
        ? registerSessionMaintenancePreserveKeysProvider(async () => ({
            capture: () => scenario.providerKeys,
            dispose() {},
          }))
        : undefined;

    try {
      await applyFileBackedSessionStoreMaintenance({
        storePath,
        store,
        maintenanceConfig: { ...baseMaintenance, maxEntries: 1 },
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      for (const [key] of preserved) {
        expect(store).toHaveProperty(key);
        expect(store[key]?.archivedAt).toBeUndefined();
      }
      expect(store["removable-old"]?.archivedAt).toEqual(expect.any(Number));
      expect(store["removable-recent"]?.archivedAt).toEqual(expect.any(Number));
    } finally {
      admission.release();
      unregisterProvider?.();
    }
  });

  it("scopes active preservation by store and releases rows back to maintenance", async () => {
    const now = Date.now();
    const activeStorePath = "/tmp/openclaw-sessions/active-store.json";
    const maintainedStorePath = "/tmp/openclaw-sessions/maintained-store.json";
    const activeSessionId = "shared-session-id";
    const admission = await beginSessionWorkAdmission({
      scope: activeStorePath,
      identities: [activeSessionId],
      assertAllowed: () => {},
    });
    const maintenanceConfig = { ...baseMaintenance, maxEntries: 1 };

    try {
      const otherStore = makeStore([
        ["old", { sessionId: activeSessionId, updatedAt: now - 31 * DAY_MS }],
        ["new", { sessionId: "new-session", updatedAt: now - 1 }],
      ]);
      await applyFileBackedSessionStoreMaintenance({
        storePath: maintainedStorePath,
        store: otherStore,
        maintenanceConfig,
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      expect(otherStore.old).toMatchObject({
        sessionId: activeSessionId,
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });

      const activeStore = makeStore([
        ["old", { sessionId: activeSessionId, updatedAt: now - 31 * DAY_MS }],
        ["new", { sessionId: "new-session", updatedAt: now - 1 }],
      ]);
      await applyFileBackedSessionStoreMaintenance({
        storePath: activeStorePath,
        store: activeStore,
        maintenanceConfig,
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      expect(activeStore.old).toMatchObject({ sessionId: activeSessionId });
      expect(activeStore.old?.archivedAt).toBeUndefined();

      admission.release();
      await applyFileBackedSessionStoreMaintenance({
        storePath: activeStorePath,
        store: activeStore,
        maintenanceConfig,
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      expect(activeStore.old).toMatchObject({
        sessionId: activeSessionId,
        archivedAt: expect.any(Number),
        archiveReason: "age-retention",
      });
    } finally {
      admission.release();
    }
  });
});

describe("pruneStaleModelRunEntries", () => {
  it("removes only stale generated gateway model-run sessions", () => {
    const now = Date.now();
    const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const recentModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174001";
    const store = makeStore([
      [staleModelRun, makeEntry(now - 25 * 60 * 60 * 1000)],
      [recentModelRun, makeEntry(now)],
      ["agent:main:explicit:model-run-not-a-uuid", makeEntry(now - 10 * DAY_MS)],
      [
        "agent:main:explicit:model-runner-123e4567-e89b-12d3-a456-426614174002",
        makeEntry(now - 10 * DAY_MS),
      ],
      ["agent:main:telegram:group:-100123:topic:77", makeEntry(now - 10 * DAY_MS)],
      ["agent:main:cron:job:run:123", makeEntry(now - 10 * DAY_MS)],
    ]);

    const pruned = pruneStaleModelRunEntries(store, DAY_MS);

    expect(pruned).toBe(1);
    expect(store[staleModelRun]).toBeUndefined();
    expect(store).toHaveProperty(recentModelRun);
    expect(store).toHaveProperty("agent:main:explicit:model-run-not-a-uuid");
    expect(store).toHaveProperty(
      "agent:main:explicit:model-runner-123e4567-e89b-12d3-a456-426614174002",
    );
    expect(store).toHaveProperty("agent:main:telegram:group:-100123:topic:77");
    expect(store).toHaveProperty("agent:main:cron:job:run:123");
  });
});

describe("capEntryCount", () => {
  it("removes synthetic cap overflow while retaining newer sessions", () => {
    const now = Date.now();
    const syntheticKey = "agent:main:subagent:old";
    const store = makeStore([
      ["newest", makeEntry(now)],
      [syntheticKey, makeEntry(now - 1)],
    ]);

    expect(capEntryCount(store, 1, { nowMs: now })).toBe(1);
    expect(store[syntheticKey]).toBeUndefined();
    expect(store).toHaveProperty("newest");
    expect(store.newest?.archivedAt).toBeUndefined();
  });

  it("never evicts the agent primary main session even when protected entries fill the cap (#112637)", () => {
    const now = Date.now();
    const mainKey = "agent:main:main";
    // `main` is the oldest entry, so pre-fix it was the first unprotected eviction target once
    // protected thread entries (>= maxEntries) left zero removable budget.
    const store = makeStore([
      [mainKey, makeEntry(now - 10 * DAY_MS)],
      ["agent:main:slack:channel:C1:thread:1", makeEntry(now - 3 * DAY_MS)],
      ["agent:main:slack:channel:C2:thread:2", makeEntry(now - 2 * DAY_MS)],
      ["agent:main:slack:channel:C3:thread:3", makeEntry(now - DAY_MS)],
    ]);

    expect(capEntryCount(store, 2)).toBe(0);

    // Every entry is now protected (main + threads), so nothing is evicted and `main` survives.
    expect(store).toHaveProperty(mainKey);
    expect(Object.keys(store)).toHaveLength(4);
  });

  it.each([["agent:main:dashboard:pinned", { pinnedAt: 1, parentSessionKey: "agent:main:main" }]])(
    "preserves protected %s when capping",
    (lockedKey, protection) => {
      const now = Date.now();
      const store = makeStore([
        [lockedKey, { ...makeEntry(now - 10 * DAY_MS), ...protection }],
        ["recent", makeEntry(now)],
        ["old", makeEntry(now - DAY_MS)],
      ]);

      expect(capEntryCount(store, 2)).toBe(1);

      expect(store).toHaveProperty(lockedKey);
      expect(store).toHaveProperty("recent");
      expect(store.old?.archivedAt).toEqual(expect.any(Number));
    },
  );
});

describe("isProtectedSessionMaintenanceEntry", () => {
  it.each([["global", true]])(
    "classifies primary session key %s as protected=%s",
    (key, expected) => {
      expect(isProtectedSessionMaintenanceEntry(key, makeEntry(Date.now()))).toBe(expected);
    },
  );
});

describe("resolveMaintenanceConfigFromInput", () => {
  it("honors explicit archive retention and disk budget opt-outs", () => {
    const maintenance = resolveMaintenanceConfigFromInput({
      resetArchiveRetention: "7d",
      maxDiskBytes: false,
    });

    expect(maintenance.resetArchiveRetentionMs).toBe(7 * DAY_MS);
    expect(maintenance.maxDiskBytes).toBeNull();
    expect(maintenance.highWaterBytes).toBeNull();
  });

  it("disables the disk budget when an explicit maxDiskBytes fails to parse", () => {
    const maintenance = resolveMaintenanceConfigFromInput({ maxDiskBytes: "lots" });

    expect(maintenance.maxDiskBytes).toBeNull();
    expect(maintenance.highWaterBytes).toBeNull();
  });

  it("retains session history when a zero maxDiskBytes disables the budget", async () => {
    await withTestDir({ prefix: "openclaw-zero-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const transcriptPath = path.join(dir, "old-session.jsonl");
      await fs.writeFile(transcriptPath, JSON.stringify({ role: "user", content: "hello" }));
      const store: Record<string, SessionEntry> = {
        "agent:main:subagent:old-worker": {
          sessionId: "old-session",
          updatedAt: 1,
          transcriptPath,
        },
      };
      await saveSessionStore(storePath, store, { skipMaintenance: true });

      const maintenance = resolveMaintenanceConfigFromInput({ maxDiskBytes: 0 });
      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance: {
          maxDiskBytes: maintenance.maxDiskBytes,
          highWaterBytes: maintenance.highWaterBytes,
        },
        warnOnly: false,
      });

      expect(maintenance.maxDiskBytes).toBeNull();
      expect(maintenance.highWaterBytes).toBeNull();
      expect(result).toBeNull();
      await fs.access(transcriptPath);
    });
  });

  it.each([["the number 0", 0]])(
    "falls back to the default high-water mark when highWaterBytes is %s",
    (_label, raw) => {
      const maintenance = resolveMaintenanceConfigFromInput({
        maxDiskBytes: "500mb",
        highWaterBytes: raw,
      });

      expect(maintenance.maxDiskBytes).toBe(500 * 1024 * 1024);
      expect(maintenance.highWaterBytes).toBe(Math.floor(500 * 1024 * 1024 * 0.8));
    },
  );

  it("keeps an explicit positive highWaterBytes", () => {
    const maintenance = resolveMaintenanceConfigFromInput({
      maxDiskBytes: "500mb",
      highWaterBytes: "300mb",
    });

    expect(maintenance.highWaterBytes).toBe(300 * 1024 * 1024);
  });

  it("force-gates the unset model-run prune default to the cap-eviction threshold", () => {
    const defaultMaintenance = resolveMaintenanceConfigFromInput({ maxEntries: 50 });
    expect(resolveSessionEntryMaintenanceHighWater(50)).toBe(75);
    expect(shouldRunModelRunPrune({ maintenance: defaultMaintenance, entryCount: 60 })).toBe(false);
    expect(
      shouldRunModelRunPrune({ maintenance: defaultMaintenance, entryCount: 60, force: true }),
    ).toBe(true);
    expect(
      shouldRunModelRunPrune({ maintenance: defaultMaintenance, entryCount: 50, force: true }),
    ).toBe(false);
  });
});
