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
  placementService: vi.fn(),
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

// mock-isolation: Tests select the real placement owner or an explicitly empty inventory.
vi.mock("../../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: mocks.placementService(),
  }),
}));
vi.mock("../../sessions/session-lifecycle-admission.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-lifecycle-admission.js")>()),
  isSessionWorkAdmissionActive: mocks.isSessionWorkAdmissionActive,
  isSessionLifecycleMutationActive: mocks.isSessionLifecycleMutationActive,
  runExclusiveSessionLifecycleMutation: mocks.runExclusiveSessionLifecycleMutation,
}));

// mock-isolation: Session metadata is synthetic; the real placement owner is exercised below.
vi.mock("../../config/sessions/session-accessor.entry.js", () => ({
  resolveSessionEntryAccessTarget: mocks.resolveSessionEntryAccessTarget,
  readResolvedSessionEntriesInWorker: mocks.readResolvedSessionEntriesInWorker,
}));

beforeEach(() => {
  mocks.placementService.mockReturnValue({
    listAsync: async () => [],
    prepareMaintenancePlacements: async () => ({
      placements: [],
      assertCurrent: () => {},
      release: () => {},
    }),
    prepareSessionPlacement: async () => ({ current: () => undefined, release: () => {} }),
  });
  mocks.resolveSessionEntryAccessTarget.mockImplementation(({ sessionKey }) => ({
    agentId: "main",
    canonicalKey: sessionKey,
    entry: { sessionId: sessionKey, archivedAt: 1 },
  }));
  mocks.readResolvedSessionEntriesInWorker.mockImplementation(
    ({ sessionKeys }) =>
      new Map(
        sessionKeys.map((key: string) => [
          key,
          mocks.resolveSessionEntryAccessTarget({ sessionKey: key }),
        ]),
      ),
  );
  mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
  mocks.isSessionLifecycleMutationActive.mockReturnValue(false);
  mocks.runExclusiveSessionLifecycleMutation.mockImplementation(
    (_operation, { run }: { run: () => Promise<unknown> }) => run(),
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

  it("classifies a large census off thread and allows archived cleanup until a placement write", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-owner-census-") };
    const store = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase({ env }),
    });
    mocks.placementService.mockReturnValue(store);
    const records = Array.from({ length: 609 }, (_, index) => ({
      ...cleanupRecord,
      id: `worktree-${index}`,
      ownerId: `agent:main:census-${index}`,
    }));
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
      const archived = records[1]!;
      await policy.withOwnerCleanup(archived, (withOwnerMutation) =>
        withOwnerMutation(async () => {
          expect(policy.readOwnerState("session", archived.ownerId)).toBe("retired");
          await store.startDispatch({
            sessionId: archived.ownerId,
            sessionKey: archived.ownerId,
            agentId: "main",
          });
          expect(policy.readOwnerState("session", archived.ownerId)).toBe("active");
        }),
      );
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("protects an archived owner when an in-process local turn starts after cleanup preparation", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-owner-local-") };
    const store = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase({ env }),
    });
    mocks.placementService.mockReturnValue(store);
    const key = cleanupRecord.ownerId;
    const policy = createManagedWorktreeOwnerPolicy({});
    await policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", key)).toBe("retired");
        await store.claimTurn({
          sessionId: key,
          sessionKey: key,
          agentId: "main",
          claimId: "cleanup-local-claim",
          runId: "cleanup-local-run",
          owner: { kind: "local" },
        });
        expect(policy.readOwnerState("session", key)).toBe("active");
      }),
    );
  });

  it("protects a missing session row with a placement under its canonical key", async () => {
    const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-owner-missing-") };
    const store = createWorkerSessionPlacementStore({
      database: openOpenClawStateDatabase({ env }),
    });
    mocks.placementService.mockReturnValue(store);
    const key = cleanupRecord.ownerId;
    mocks.resolveSessionEntryAccessTarget.mockReturnValue({ agentId: "main", canonicalKey: key });
    await store.startDispatch({ sessionId: "remote-session", sessionKey: key, agentId: "other" });
    const policy = createManagedWorktreeOwnerPolicy({});
    const census = await policy.prepareOwners([cleanupRecord]);
    expect(census.readOwnerState?.("session", key)).toBe("active");
    await policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", key)).toBe("active");
      }),
    );
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
    const cfg = { session: { store: "/worktree-cleanup-policy/sessions.json" } };
    const entered = createDeferred();
    const release = createDeferred();
    const blocker = lifecycle.runExclusiveSessionLifecycleMutation("archive", {
      scope: resolveSessionStorePathCore(cfg.session.store, { agentId: "main" }),
      identities: [key],
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
    const key = cleanupRecord.ownerId;
    mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
    const policy = createManagedWorktreeOwnerPolicy({});
    expect(policy.readOwnerState("session", key)).toBe("active");
    await policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", key)).toBe("retired");
        expect(policy.readOwnerState("session", `${key}:other`)).toBe("active");
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
        expect(policy.readOwnerState("session", key)).toBe("active");
      }),
    );
    expect(policy.readOwnerState("session", key)).toBe("active");
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
      await policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) =>
        withOwnerMutation(async () => {
          expect(policy.readOwnerState("session", key)).toBe("active");
        }),
      );
    },
  );

  it("protects recently active session owners while classifying archived and missing owners", async () => {
    const now = 1_800_000_000_000;
    const entries: Record<
      string,
      { lastInteractionAt?: number; updatedAt?: number; archivedAt?: number }
    > = {
      "agent:main:live": { lastInteractionAt: now - 1_000 },
      "agent:main:stale": { updatedAt: now - IDLE_GC_MS - 1 },
      "agent:main:archived": { updatedAt: now, archivedAt: now },
    };
    mocks.resolveSessionEntryAccessTarget.mockImplementation(({ sessionKey }) => ({
      agentId: "main",
      canonicalKey: sessionKey,
      entry: entries[sessionKey],
    }));
    const policy = createManagedWorktreeOwnerPolicy({}, () => now);
    const census = await policy.prepareOwners(
      [...Object.keys(entries), "agent:main:missing"].map((ownerId) => ({
        ...cleanupRecord,
        ownerId,
      })),
    );
    expect(census.readOwnerState?.("session", "agent:main:live")).toBe("active");
    expect(census.readOwnerState?.("session", "agent:main:stale")).toBe("idle");
    expect(census.readOwnerState?.("session", "agent:main:archived")).toBe("retired");
    expect(census.readOwnerState?.("session", "agent:main:missing")).toBe("retired");
    expect(policy.readOwnerState("manual", "agent:main:live")).toBe("other");
  });

  it.each(["failed", "missing"])(
    "defers every session owner when the census is %s",
    async (result) => {
      if (result === "failed") {
        mocks.readResolvedSessionEntriesInWorker.mockRejectedValue(
          new Error("unavailable session store"),
        );
      } else {
        mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(new Map());
      }
      const census = await createManagedWorktreeOwnerPolicy({}).prepareOwners([cleanupRecord]);
      expect(census.readOwnerState?.("session", cleanupRecord.ownerId)).toBe("active");
      expect(census.readOwnerState?.("manual", cleanupRecord.ownerId)).toBe("other");
    },
  );
});
