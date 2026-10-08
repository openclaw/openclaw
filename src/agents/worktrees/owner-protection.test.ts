import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeRecord } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveSessionEntryAccessTarget: vi.fn(),
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

// mock-isolation: Each policy receives fixture placements instead of the process-wide Gateway store.
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

beforeEach(() => {
  mocks.getMany.mockReturnValue(new Map());
  mocks.listForReconcile.mockReturnValue([]);
  mocks.listAsync.mockResolvedValue([]);
  mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
  mocks.isSessionLifecycleMutationActive.mockReturnValue(false);
  mocks.runExclusiveSessionLifecycleMutation.mockImplementation(
    (_operation, { run }: { run: () => Promise<unknown> }) => run(),
  );
});

// mock-isolation: Owner metadata is synthetic; policy tests must not open real session stores.
vi.mock("../../config/sessions/session-accessor.entry.js", () => ({
  resolveSessionEntryAccessTarget: mocks.resolveSessionEntryAccessTarget,
  readResolvedSessionEntriesInWorker: mocks.readResolvedSessionEntriesInWorker,
}));

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

  it("classifies a large census without caller-thread SQL and rechecks placements before removal", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-owner-census-") };
    const store = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase({ env }),
    });
    const records = Array.from({ length: 609 }, (_, index) => ({
      ...cleanupRecord,
      id: `worktree-${index}`,
      ownerId: `agent:main:census-${index}`,
    }));
    const targets = new Map(
      records.map(({ ownerId }) => [
        ownerId,
        {
          agentId: "main",
          canonicalKey: ownerId,
          requestedKey: ownerId,
          storeKey: ownerId,
          entry: { sessionId: ownerId, updatedAt: 1, archivedAt: 1 },
        },
      ]),
    );
    mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(targets);
    mocks.resolveSessionEntryAccessTarget.mockImplementation(({ sessionKey }) =>
      targets.get(sessionKey),
    );
    mocks.getMany.mockImplementation((ids) => store.getMany(ids));
    mocks.listForReconcile.mockImplementation((key) => store.listForReconcile(key));
    mocks.listAsync.mockImplementation(() => store.listAsync());
    const live = records[0]!.ownerId;
    await store.startDispatch({ sessionId: live, sessionKey: live, agentId: "main" });
    const policy = createManagedWorktreeOwnerPolicy({});
    const sql = observeHostDataSql();
    try {
      const census = await policy.prepareOwners(records);
      expect(census.shouldProtectOwner?.("session", live)).toBe(true);
      for (const record of records.slice(1)) {
        expect(census.shouldRemoveOwner?.("session", record.ownerId)).toBe(true);
      }
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    const changed = records[1]!.ownerId;
    await store.startDispatch({ sessionId: changed, sessionKey: changed, agentId: "main" });
    expect(policy.shouldRemoveOwner("session", changed)).toBe(false);
    expect(policy.shouldProtectOwner("session", changed)).toBe(true);
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
    mocks.resolveSessionEntryAccessTarget.mockReturnValue({
      agentId: "main",
      canonicalKey: key,
      entry: { sessionId, archivedAt: 1 },
    });
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
    expect(remove).not.toHaveBeenCalled();
  });

  it("exempts only its own session cleanup fence while preserving work admission protection", async () => {
    const key = "agent:main:archived";
    mocks.resolveSessionEntryAccessTarget.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => ({
        agentId: "main",
        canonicalKey: sessionKey,
        entry: { sessionId: sessionKey, archivedAt: 1 },
      }),
    );
    mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
    const policy = createManagedWorktreeOwnerPolicy({});
    expect(policy.shouldRemoveOwner("session", key)).toBe(false);
    await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expect(policy.shouldRemoveOwner("session", key)).toBe(true);
        expect(policy.shouldRemoveOwner("session", `${key}:other`)).toBe(false);
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
        expect(policy.shouldRemoveOwner("session", key)).toBe(false);
      }),
    );
    mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
    expect(policy.shouldRemoveOwner("session", key)).toBe(false);
  });

  it.each(
    [
      { sessionId: "replacement" },
      { lifecycleRevision: "replacement" },
      { archivedAt: 2 },
      { worktree: { id: "replacement", branch: "replacement", repoRoot: "/replacement" } },
    ].flatMap((change) => [
      { change, inPlace: false },
      { change, inPlace: true },
    ]),
  )(
    "rejects changed session custody after waiting for cleanup admission: %j",
    async ({ change, inPlace }) => {
      const key = cleanupRecord.ownerId;
      let entry: SessionEntry = {
        sessionId: "original",
        updatedAt: 1,
        lifecycleRevision: "original",
        archivedAt: 1,
        worktree: { id: cleanupRecord.id, branch: cleanupRecord.branch, repoRoot: "/repository" },
      };
      mocks.resolveSessionEntryAccessTarget.mockImplementation(() => ({
        agentId: "main",
        canonicalKey: key,
        entry,
      }));
      const policy = createManagedWorktreeOwnerPolicy({});
      expect(policy.shouldRemoveOwner("session", key)).toBe(true);
      mocks.runExclusiveSessionLifecycleMutation.mockImplementationOnce(
        async (_operation, { run }: { run: () => Promise<unknown> }) => {
          if (inPlace) {
            if (change.worktree) {
              Object.assign(entry.worktree!, change.worktree);
            } else {
              Object.assign(entry, change);
            }
          } else {
            entry = { ...entry, ...change };
          }
          return await run();
        },
      );

      await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) =>
        withOwnerMutation(async () => {
          expect(policy.shouldRemoveOwner("session", key)).toBe(false);
          expect(policy.shouldProtectOwner("session", key)).toBe(true);
        }),
      );
    },
  );

  it("protects only recently active session owners", () => {
    const now = 1_800_000_000_000;
    const entries: Record<
      string,
      { lastInteractionAt?: number; updatedAt?: number; archivedAt?: number }
    > = {
      "agent:main:live": { lastInteractionAt: now - 1_000 },
      "agent:main:stale": { updatedAt: now - IDLE_GC_MS - 1 },
      "agent:main:archived": { updatedAt: now, archivedAt: now },
    };
    mocks.resolveSessionEntryAccessTarget.mockImplementation(
      ({ sessionKey }: { sessionKey: string }) => ({
        agentId: "main",
        canonicalKey: sessionKey,
        entry: entries[sessionKey],
      }),
    );
    const { shouldProtectOwner, shouldRemoveOwner } = createManagedWorktreeOwnerPolicy(
      {},
      () => now,
    );

    expect(shouldProtectOwner("session", "agent:main:live")).toBe(true);
    expect(shouldProtectOwner("session", "agent:main:stale")).toBe(false);
    expect(shouldProtectOwner("manual", "agent:main:live")).toBe(false);
    expect(shouldProtectOwner("session", "agent:main:missing")).toBe(false);
    expect(shouldProtectOwner("session", "agent:main:archived")).toBe(false);
    expect(shouldRemoveOwner("session", "agent:main:archived")).toBe(true);
    expect(shouldRemoveOwner("session", "agent:main:missing")).toBe(true);
    expect(shouldRemoveOwner("manual", "agent:main:missing")).toBe(false);
    expect(shouldRemoveOwner("session", "agent:main:live")).toBe(false);
    entries["agent:main:archived"] = { updatedAt: now };
    expect(shouldRemoveOwner("session", "agent:main:archived")).toBe(false);
    expect(shouldProtectOwner("session", "agent:main:archived")).toBe(true);
  });

  it("shares one census but rereads mutations after an owner becomes active", async () => {
    const key = cleanupRecord.ownerId;
    const archived = {
      agentId: "main",
      canonicalKey: key,
      requestedKey: key,
      storeKey: key,
      entry: { sessionId: "session-one", updatedAt: 1, archivedAt: 1 },
    };
    mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(new Map([[key, archived]]));
    mocks.resolveSessionEntryAccessTarget.mockReturnValue({
      ...archived,
      entry: { sessionId: "session-one", updatedAt: Date.now() },
    });
    const policy = createManagedWorktreeOwnerPolicy({});
    const census = await policy.prepareOwners([
      cleanupRecord,
      { ...cleanupRecord, id: "second-checkout" },
    ]);
    for (let index = 0; index < 2; index++) {
      expect(census.shouldRemoveOwner?.("session", key)).toBe(true);
      expect(census.shouldProtectOwner?.("session", key)).toBe(false);
    }
    expect(mocks.readResolvedSessionEntriesInWorker).toHaveBeenCalledTimes(1);
    expect(mocks.readResolvedSessionEntriesInWorker).toHaveBeenCalledWith(
      { cfg: {}, sessionKeys: [key] },
      "worktree",
    );
    expect(mocks.resolveSessionEntryAccessTarget).not.toHaveBeenCalled();
    expect(policy.shouldRemoveOwner("session", key)).toBe(false);
    expect(policy.shouldProtectOwner("session", key)).toBe(true);
  });

  it("defers every session owner when the census cannot establish state", async () => {
    mocks.readResolvedSessionEntriesInWorker.mockRejectedValue(
      new Error("unavailable session store"),
    );
    const census = await createManagedWorktreeOwnerPolicy({}).prepareOwners([cleanupRecord]);
    expect(census.shouldProtectOwner?.("session", cleanupRecord.ownerId)).toBe(true);
    expect(census.shouldRemoveOwner?.("session", cleanupRecord.ownerId)).toBe(false);
    expect(census.shouldProtectOwner?.("manual", cleanupRecord.ownerId)).toBe(false);
  });

  it.each(["session", "placement"])(
    "protects session owners when %s state cannot be read",
    (kind) => {
      mocks.resolveSessionEntryAccessTarget.mockReturnValue({
        agentId: "main",
        canonicalKey: "agent:main:live",
      });
      if (kind === "session") {
        mocks.resolveSessionEntryAccessTarget.mockImplementation(() => {
          throw new Error("unreadable session store");
        });
      } else {
        mocks.listForReconcile.mockImplementation(() => {
          throw new Error("unreadable related placements");
        });
      }
      const { shouldProtectOwner, shouldRemoveOwner } = createManagedWorktreeOwnerPolicy({});

      expect(shouldProtectOwner("session", "agent:main:live")).toBe(true);
      expect(shouldRemoveOwner("session", "agent:main:live")).toBe(false);
    },
  );

  it.each(["admission", "lifecycle", "remote", "claimed", "unknown-placement"])(
    "protects retired session owners with %s work",
    (kind) => {
      const key = "agent:main:archived";
      mocks.resolveSessionEntryAccessTarget.mockReturnValue({
        agentId: "main",
        canonicalKey: key,
        entry: { sessionId: "session-one", archivedAt: 1 },
      });
      if (kind === "admission") {
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
      }
      if (kind === "lifecycle") {
        mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
      }
      if (kind === "unknown-placement") {
        mocks.getMany.mockImplementation(() => {
          throw new Error("unreadable placement");
        });
      }
      if (kind === "remote" || kind === "claimed") {
        mocks.getMany.mockReturnValue(
          new Map([
            [
              "session-one",
              {
                sessionId: "session-one",
                sessionKey: key,
                state: kind === "remote" ? "active" : "local",
                generation: 1,
                ...(kind === "claimed" ? { turnClaim: { id: "active-turn" } } : {}),
              },
            ],
          ]),
        );
      }
      const policy = createManagedWorktreeOwnerPolicy({});
      expect(policy.shouldProtectOwner("session", key)).toBe(true);
      expect(policy.shouldRemoveOwner("session", key)).toBe(false);
    },
  );

  it("protects a missing session row with a cross-agent placement under its canonical key", () => {
    const key = "agent:main:missing";
    const alias = "missing-alias";
    mocks.resolveSessionEntryAccessTarget.mockReturnValue({ agentId: "main", canonicalKey: key });
    const placement = {
      sessionId: "remote-session",
      sessionKey: key,
      agentId: "other",
      state: "active",
      generation: 1,
    };
    mocks.listForReconcile.mockImplementation((sessionKey?: string) =>
      sessionKey === undefined || sessionKey === key ? [placement] : [],
    );
    mocks.getMany.mockReturnValue(new Map([[placement.sessionId, placement]]));
    const policy = createManagedWorktreeOwnerPolicy({});
    expect(policy.shouldProtectOwner("session", alias)).toBe(true);
    expect(policy.shouldRemoveOwner("session", alias)).toBe(false);
  });

  it.each(["added", "removed", "unreadable"])(
    "invalidates cleanup when a related placement is %s but ignores unrelated changes",
    (change) => {
      const key = "agent:main:missing";
      mocks.resolveSessionEntryAccessTarget.mockReturnValue({ agentId: "main", canonicalKey: key });
      const placement = {
        sessionId: "stopped-session",
        sessionKey: key,
        agentId: "other",
        state: "failed",
        generation: 1,
        environmentId: null,
      };
      const placements = [placement];
      mocks.listForReconcile.mockImplementation((sessionKey?: string) =>
        placements.filter((record) => sessionKey === undefined || record.sessionKey === sessionKey),
      );
      mocks.getMany.mockImplementation(
        (sessionIds: readonly string[]) =>
          new Map(
            placements
              .filter((record) => sessionIds.includes(record.sessionId))
              .map((record) => [record.sessionId, record]),
          ),
      );
      const policy = createManagedWorktreeOwnerPolicy({});
      expect(policy.shouldRemoveOwner("session", key)).toBe(true);

      placements.push({ ...placement, sessionId: "unrelated", sessionKey: `${key}:child` });
      expect(policy.shouldRemoveOwner("session", key)).toBe(true);
      if (change === "added") {
        placements.push({ ...placement, sessionId: "new-related" });
      } else if (change === "removed") {
        placements.splice(0, 1);
      } else {
        mocks.listForReconcile.mockImplementation(() => {
          throw new Error("unreadable related placements");
        });
      }
      expect(policy.shouldProtectOwner("session", key)).toBe(true);
      expect(policy.shouldRemoveOwner("session", key)).toBe(false);
    },
  );

  it("invalidates cleanup when a stopped placement changes generation", () => {
    const key = "agent:main:archived";
    mocks.resolveSessionEntryAccessTarget.mockReturnValue({
      agentId: "main",
      canonicalKey: key,
      entry: { sessionId: "session-one", archivedAt: 1 },
    });
    mocks.getMany.mockReturnValue(
      new Map([
        [
          "session-one",
          { sessionId: "session-one", sessionKey: key, state: "reclaimed", generation: 1 },
        ],
      ]),
    );
    const policy = createManagedWorktreeOwnerPolicy({});
    expect(policy.shouldRemoveOwner("session", key)).toBe(true);
    mocks.getMany.mockReturnValue(
      new Map([
        [
          "session-one",
          { sessionId: "session-one", sessionKey: key, state: "reclaimed", generation: 2 },
        ],
      ]),
    );
    expect(policy.shouldProtectOwner("session", key)).toBe(true);
    expect(policy.shouldRemoveOwner("session", key)).toBe(false);
  });
});
