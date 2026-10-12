import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { ResolvedSessionEntryAccessTarget } from "../../config/sessions/session-accessor.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeRecord } from "./types.js";

const mocks = vi.hoisted(() => ({
  readResolvedSessionEntriesInWorker: vi.fn(),
  getMany: vi.fn(),
  listForReconcile: vi.fn(),
  listAsync: vi.fn(),
  isSessionWorkAdmissionActive: vi.fn(),
  isSessionLifecycleMutationActive: vi.fn(),
  runExclusiveSessionLifecycleMutation: vi.fn(),
}));

const cleanupRecord = {
  id: "worktree",
  name: "archived",
  repoFingerprint: "repository",
  repoRoot: "/repository",
  path: "/worktree",
  branch: "archived",
  baseRef: "main",
  ownerKind: "session",
  ownerId: "agent:main:archived",
  createdAt: 1,
  lastActiveAt: 1,
} satisfies ManagedWorktreeRecord;

// mock-isolation: Session reads and placements are synthetic; policy lifecycle and publications stay real.
vi.mock("../../config/sessions/session-accessor.entry.js", () => ({
  readResolvedSessionEntriesInWorker: mocks.readResolvedSessionEntriesInWorker,
}));
vi.mock("../../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: mocks.getMany,
      listForReconcile: mocks.listForReconcile,
      listAsync: mocks.listAsync,
    },
  }),
}));
vi.mock("../../sessions/session-lifecycle-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-lifecycle-admission.js")>()),
  isSessionWorkAdmissionActive: mocks.isSessionWorkAdmissionActive,
  isSessionLifecycleMutationActive: mocks.isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation: mocks.runExclusiveSessionLifecycleMutation,
}));

function target(
  key = cleanupRecord.ownerId,
  entry?: SessionEntry,
): ResolvedSessionEntryAccessTarget {
  return {
    agentId: "main",
    canonicalKey: key,
    requestedKey: key,
    storeKey: key,
    entry: entry ?? { sessionId: key, updatedAt: 1, archivedAt: 1 },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getMany.mockReturnValue(new Map());
  mocks.listForReconcile.mockReturnValue([]);
  mocks.listAsync.mockResolvedValue([]);
  mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
  mocks.isSessionLifecycleMutationActive.mockReturnValue(false);
  mocks.runExclusiveSessionLifecycleMutation.mockImplementation(
    (_operation, { run }: { run: () => Promise<unknown> }) => run(),
  );
  mocks.readResolvedSessionEntriesInWorker.mockImplementation(
    ({ sessionKeys }: { sessionKeys: string[] }) =>
      Promise.resolve(new Map(sessionKeys.map((key) => [key, target(key)]))),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createManagedWorktreeOwnerPolicy", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      await closeOpenClawStateDatabaseAsync();
      cleanup();
    }),
  );

  it("uses the worker for cleanup facts and invalidates them after an in-process write", async () => {
    const stateDir = tempDirs.make("worktree-owner-worker-");
    const native = await vi.importActual<
      typeof import("../../config/sessions/session-accessor.entry.js")
    >("../../config/sessions/session-accessor.entry.js");
    mocks.readResolvedSessionEntriesInWorker.mockImplementation(
      native.readResolvedSessionEntriesInWorker,
    );
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const key = cleanupRecord.ownerId;
      const scope = { agentId: "main", sessionKey: key };
      replaceSessionEntrySync(scope, { sessionId: "real-owner", updatedAt: 1, archivedAt: 1 });
      const policy = createManagedWorktreeOwnerPolicy({});
      const sql = observeHostDataSql();
      try {
        await policy.withOwnerCleanup(cleanupRecord, async () => {
          expect(policy.readOwnerState("session", key)).toBe("retired");
          expect(sql.queries).toEqual([]);
          sql.restore();
          await replaceSessionEntry(scope, { sessionId: "real-owner", updatedAt: Date.now() });
          expect(policy.readOwnerState("session", key)).toBe("active");
        });
      } finally {
        sql.restore();
        await cleanupSessionStateForTest({ stateDir });
      }
    });
  });

  it("classifies a large worker census without caller-thread SQL and checks live placements at cleanup", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-owner-census-") };
    const store = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase({ env }),
    });
    const records = Array.from({ length: 609 }, (_, index) => ({
      ...cleanupRecord,
      id: `worktree-${index}`,
      ownerId: `agent:main:census-${index}`,
    }));
    const targets = new Map(records.map(({ ownerId }) => [ownerId, target(ownerId)]));
    mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(targets);
    mocks.getMany.mockImplementation((ids) => store.getMany(ids));
    mocks.listForReconcile.mockImplementation((key) => store.listForReconcile(key));
    mocks.listAsync.mockImplementation(() => store.listAsync());
    const live = records[0]!.ownerId;
    await store.startDispatch({ sessionId: live, sessionKey: live, agentId: "main" });
    const policy = createManagedWorktreeOwnerPolicy({});
    const sql = observeHostDataSql();
    try {
      const census = await policy.prepareOwners(records);
      expect(census.readOwnerState?.("session", live)).toBe("active");
      for (const record of records.slice(1)) {
        expect(census.readOwnerState?.("session", record.ownerId)).toBe("retired");
      }
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    const changed = records[1]!;
    await store.startDispatch({
      sessionId: changed.ownerId,
      sessionKey: changed.ownerId,
      agentId: "main",
    });
    await policy.withOwnerCleanup(changed, async () => {
      expect(policy.readOwnerState("session", changed.ownerId)).toBe("active");
    });
  });

  it("cancels queued cleanup before the preceding session mutation finishes", async ({
    signal,
  }) => {
    const lifecycle = await vi.importActual<
      typeof import("../../sessions/session-lifecycle-admission.js")
    >("../../sessions/session-lifecycle-admission.js");
    mocks.runExclusiveSessionLifecycleMutation.mockImplementation(
      lifecycle.runExclusiveSessionLifecycleMutation,
    );
    const key = cleanupRecord.ownerId;
    const sessionId = "queued-cleanup-session";
    mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(
      new Map([[key, target(key, { sessionId, updatedAt: 1, archivedAt: 1 })]]),
    );
    const cfg = { session: { store: "/worktree-cleanup-policy/sessions.json" } };
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = lifecycle.runExclusiveSessionLifecycleMutation("archive", {
      scope: resolveSessionStorePathCore(cfg.session.store, { agentId: "main" }),
      identities: [key, sessionId],
      run: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    const remove = vi.fn(async () => {});
    const abort = new AbortController();
    const reason = new Error("worktree maintenance stopped");
    let pending: Promise<void> | undefined;
    try {
      await withinTest(entered.promise, signal);
      pending = createManagedWorktreeOwnerPolicy(cfg).withOwnerCleanup(
        cleanupRecord,
        (withOwnerMutation) => withOwnerMutation(remove),
        abort.signal,
      );
      abort.abort(reason);
      await expect(withinTest(pending, signal)).rejects.toBe(reason);
      expect(remove).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([blocker, pending]);
    }
  });

  it("uses one worker owner read through cleanup and refuses committed changes before deletion", async () => {
    const policy = createManagedWorktreeOwnerPolicy({});
    const key = cleanupRecord.ownerId;
    await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) => {
      await withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", key)).toBe("retired");
        sessionChanges.emit({
          sessionKey: `${key}:unrelated`,
          scope: "session-entry",
          facts: { kind: "removed" },
        });
        expect(policy.readOwnerState("session", key)).toBe("retired");
        sessionChanges.emit({
          sessionKey: key,
          scope: "session-entry",
          facts: { kind: "removed" },
        });
        expect(policy.readOwnerState("session", key)).toBe("active");
      });
    });
    expect(mocks.readResolvedSessionEntriesInWorker).toHaveBeenCalledTimes(1);
    expect(policy.readOwnerState("session", key)).toBe("active");
    // A later cleanup acquires fresh facts instead of retaining the invalidated lifetime.
    await policy.withOwnerCleanup(cleanupRecord, async () => {
      expect(policy.readOwnerState("session", key)).toBe("retired");
    });
  });

  it("exempts its own cleanup fence while preserving new work admission", async () => {
    mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
    const policy = createManagedWorktreeOwnerPolicy({});
    const key = cleanupRecord.ownerId;
    await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) => {
      expect(policy.readOwnerState("session", key)).toBe("active");
      await withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", key)).toBe("retired");
        expect(policy.readOwnerState("session", `${key}:other`)).toBe("active");
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
        expect(policy.readOwnerState("session", key)).toBe("active");
      });
    });
  });

  it("defers an owner that became active after the census", async () => {
    const policy = createManagedWorktreeOwnerPolicy({});
    const key = cleanupRecord.ownerId;
    const census = await policy.prepareOwners([cleanupRecord]);
    expect(census.readOwnerState?.("session", key)).toBe("retired");
    mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(
      new Map([[key, target(key, { sessionId: key, updatedAt: Date.now() })]]),
    );
    await policy.withOwnerCleanup(cleanupRecord, async () => {
      expect(policy.readOwnerState("session", key)).toBe("active");
    });
  });

  it("classifies recent, idle, archived and missing owners through the async census", async () => {
    const now = 1_800_000_000_000;
    const entries = new Map<string, ResolvedSessionEntryAccessTarget>([
      ["live", target("live", { sessionId: "live", updatedAt: now - 1_000 })],
      ["idle", target("idle", { sessionId: "idle", updatedAt: now - IDLE_GC_MS - 1 })],
      ["archived", target("archived", { sessionId: "archived", updatedAt: now, archivedAt: now })],
      ["missing", { ...target("missing"), entry: undefined }],
    ]);
    mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(entries);
    const census = await createManagedWorktreeOwnerPolicy({}, () => now).prepareOwners(
      [...entries.keys()].map((ownerId) => ({ ...cleanupRecord, ownerId })),
    );
    expect(
      ["live", "idle", "archived", "missing"].map((id) => census.readOwnerState?.("session", id)),
    ).toEqual(["active", "idle", "retired", "retired"]);
    expect(census.readOwnerState?.("manual", "missing")).toBe("other");
  });

  it.each(["failed", "missing"])(
    "defers unreadable or missing cleanup preparation (%s)",
    async (result) => {
      if (result === "failed")
        mocks.readResolvedSessionEntriesInWorker.mockRejectedValue(
          new Error("unavailable session store"),
        );
      else mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(new Map());
      const policy = createManagedWorktreeOwnerPolicy({});
      const census = await policy.prepareOwners([cleanupRecord]);
      expect(census.readOwnerState?.("session", cleanupRecord.ownerId)).toBe("active");
      await expect(policy.withOwnerCleanup(cleanupRecord, async () => {})).rejects.toThrow();
    },
  );

  it.each(["remote", "claimed", "unknown-placement"])(
    "preserves live placement protection (%s)",
    async (kind) => {
      const key = cleanupRecord.ownerId;
      if (kind === "unknown-placement")
        mocks.getMany.mockImplementation(() => {
          throw new Error("unreadable placement");
        });
      else
        mocks.getMany.mockReturnValue(
          new Map([
            [
              key,
              {
                sessionId: key,
                sessionKey: key,
                state: kind === "remote" ? "active" : "local",
                generation: 1,
                ...(kind === "claimed" ? { turnClaim: { id: "active-turn" } } : {}),
              },
            ],
          ]),
        );
      const policy = createManagedWorktreeOwnerPolicy({});
      await policy.withOwnerCleanup(cleanupRecord, async () => {
        expect(policy.readOwnerState("session", key)).toBe("active");
      });
    },
  );

  it.each(["added", "removed", "unreadable"])(
    "refuses changed related placement custody (%s)",
    async (change) => {
      const key = cleanupRecord.ownerId;
      const placement = {
        sessionId: "stopped",
        sessionKey: key,
        agentId: "other",
        state: "failed",
        generation: 1,
        environmentId: null,
      };
      const placements = [placement];
      mocks.listForReconcile.mockImplementation((selected?: string) =>
        placements.filter((row) => selected === undefined || row.sessionKey === selected),
      );
      mocks.getMany.mockImplementation(
        (ids: readonly string[]) =>
          new Map(
            placements
              .filter((row) => ids.includes(row.sessionId))
              .map((row) => [row.sessionId, row]),
          ),
      );
      const policy = createManagedWorktreeOwnerPolicy({});
      await policy.withOwnerCleanup(cleanupRecord, async () => {
        expect(policy.readOwnerState("session", key)).toBe("retired");
        placements.push({ ...placement, sessionId: "unrelated", sessionKey: `${key}:other` });
        expect(policy.readOwnerState("session", key)).toBe("retired");
        if (change === "added") placements.push({ ...placement, sessionId: "new-related" });
        else if (change === "removed") placements.splice(0, 1);
        else
          mocks.listForReconcile.mockImplementation(() => {
            throw new Error("unreadable placements");
          });
        expect(policy.readOwnerState("session", key)).toBe("active");
      });
    },
  );
});
