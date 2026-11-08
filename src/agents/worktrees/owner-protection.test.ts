import "../../test-utils/prepare-compiled-subprocesses.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  isSessionControllerWorkActive: vi.fn(),
  isSessionMutationActive: vi.fn(),
  runSessionMutation: vi.fn(),
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
const key = cleanupRecord.ownerId;
let policy: ReturnType<typeof createManagedWorktreeOwnerPolicy>;
function ownerEntry(entry?: SessionEntry) {
  readOwners.mockResolvedValue(new Map([[key, { ...target(), entry }]]));
}
const emptyPlacementService = {
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
};

// mock-isolation: Tests select the real placement owner or an explicitly empty inventory.
vi.mock("../../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: mocks.placementService(),
  }),
}));
// mock-isolation: Select GC activity and mutation facts; retain real maintenance protection.
vi.mock("../../sessions/session-controller.lifecycle.js", async () => {
  const {
    collectSessionControllerTargets,
    collectSessionMutationIdentities,
    observeSessionControllerProtectionReleases,
  } = await import("../../sessions/session-controller.lifecycle-projections.js");
  return {
    collectSessionControllerTargets,
    collectSessionMutationIdentities,
    observeSessionControllerProtectionReleases,
    isSessionControllerWorkActive: mocks.isSessionControllerWorkActive,
    isSessionMutationActive: mocks.isSessionMutationActive,
    runSessionMutation: mocks.runSessionMutation,
  };
});

function target(
  sessionKey = cleanupRecord.ownerId,
  entry?: SessionEntry,
): ResolvedSessionEntryStoreTarget {
  return {
    agentId: "main",
    canonicalKey: sessionKey,
    requestedKey: sessionKey,
    storeKey: sessionKey,
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    entry: entry ?? { sessionId: sessionKey, updatedAt: 1, archivedAt: 1 },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  setRuntimeConfigSnapshot({});
  mocks.placementService.mockReturnValue(emptyPlacementService);
  mocks.isSessionControllerWorkActive.mockReturnValue(false);
  mocks.isSessionMutationActive.mockReturnValue(false);
  mocks.runSessionMutation.mockImplementation(({ run }: { run: () => Promise<unknown> }) => run());
  readOwners.mockImplementation(({ sessionKeys }: { sessionKeys: readonly string[] }) =>
    Promise.resolve(new Map(sessionKeys.map((sessionKey) => [sessionKey, target(sessionKey)]))),
  );
  policy = createManagedWorktreeOwnerPolicy({});
});

afterEach(() => {
  vi.clearAllMocks();
  clearRuntimeConfigSnapshot();
});
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

function placementStore(prefix: string) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make(prefix) };
  const store = createWorkerSessionPlacementStore({
    database: openOpenClawStateDatabase({ env }),
  });
  mocks.placementService.mockReturnValue(store);
  return store;
}
const dispatch = (
  store: ReturnType<typeof placementStore>,
  sessionKey: string,
  agentId = "main",
  sessionId = sessionKey,
) => store.startDispatch({ sessionId, sessionKey, agentId });
const localTurn = (sessionId = key, prefix = "cleanup-local") => ({
  sessionId,
  sessionKey: key,
  agentId: "main",
  claimId: `${prefix}-claim`,
  runId: `${prefix}-run`,
  owner: { kind: "local" as const },
});
const mutateOwner = (run: () => Promise<void>) =>
  policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) => withOwnerMutation(run));
const expectState = (state: ReturnType<typeof policy.readOwnerState>, ownerId = key) =>
  expect(policy.readOwnerState("session", ownerId)).toBe(state);
const expectCleanupState = (state: ReturnType<typeof policy.readOwnerState>) =>
  policy.withOwnerCleanup(cleanupRecord, async () => expectState(state));
const emitRemoval = (sessionKey: string) =>
  sessionChanges.emit({ sessionKey, scope: "session-entry", facts: { kind: "removed" } });

it("uses the worker for cleanup facts and invalidates them after an in-process write", async () => {
  const stateDir = tempDirs.make("worktree-owner-worker-");
  readOwners.mockImplementation(readOwnersInWorker);
  await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
    const scope = { agentId: "main", sessionKey: key };
    await replaceSessionEntry(scope, { sessionId: "real-owner", updatedAt: 1, archivedAt: 1 });
    const sql = observeHostDataSql();
    try {
      await policy.withOwnerCleanup(cleanupRecord, async () => {
        expectState("retired");
        expect(sql.queries).toEqual([]);
        sql.restore();
        await replaceSessionEntry(scope, { sessionId: "real-owner", updatedAt: Date.now() });
        expectState("active");
      });
    } finally {
      sql.restore();
      await cleanupSessionStateForTest({ stateDir });
    }
  });
});

it("classifies a large census off thread and allows archived cleanup until a placement write", async () => {
  const store = placementStore("worktree-owner-census-");
  const records = Array.from({ length: 609 }, (_, index) => ({
    ...cleanupRecord,
    id: `worktree-${index}`,
    ownerId: `agent:main:census-${index}`,
  }));
  const live = records[0]!.ownerId;
  await dispatch(store, live);
  const sql = observeHostDataSql();
  try {
    const census = await policy.prepareOwners(records);
    expect(records.map(({ ownerId }) => census.readOwnerState?.("session", ownerId))).toEqual([
      "active",
      ...Array.from({ length: records.length - 1 }, () => "retired"),
    ]);
    expect(sql.queries).toEqual([]);
    const archived = records[1]!;
    await policy.withOwnerCleanup(archived, (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expectState("retired", archived.ownerId);
        await dispatch(store, archived.ownerId);
        expectState("active", archived.ownerId);
      }),
    );
    expect(sql.queries).toEqual([]);
  } finally {
    sql.restore();
  }
});

it("protects an archived owner when an in-process local turn starts after cleanup preparation", async () => {
  const store = placementStore("worktree-owner-local-");
  await mutateOwner(async () => {
    expectState("retired");
    await store.claimTurn(localTurn());
    expectState("active");
  });
});

it.each(["canonical-key", "shared-key", "session-id"])(
  "protects a remote placement matched by %s",
  async (match) => {
    const store = placementStore("worktree-owner-missing-");
    ownerEntry(
      match === "session-id"
        ? { sessionId: "remote-session", updatedAt: 1, archivedAt: 1 }
        : undefined,
    );
    await dispatch(
      store,
      match === "session-id" ? `${key}:previous` : key,
      "other",
      "remote-session",
    );
    if (match === "shared-key") {
      const claim = await store.claimTurn(localTurn("local-session", "finished-local"));
      await store.releaseTurn(claim);
    }
    const census = await policy.prepareOwners([cleanupRecord]);
    expect(census.readOwnerState?.("session", key)).toBe("active");
    await mutateOwner(async () => expectState("active"));
  },
);

it("cancels queued cleanup before the preceding session mutation finishes", async ({ signal }) => {
  const lifecycle = await vi.importActual<
    typeof import("../../sessions/session-controller.lifecycle.js")
  >("../../sessions/session-controller.lifecycle.js");
  mocks.runSessionMutation.mockImplementation(lifecycle.runSessionMutation);
  const sessionId = "queued-cleanup-session";
  ownerEntry({ sessionId, updatedAt: 1, archivedAt: 1 });
  const cfg = { session: { store: "/worktree-cleanup-policy/sessions.json" } };
  const entered = createDeferred();
  const release = createDeferred();
  const blocker = lifecycle.runSessionMutation({
    policy: "wait",
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
  await mutateOwner(async () => {
    expectState("retired");
    emitRemoval(`${key}:unrelated`);
    expectState("retired");
    emitRemoval(key);
    expectState("active");
  });
  expect(readOwners).toHaveBeenCalledTimes(1);
  expectState("active");
  await expectCleanupState("retired");
});

it("exempts its own cleanup fence while preserving new work admission", async () => {
  mocks.isSessionMutationActive.mockReturnValue(true);
  await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) => {
    expectState("active");
    await withOwnerMutation(async () => {
      expectState("retired");
      expectState("active", `${key}:other`);
      mocks.isSessionControllerWorkActive.mockReturnValue(true);
      expectState("active");
    });
  });
});

it("defers an owner that became active after the census", async () => {
  const census = await policy.prepareOwners([cleanupRecord]);
  expect(census.readOwnerState?.("session", key)).toBe("retired");
  ownerEntry({ sessionId: key, updatedAt: Date.now() });
  await expectCleanupState("active");
});

it("classifies recent, idle, archived and missing owners through the async census", async () => {
  const now = Date.now();
  const entries = new Map<string, ResolvedSessionEntryStoreTarget>([
    ["live", target("live", { sessionId: "live", updatedAt: now - 1_000 })],
    ["idle", target("idle", { sessionId: "idle", updatedAt: now - IDLE_GC_MS - 1 })],
    ["archived", target("archived", { sessionId: "archived", updatedAt: now, archivedAt: now })],
    ["missing", { ...target("missing"), entry: undefined }],
  ]);
  readOwners.mockResolvedValue(entries);
  const census = await policy.prepareOwners(
    Array.from(entries.keys(), (ownerId) => ({ ...cleanupRecord, ownerId })),
  );
  expect(
    ["live", "idle", "archived", "missing"].map((id) => census.readOwnerState?.("session", id)),
  ).toEqual(["active", "idle", "retired", "retired"]);
  expect(census.readOwnerState?.("manual", "missing")).toBe("other");
});

it.each([
  ["failed", () => readOwners.mockRejectedValue(new Error("unavailable session store"))],
  ["missing", () => readOwners.mockResolvedValue(new Map())],
] as const)("defers unreadable or missing cleanup preparation (%s)", async (_result, arrange) => {
  arrange();
  const census = await policy.prepareOwners([cleanupRecord]);
  expect(census.readOwnerState?.("session", cleanupRecord.ownerId)).toBe("active");
  await expect(policy.withOwnerCleanup(cleanupRecord, async () => {})).rejects.toThrow();
});

it("defers cleanup when placement preparation is unavailable", async () => {
  mocks.placementService.mockReturnValue({
    ...emptyPlacementService,
    prepareMaintenancePlacements: async () => {
      throw new Error("unreadable placement");
    },
  });
  const remove = vi.fn(async () => {});
  await expect(mutateOwner(remove)).rejects.toThrow("unreadable placement");
  expect(remove).not.toHaveBeenCalled();
});
