import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { createManagedWorktreeOwnerPolicy } from "./owner-protection.js";
import { IDLE_GC_MS } from "./service.js";
import type { ManagedWorktreeRecord } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolveSessionEntryAccessTarget: vi.fn(),
  readResolvedSessionEntriesInWorker: vi.fn(),
  getMany: vi.fn(),
  listForReconcile: vi.fn(),
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

vi.mock("../../gateway/session-worker-placement-context.js", () => ({
  resolveSessionWorkerPlacementContext: () => ({
    workerSessionPlacementService: {
      getMany: mocks.getMany,
      listForReconcile: mocks.listForReconcile,
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
      new Map([[key, { agentId: "main", canonicalKey: key, entry: { sessionId, archivedAt: 1 } }]]),
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
    mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(
      new Map([
        [key, { agentId: "main", canonicalKey: key, entry: { sessionId: key, archivedAt: 1 } }],
      ]),
    );
    mocks.isSessionLifecycleMutationActive.mockReturnValue(true);
    const policy = createManagedWorktreeOwnerPolicy({});
    expect(policy.readOwnerState("session", key)).not.toBe("retired");
    await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", key)).toBe("retired");
        expect(policy.readOwnerState("session", `${key}:other`)).not.toBe("retired");
        mocks.isSessionWorkAdmissionActive.mockReturnValue(true);
        expect(policy.readOwnerState("session", key)).not.toBe("retired");
      }),
    );
    mocks.isSessionWorkAdmissionActive.mockReturnValue(false);
    expect(policy.readOwnerState("session", key)).not.toBe("retired");
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
      mocks.readResolvedSessionEntriesInWorker.mockResolvedValue(
        new Map([[key, { agentId: "main", canonicalKey: key, entry }]]),
      );
      const policy = createManagedWorktreeOwnerPolicy({});
      expect(policy.readOwnerState("session", key)).toBe("retired");
      mocks.resolveSessionEntryAccessTarget.mockClear();
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

      await policy.withOwnerCleanup(cleanupRecord, async (withOwnerMutation) => {
        expect(mocks.resolveSessionEntryAccessTarget).not.toHaveBeenCalled();
        await withOwnerMutation(async () => {
          expect(policy.readOwnerState("session", key)).toBe("active");
        });
      });
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
    const { readOwnerState } = createManagedWorktreeOwnerPolicy({}, () => now);

    expect(readOwnerState("session", "agent:main:live")).toBe("active");
    expect(readOwnerState("session", "agent:main:stale")).toBe("idle");
    expect(readOwnerState("manual", "agent:main:live")).toBe("other");
    expect(readOwnerState("session", "agent:main:archived")).toBe("retired");
    expect(readOwnerState("session", "agent:main:missing")).toBe("retired");
    expect(readOwnerState("manual", "agent:main:missing")).toBe("other");
    entries["agent:main:archived"] = { updatedAt: now };
    expect(readOwnerState("session", "agent:main:archived")).toBe("active");
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
      expect(census.readOwnerState?.("session", key)).toBe("retired");
    }
    expect(mocks.readResolvedSessionEntriesInWorker).toHaveBeenCalledTimes(1);
    expect(mocks.readResolvedSessionEntriesInWorker).toHaveBeenCalledWith(
      { cfg: {}, sessionKeys: [key] },
      "worktree",
    );
    expect(mocks.resolveSessionEntryAccessTarget).not.toHaveBeenCalled();
    await policy.withOwnerCleanup(cleanupRecord, (withOwnerMutation) =>
      withOwnerMutation(async () => {
        expect(policy.readOwnerState("session", key)).toBe("active");
      }),
    );
    expect(mocks.readResolvedSessionEntriesInWorker).toHaveBeenCalledTimes(1);
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
      expect(mocks.resolveSessionEntryAccessTarget).not.toHaveBeenCalled();
    },
  );

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
      const { readOwnerState } = createManagedWorktreeOwnerPolicy({});

      expect(readOwnerState("session", "agent:main:live")).toBe("active");
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
      expect(policy.readOwnerState("session", key)).toBe("active");
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
    expect(policy.readOwnerState("session", alias)).toBe("active");
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
      expect(policy.readOwnerState("session", key)).toBe("retired");

      placements.push({ ...placement, sessionId: "unrelated", sessionKey: `${key}:child` });
      expect(policy.readOwnerState("session", key)).toBe("retired");
      if (change === "added") {
        placements.push({ ...placement, sessionId: "new-related" });
      } else if (change === "removed") {
        placements.splice(0, 1);
      } else {
        mocks.listForReconcile.mockImplementation(() => {
          throw new Error("unreadable related placements");
        });
      }
      expect(policy.readOwnerState("session", key)).toBe("active");
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
    expect(policy.readOwnerState("session", key)).toBe("retired");
    mocks.getMany.mockReturnValue(
      new Map([
        [
          "session-one",
          { sessionId: "session-one", sessionKey: key, state: "reclaimed", generation: 2 },
        ],
      ]),
    );
    expect(policy.readOwnerState("session", key)).toBe("active");
  });
});
