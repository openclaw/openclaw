// Session store pruning tests cover pruning decisions and retention ordering.
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import {
  resolveMaintenanceConfigFromInput,
  resolveQuotaSuspensionEntryMaintenance,
} from "./store-maintenance.js";
import { pruneStaleEntries } from "./store.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const fixtureSuite = createFixtureSuite("openclaw-pruning-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: crypto.randomUUID(), updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

function createMaintenanceArtifacts() {
  return {
    archiveRemovedSessionTranscripts: async () => new Set<string>(),
    removeRemovedSessionTrajectoryArtifacts: async () => {},
    cleanupArchivedSessionTranscripts: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Unit tests — each function called with explicit override parameters.
// No config loading needed; overrides bypass resolveMaintenanceConfig().
// ---------------------------------------------------------------------------

describe("pruneStaleEntries", () => {
  it("removes entries older than maxAgeDays", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["fresh", makeEntry(now - DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store).toHaveProperty("fresh");
  });

  it("preserves durable external conversation entries", () => {
    const now = Date.now();
    const store = makeStore([
      ["old", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C123:thread:1710000000.000100", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123:topic:77", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:slack:channel:C999", makeEntry(now - 31 * DAY_MS)],
      ["agent:main:telegram:group:-100123", { ...makeEntry(now - 31 * DAY_MS), chatType: "group" }],
      ["agent:main:discord:channel:ops", { ...makeEntry(now - 31 * DAY_MS), chatType: "channel" }],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store.old).toBeUndefined();
    expect(store).toHaveProperty("agent:main:slack:channel:C123:thread:1710000000.000100");
    expect(store).toHaveProperty("agent:main:telegram:group:-100123:topic:77");
    expect(store).toHaveProperty("agent:main:slack:channel:C999");
    expect(store).toHaveProperty("agent:main:telegram:group:-100123");
    expect(store).toHaveProperty("agent:main:discord:channel:ops");
  });

  it("preserves model-locked harness sessions even when stale", () => {
    const now = Date.now();
    const lockedKey = "agent:main:harness-owned:locked";
    const store = makeStore([
      [lockedKey, { ...makeEntry(now - 31 * DAY_MS), modelSelectionLocked: true }],
      ["old", makeEntry(now - 31 * DAY_MS)],
    ]);

    const pruned = pruneStaleEntries(store, 30 * DAY_MS);

    expect(pruned).toBe(1);
    expect(store).toHaveProperty(lockedKey);
    expect(store.old).toBeUndefined();
  });
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
          laneId: "main",
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
          laneId: "main",
        },
      },
      resumed: { laneId: "main" },
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
          laneId: "main",
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
  it("preserves the active session and cleans artifacts using the final referenced session set", async () => {
    const now = Date.now();
    const store = makeStore([
      [
        "stale",
        { sessionId: "stale-session", sessionFile: "stale.jsonl", updatedAt: now - 30 * DAY_MS },
      ],
      [
        "stale-shared",
        {
          sessionId: "shared-session",
          sessionFile: "shared-old.jsonl",
          updatedAt: now - 30 * DAY_MS,
        },
      ],
      ["fresh-shared", { sessionId: "shared-session", updatedAt: now }],
      ["active", { sessionId: "active-session", updatedAt: now - 30 * DAY_MS }],
    ]);
    const archiveCalls: Array<{
      removedSessionFiles: Array<[string, string | undefined]>;
      referencedSessionIds: Set<string>;
    }> = [];
    let trajectoryCleanupReferencedIds: Set<string> | undefined;

    const result = await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      activeSessionKey: "active",
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 7 * DAY_MS,
        maxEntries: 500,
        modelRunPruneAfterMs: DAY_MS,
        resetArchiveRetentionMs: null,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      log: { warn: () => {}, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async (params) => {
          archiveCalls.push({
            removedSessionFiles: [...params.removedSessionFiles],
            referencedSessionIds: new Set(params.referencedSessionIds),
          });
          return new Set();
        },
        removeRemovedSessionTrajectoryArtifacts: async (params) => {
          trajectoryCleanupReferencedIds = new Set(params.referencedSessionIds);
        },
        cleanupArchivedSessionTranscripts: async () => {},
      },
    });

    expect(result.changedStore).toBe(true);
    expect(store.stale).toBeUndefined();
    expect(store["stale-shared"]).toBeUndefined();
    expect(store).toHaveProperty("fresh-shared");
    expect(store).toHaveProperty("active");
    expect(archiveCalls).toEqual([
      {
        removedSessionFiles: [
          ["stale-session", "stale.jsonl"],
          ["shared-session", "shared-old.jsonl"],
        ],
        referencedSessionIds: new Set(["shared-session", "active-session"]),
      },
    ]);
    expect(trajectoryCleanupReferencedIds).toEqual(new Set(["shared-session", "active-session"]));
  });

  it("forced cleanup prunes stale model-run probes before the cap evicts real sessions", async () => {
    const now = Date.now();
    const staleProbe = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174099";
    const store: Record<string, SessionEntry> = {
      [staleProbe]: makeEntry(now - 2 * DAY_MS),
    };
    for (let i = 0; i < 50; i++) {
      store[`agent:main:explicit:real-${i}`] = makeEntry(now - 3 * DAY_MS);
    }
    let report: { modelRunPruned: number; pruned: number; capped: number } | undefined;

    const result = await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      maintenanceConfig: {
        mode: "enforce",
        pruneAfterMs: 7 * DAY_MS,
        maxEntries: 50,
        modelRunPruneAfterMs: DAY_MS,
        resetArchiveRetentionMs: null,
        maxDiskBytes: null,
        highWaterBytes: null,
      },
      maintenanceOverride: { mode: "enforce" },
      onMaintenanceApplied: (applied) => {
        report = {
          modelRunPruned: applied.modelRunPruned,
          pruned: applied.pruned,
          capped: applied.capped,
        };
      },
      log: { warn: () => {}, info: () => {} },
      artifacts: {
        archiveRemovedSessionTranscripts: async () => new Set(),
        removeRemovedSessionTrajectoryArtifacts: async () => {},
        cleanupArchivedSessionTranscripts: async () => {},
      },
    });

    expect(result.changedStore).toBe(true);
    expect(report?.modelRunPruned).toBe(1);
    expect(report?.capped).toBe(0);
    expect(store[staleProbe]).toBeUndefined();
    expect(Object.keys(store)).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(store).toHaveProperty(`agent:main:explicit:real-${i}`);
    }
  });

  it("preserves every active admission instead of only the writer session", async () => {
    const now = Date.now();
    const storePath = "/tmp/openclaw-sessions/active-admissions.json";
    const activeKey = "agent:main:cron:job:run:active";
    const store = makeStore([
      [activeKey, { sessionId: "active-session", updatedAt: now - 3 }],
      ["removable", { sessionId: "removable-session", updatedAt: now - 2 }],
      ["writer", { sessionId: "writer-session", updatedAt: now - 1 }],
    ]);
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [activeKey, "active-session"],
      assertAllowed: () => {},
    });

    try {
      await applyFileBackedSessionStoreMaintenance({
        storePath,
        store,
        activeSessionKey: "writer",
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 30 * DAY_MS,
          maxEntries: 1,
          modelRunPruneAfterMs: DAY_MS,
          resetArchiveRetentionMs: null,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });

      expect(store).toHaveProperty(activeKey);
      expect(store).toHaveProperty("writer");
      expect(store.removable).toBeUndefined();
    } finally {
      admission.release();
    }
  });

  it("preserves every store alias backed by an active session id", async () => {
    const now = Date.now();
    const storePath = "/tmp/openclaw-sessions/active-aliases.json";
    const activeSessionId = "active-alias-session";
    const firstAlias = "agent:main:cron:job:run:active";
    const secondAlias = "agent:main:cron:job:run:active:thread:reply";
    const store = makeStore([
      [firstAlias, { sessionId: activeSessionId, updatedAt: now - 3 }],
      [secondAlias, { sessionId: activeSessionId, updatedAt: now - 2 }],
      ["removable", { sessionId: "removable-session", updatedAt: now - 1 }],
    ]);
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [activeSessionId],
      assertAllowed: () => {},
    });

    try {
      await applyFileBackedSessionStoreMaintenance({
        storePath,
        store,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 30 * DAY_MS,
          maxEntries: 1,
          modelRunPruneAfterMs: DAY_MS,
          resetArchiveRetentionMs: null,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });

      expect(store).toHaveProperty(firstAlias);
      expect(store).toHaveProperty(secondAlias);
      expect(store.removable).toBeUndefined();
    } finally {
      admission.release();
    }
  });

  it("preserves a raw legacy store key matched by a canonical admission identity", async () => {
    const now = Date.now();
    const storePath = "/tmp/openclaw-sessions/active-legacy-key.json";
    const rawActiveKey = "Agent:Main:Subagent:CHILD";
    const canonicalActiveKey = "agent:main:subagent:child";
    const store = makeStore([
      [rawActiveKey, { sessionId: "active-legacy-session", updatedAt: now - 2 }],
      ["removable", { sessionId: "removable-session", updatedAt: now - 1 }],
    ]);
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [canonicalActiveKey],
      assertAllowed: () => {},
    });

    try {
      await applyFileBackedSessionStoreMaintenance({
        storePath,
        store,
        maintenanceConfig: {
          mode: "enforce",
          pruneAfterMs: 30 * DAY_MS,
          maxEntries: 1,
          modelRunPruneAfterMs: DAY_MS,
          resetArchiveRetentionMs: null,
          maxDiskBytes: null,
          highWaterBytes: null,
        },
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });

      expect(store).toHaveProperty(rawActiveKey);
      expect(store.removable).toBeUndefined();
    } finally {
      admission.release();
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
    const maintenanceConfig = {
      mode: "enforce" as const,
      pruneAfterMs: 30 * DAY_MS,
      maxEntries: 1,
      modelRunPruneAfterMs: DAY_MS,
      resetArchiveRetentionMs: null,
      maxDiskBytes: null,
      highWaterBytes: null,
    };

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
      expect(otherStore.old).toBeUndefined();

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
      expect(activeStore).toHaveProperty("old");

      admission.release();
      await applyFileBackedSessionStoreMaintenance({
        storePath: activeStorePath,
        store: activeStore,
        maintenanceConfig,
        log: { warn: () => {}, info: () => {} },
        artifacts: createMaintenanceArtifacts(),
      });
      expect(activeStore.old).toBeUndefined();
    } finally {
      admission.release();
    }
  });
});

describe("resolveMaintenanceConfigFromInput", () => {
  it("defaults to enforcing session maintenance", () => {
    const maintenance = resolveMaintenanceConfigFromInput();

    expect(maintenance.mode).toBe("enforce");
  });

  it("defaults gateway model-run probes to fixed 24h retention", () => {
    expect(resolveMaintenanceConfigFromInput().modelRunPruneAfterMs).toBe(DAY_MS);
  });

  it("keeps archived transcripts by default and bounds growth with a disk budget", () => {
    const maintenance = resolveMaintenanceConfigFromInput();

    expect(maintenance.resetArchiveRetentionMs).toBeNull();
    expect(maintenance.maxDiskBytes).toBe(2 * 1024 * 1024 * 1024);
    expect(maintenance.highWaterBytes).toBe(Math.floor(2 * 1024 * 1024 * 1024 * 0.8));
  });

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
});
