import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { saveLegacySessionStore as saveSessionStore } from "../../infra/state-migrations.legacy-session-store.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { beginSessionEffect } from "../../sessions/session-controller.lifecycle.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
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
const MiB = 1024 * 1024;
const disabledBudget = { maxDiskBytes: null, highWaterBytes: null };

function makeEntry(
  updatedAt: number,
  sessionId: string = crypto.randomUUID(),
  extra: Partial<SessionEntry> = {},
): SessionEntry {
  return { sessionId, updatedAt, ...extra };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

const archived = (sessionId: string) => ({
  sessionId,
  archivedAt: expect.any(Number),
  archiveReason: "age-retention",
});

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

  it("preserves a pin until removed, then archives the same identity", () => {
    const now = Date.now();
    const original = { ...makeEntry(now - 31 * DAY_MS), pinnedAt: now - DAY_MS };
    const store: { protected: SessionEntry } = { protected: { ...original } };
    expect(pruneStaleEntries(store, 30 * DAY_MS)).toBe(0);
    expect(store.protected).toEqual(original);
    delete store.protected.pinnedAt;
    expect(pruneStaleEntries(store, 30 * DAY_MS)).toBe(0);
    expect(store.protected).toMatchObject(archived(original.sessionId));
  });
});

it.each([
  ["suspended", "quota_exhausted", 30 * 60 * 1000, 1, false],
  ["active", "circuit_open", 61 * 60 * 1000, 31 * 60 * 1000, true],
] as const)("transitions a %s quota suspension (%s)", (state, reason, age, resumeAge, cleared) => {
  const now = Date.now();
  const quotaSuspension = {
    schemaVersion: 1 as const,
    suspendedAt: now - age,
    expectedResumeBy: now - resumeAge,
    state,
    reason,
    failedProvider: "anthropic",
    failedModel: "claude-opus-4-6",
  };
  expect(
    resolveQuotaSuspensionEntryMaintenance({
      entry: makeEntry(now, undefined, { quotaSuspension }),
      now,
    }),
  ).toEqual({ quotaSuspension: cleared ? undefined : { ...quotaSuspension, state: "resuming" } });
});

describe("applyFileBackedSessionStoreMaintenance", () => {
  const baseMaintenance: NonNullable<
    Parameters<typeof applyFileBackedSessionStoreMaintenance>[0]["maintenanceConfig"]
  > = {
    mode: "enforce" as const,
    pruneAfterMs: 30 * DAY_MS,
    maxEntries: 500,
    modelRunPruneAfterMs: DAY_MS,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  };

  function maintain(
    store: Record<string, SessionEntry>,
    storePath: string,
    overrides: Partial<typeof baseMaintenance> = { maxEntries: 1 },
    operation: Partial<Parameters<typeof applyFileBackedSessionStoreMaintenance>[0]> = {},
  ) {
    return applyFileBackedSessionStoreMaintenance({
      store,
      storePath,
      maintenanceConfig: { ...baseMaintenance, ...overrides },
      log: { warn: () => {}, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async () => new Set<string>(),
        cleanupArchivedSessionTranscripts: async () => {},
      },
      ...operation,
    });
  }

  it("reports archive retention failure without aborting file-backed maintenance", async () => {
    const now = Date.now();
    const store = makeStore([
      ["agent:main:hook:stale", makeEntry(now - 30 * DAY_MS, "stale-session")],
      ["fresh", makeEntry(now, "fresh-session")],
    ]);
    const cleanupError = new Error("archive cleanup denied");
    const warn = vi.fn();

    await maintain(
      store,
      "/tmp/openclaw-sessions/sessions.json",
      { pruneAfterMs: 7 * DAY_MS, resetArchiveRetentionMs: 0 },
      {
        log: { warn, info: () => {} },
        artifacts: {
          archiveRemovedSessionTranscripts: async () => new Set(),
          cleanupArchivedSessionTranscripts: async () => {
            throw cleanupError;
          },
        },
      },
    );

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
      const store: Record<string, SessionEntry> = { [staleProbe]: makeEntry(now - 2 * DAY_MS) };
      for (let i = 0; i < 75; i++) {
        store[`agent:main:explicit:real-${i}`] = makeEntry(now - 3 * DAY_MS);
      }

      await maintain(store, "/tmp/openclaw-sessions/sessions.json", {
        pruneAfterMs: 7 * DAY_MS,
        maxEntries: 50,
        modelRunPruneAfterMs,
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

  it("preserves a cloud-owned session independently of the active writer", async () => {
    const now = Date.now();
    const storePath = "/tmp/openclaw-sessions/active-cloud-placement.json";
    const key = "agent:main:explicit:cloud-owned";
    const store = makeStore([
      [key, makeEntry(now - 2, "cloud-placement-session")],
      ["removable-old", makeEntry(now - 2, "removable-old-session")],
      ["removable-recent", makeEntry(now - 1, "removable-recent-session")],
    ]);
    const admission = await beginSessionEffect({
      scope: storePath,
      identities: ["unrelated-writer-session"],
      assertAllowed: () => {},
    });
    const unregisterProvider = registerSessionMaintenancePreserveKeysProvider(async () => ({
      capture: () => [key],
      dispose() {},
    }));
    try {
      await maintain(store, storePath);
      expect(store).toHaveProperty(key);
      expect(store[key]?.archivedAt).toBeUndefined();
      expect(store["removable-old"]?.archivedAt).toEqual(expect.any(Number));
      expect(store["removable-recent"]?.archivedAt).toEqual(expect.any(Number));
    } finally {
      admission.release();
      unregisterProvider();
    }
  });

  it("scopes active preservation by store and releases rows back to maintenance", async () => {
    const now = Date.now();
    const activeStorePath = "/tmp/openclaw-sessions/active-store.json";
    const maintainedStorePath = "/tmp/openclaw-sessions/maintained-store.json";
    const activeSessionId = "shared-session-id";
    const makeActiveStore = () =>
      makeStore([
        ["old", makeEntry(now - 31 * DAY_MS, activeSessionId)],
        ["new", makeEntry(now - 1, "new-session")],
      ]);
    const admission = await beginSessionEffect({
      scope: activeStorePath,
      identities: [activeSessionId],
      assertAllowed: () => {},
    });

    try {
      const otherStore = makeActiveStore();
      await maintain(otherStore, maintainedStorePath);
      expect(otherStore.old).toMatchObject(archived(activeSessionId));

      const activeStore = makeActiveStore();
      await maintain(activeStore, activeStorePath);
      expect(activeStore.old).toMatchObject({ sessionId: activeSessionId });
      expect(activeStore.old?.archivedAt).toBeUndefined();

      admission.release();
      await maintain(activeStore, activeStorePath);
      expect(activeStore.old).toMatchObject(archived(activeSessionId));
    } finally {
      admission.release();
    }
  });
});

it("removes only stale generated gateway model-run sessions", () => {
  const now = Date.now();
  const staleModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
  const recentModelRun = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174001";
  const retained = [
    recentModelRun,
    "agent:main:explicit:model-run-not-a-uuid",
    "agent:main:explicit:model-runner-123e4567-e89b-12d3-a456-426614174002",
    "agent:main:telegram:group:-100123:topic:77",
    "agent:main:cron:job:run:123",
  ];
  const store = makeStore([
    [staleModelRun, makeEntry(now - 25 * 60 * 60 * 1000)],
    ...retained.map((key, index): [string, SessionEntry] => [
      key,
      makeEntry(index === 0 ? now : now - 10 * DAY_MS),
    ]),
  ]);
  expect(pruneStaleModelRunEntries(store, DAY_MS)).toBe(1);
  expect(store[staleModelRun]).toBeUndefined();
  expect(new Set(Object.keys(store))).toEqual(new Set(retained));
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
    // Oldest main remains protected even when threads leave zero removable budget.
    const store = makeStore([
      [mainKey, makeEntry(now - 10 * DAY_MS)],
      ["agent:main:slack:channel:C1:thread:1", makeEntry(now - 3 * DAY_MS)],
      ["agent:main:slack:channel:C2:thread:2", makeEntry(now - 2 * DAY_MS)],
      ["agent:main:slack:channel:C3:thread:3", makeEntry(now - DAY_MS)],
    ]);
    expect(capEntryCount(store, 2)).toBe(0);
    expect(store).toHaveProperty(mainKey);
    expect(Object.keys(store)).toHaveLength(4);
  });

  it("preserves a pinned dashboard session when capping", () => {
    const now = Date.now();
    const lockedKey = "agent:main:dashboard:pinned";
    const store = makeStore([
      [
        lockedKey,
        { ...makeEntry(now - 10 * DAY_MS), pinnedAt: 1, parentSessionKey: "agent:main:main" },
      ],
      ["recent", makeEntry(now)],
      ["old", makeEntry(now - DAY_MS)],
    ]);
    expect(capEntryCount(store, 2)).toBe(1);
    expect(store).toHaveProperty(lockedKey);
    expect(store).toHaveProperty("recent");
    expect(store.old?.archivedAt).toEqual(expect.any(Number));
  });
});

it("protects the global primary session", () => {
  expect(shouldPreserveMaintenanceEntry({ key: "global", entry: makeEntry(Date.now()) })).toBe(
    true,
  );
});

describe("resolveMaintenanceConfigFromInput", () => {
  it.each([false, "lots"] as const)(
    "disables the disk budget for %s and preserves archive retention",
    (maxDiskBytes) => {
      expect(
        resolveMaintenanceConfigFromInput({ resetArchiveRetention: "7d", maxDiskBytes }),
      ).toMatchObject({ ...disabledBudget, resetArchiveRetentionMs: 7 * DAY_MS });
    },
  );

  it("retains session history when a zero maxDiskBytes disables the budget", async () => {
    await withTestDir({ prefix: "openclaw-zero-disk-budget-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const transcriptPath = path.join(dir, "old-session.jsonl");
      await fs.writeFile(transcriptPath, JSON.stringify({ role: "user", content: "hello" }));
      const store: Record<string, SessionEntry> = {
        "agent:main:subagent:old-worker": makeEntry(1, "old-session", { transcriptPath }),
      };
      await saveSessionStore(storePath, store, { skipMaintenance: true });

      const maintenance = resolveMaintenanceConfigFromInput({ maxDiskBytes: 0 });
      await enforceSessionDiskBudget({
        store,
        storePath,
        maintenance,
        warnOnly: false,
      });

      expect(maintenance).toMatchObject(disabledBudget);
      await fs.access(transcriptPath);
    });
  });

  it.each([
    [0, 400],
    ["300mb", 300],
  ] as const)("resolves highWaterBytes %s to %s MiB", (highWaterBytes, expectedMiB) => {
    expect(
      resolveMaintenanceConfigFromInput({ maxDiskBytes: "500mb", highWaterBytes }),
    ).toMatchObject({ maxDiskBytes: 500 * MiB, highWaterBytes: expectedMiB * MiB });
  });

  it("force-gates the unset model-run prune default to the cap-eviction threshold", () => {
    const maintenance = resolveMaintenanceConfigFromInput({ maxEntries: 50 });
    expect(shouldRunSessionEntryMaintenance({ entryCount: 74, maxEntries: 50 })).toBe(false);
    expect(shouldRunSessionEntryMaintenance({ entryCount: 75, maxEntries: 50 })).toBe(true);
    expect([
      shouldRunModelRunPrune({ maintenance, entryCount: 60 }),
      shouldRunModelRunPrune({ maintenance, entryCount: 60, force: true }),
      shouldRunModelRunPrune({ maintenance, entryCount: 50, force: true }),
    ]).toEqual([false, true, false]);
  });
});

describe("recent session preservation", () => {
  const recentKey = "agent:main:dashboard:recent";
  const staleKey = "agent:main:dashboard:stale";
  const preserveRecentMs = 7 * DAY_MS;

  afterEach(() => resetPluginRuntimeStateForTest());

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
        [...protectedKeys, ...removableKeys].map((key) => [key, makeEntry(updatedAt, key)]),
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
      [recentKey]: makeEntry(now - DAY_MS, "recent"),
      [staleKey]: makeEntry(now - 8 * DAY_MS, "stale"),
      [syntheticKey]: makeEntry(now - DAY_MS, "synthetic"),
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

    store[staleKey] = makeEntry(now - 8 * DAY_MS, "stale-2");
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
        [recentKey]: makeEntry(now, "recent"),
        [staleKey]: makeEntry(now - 8 * DAY_MS, "stale", {
          archivedAt: now - 8 * DAY_MS,
          archiveReason: "active-session-cap",
        }),
        [externalKey]: makeEntry(now - 9 * DAY_MS, "external"),
      };

      await enforceSessionDiskBudget({
        store,
        storePath: path.join(dir, "sessions.json"),
        maintenance: { highWaterBytes: 1, maxDiskBytes: 1, preserveRecentMs },
        warnOnly: false,
      });

      expect(store).toHaveProperty(recentKey);
      expect(store).toHaveProperty(externalKey);
      expect(store).not.toHaveProperty(staleKey);
      expect(resolveSessionConversation).not.toHaveBeenCalled();
    });
  });
});
