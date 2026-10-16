import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionReads from "../../config/sessions/session-accessor.entry-read-runtime.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { ResolvedSessionEntryStoreTarget } from "../../config/sessions/session-accessor.types.js";
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
  placementService: vi.fn(),
  isSessionWorkAdmissionActive: vi.fn(),
  isSessionLifecycleMutationActive: vi.fn(),
  runExclusiveSessionLifecycleMutation: vi.fn(),
}));

const readOwnersInWorker = sessionReads.readResolvedSessionStoreTargetsInWorker;
const readOwners = vi.spyOn(sessionReads, "readResolvedSessionStoreTargetsInWorker");

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

function target(
  key = cleanupRecord.ownerId,
  entry?: SessionEntry,
): ResolvedSessionEntryStoreTarget {
  return {
    agentId: "main",
    canonicalKey: key,
    requestedKey: key,
    storeKey: key,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    entry: entry ?? { sessionId: key, updatedAt: 1, archivedAt: 1 },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  setRuntimeConfigSnapshot({});
  mocks.placementService.mockReturnValue({
    listAsync: async () => [],
    prepareMaintenancePlacements: async () => ({
      placements: [],
      assertCurrent: () => {},
      release: () => {},
    }),
    prepareSessionPlacement: async () => ({
      prepareRead: () => undefined,
      current: () => undefined,
      release: () => {},
    }),
  });
  mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
  mocks.isSessionLifecycleMutationActive.mockReturnValue(false);
  mocks.runExclusiveSessionLifecycleMutation.mockImplementation(
    (_operation, { run }: { run: () => Promise<unknown> }) => run(),
  );
  readOwners.mockImplementation(({ sessionKeys }: { sessionKeys: readonly string[] }) =>
    Promise.resolve(new Map(sessionKeys.map((key) => [key, target(key)]))),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
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
    readOwners.mockImplementation(readOwnersInWorker);
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const key = cleanupRecord.ownerId;
      const scope = { agentId: "main", sessionKey: key };
      await replaceSessionEntry(scope, { sessionId: "real-owner", updatedAt: 1, archivedAt: 1 });
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

  it.each(["canonical-key", "shared-key", "session-id"])(
    "protects a remote placement matched by %s",
    async (match) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-owner-missing-") };
      const store = createWorkerSessionPlacementStore({
        database: openOpenClawStateDatabase({ env }),
      });
      mocks.placementService.mockReturnValue(store);
      const key = cleanupRecord.ownerId;
      readOwners.mockResolvedValue(
        new Map([
          [
            key,
            {
              ...target(key, { sessionId: "remote-session", updatedAt: 1, archivedAt: 1 }),
              ...(match !== "session-id" ? { entry: undefined } : {}),
            },
          ],
        ]),
      );
      await store.startDispatch({
        sessionId: "remote-session",
        sessionKey: match === "session-id" ? `${key}:previous` : key,
        agentId: "other",
      });
      if (match === "shared-key") {
        const claim = await store.claimTurn({
          sessionId: "local-session",
          sessionKey: key,
          agentId: "main",
          owner: { kind: "local" },
          claimId: "finished-local-claim",
          runId: "finished-local-run",
        });
        await store.releaseTurn(claim);
      }
      const policy = createManagedWorktreeOwnerPolicy({});
      const census = await policy.prepareOwners([cleanupRecord]);
      expect(census.readOwnerState?.("session", key)).toBe("active");
      await policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) =>
        withOwnerMutation(async () => {
          expect(policy.readOwnerState("session", key)).toBe("active");
        }),
      );
    },
  );

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
    readOwners.mockResolvedValue(
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
    expect(readOwners).toHaveBeenCalledTimes(1);
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
    readOwners.mockResolvedValue(
      new Map([[key, target(key, { sessionId: key, updatedAt: Date.now() })]]),
    );
    await policy.withOwnerCleanup(cleanupRecord, async () => {
      expect(policy.readOwnerState("session", key)).toBe("active");
    });
  });

  it("classifies recent, idle, archived and missing owners through the async census", async () => {
    const now = 1_800_000_000_000;
    const entries = new Map<string, ResolvedSessionEntryStoreTarget>([
      ["live", target("live", { sessionId: "live", updatedAt: now - 1_000 })],
      ["idle", target("idle", { sessionId: "idle", updatedAt: now - IDLE_GC_MS - 1 })],
      ["archived", target("archived", { sessionId: "archived", updatedAt: now, archivedAt: now })],
      ["missing", { ...target("missing"), entry: undefined }],
    ]);
    readOwners.mockResolvedValue(entries);
    const census = await createManagedWorktreeOwnerPolicy({}, () => now).prepareOwners(
      Array.from(entries.keys(), (ownerId) => ({ ...cleanupRecord, ownerId })),
    );
    expect(
      ["live", "idle", "archived", "missing"].map((id) => census.readOwnerState?.("session", id)),
    ).toEqual(["active", "idle", "retired", "retired"]);
    expect(census.readOwnerState?.("manual", "missing")).toBe("other");
  });

  it.each(["failed", "missing"])(
    "defers unreadable or missing cleanup preparation (%s)",
    async (result) => {
      if (result === "failed") {
        readOwners.mockRejectedValue(new Error("unavailable session store"));
      } else {
        readOwners.mockResolvedValue(new Map());
      }
      const policy = createManagedWorktreeOwnerPolicy({});
      const census = await policy.prepareOwners([cleanupRecord]);
      expect(census.readOwnerState?.("session", cleanupRecord.ownerId)).toBe("active");
      await expect(policy.withOwnerCleanup(cleanupRecord, async () => {})).rejects.toThrow();
    },
  );

  it("defers cleanup when placement preparation is unavailable", async () => {
    mocks.placementService.mockReturnValue({
      listAsync: async () => [],
      prepareMaintenancePlacements: async () => {
        throw new Error("unreadable placement");
      },
      prepareSessionPlacement: async () => ({
        prepareRead: () => undefined,
        current: () => undefined,
        release: () => {},
      }),
    });
    const remove = vi.fn(async () => {});
    const policy = createManagedWorktreeOwnerPolicy({});
    await expect(
      policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) => withOwnerMutation(remove)),
    ).rejects.toThrow("unreadable placement");
    expect(remove).not.toHaveBeenCalled();
  });
});
