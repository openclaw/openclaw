import { createHash } from "node:crypto";
import path from "node:path";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorktreeAllocationGuard } from "./allocation.js";
import type { WorktreeGitPolicy } from "./checkout-git-config.js";
import type { updateRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService, WorktreeSnapshotError } from "./service.js";
import type {
  CreateManagedWorktreeParams,
  ManagedWorktreeRecord,
  ProvisionedFileState,
  WorktreeSourceStage,
} from "./types.js";

type RegistryPatch = Parameters<typeof updateRegistryWorktree>[2];
type GitOptions = { beforeRun?: () => void; signal?: AbortSignal };
const fixture = vi.hoisted(() => ({
  records: new Map<string, ManagedWorktreeRecord>(),
  ledger: new Map<string, readonly string[] | readonly ProvisionedFileState[]>(),
  events: [] as string[],
  allocationDepth: 0,
  checkoutDepth: 0,
  checkoutPresent: false,
  livePayload: undefined as string | undefined,
  oldChunksPresent: true,
  snapshotCommit: "saved-snapshot",
  restoreRefCleanup: vi.fn<() => void>(),
  snapshot:
    vi.fn<() => Promise<{ snapshotRef: string; provisionedState: ProvisionedFileState[] }>>(),
  forbidden: vi.fn(() => {
    throw new Error("Restore source controls must not reach native filesystem, Git, or SQLite");
  }),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    realpath: async (target: string) => {
      if (target !== repoRoot && target !== checkoutPath) {
        return fixture.forbidden();
      }
      return target;
    },
    mkdir: async () => undefined,
    rmdir: async () => undefined,
    rm: fixture.forbidden,
    stat: fixture.forbidden,
    readFile: fixture.forbidden,
    writeFile: fixture.forbidden,
    readdir: fixture.forbidden,
  },
}));
vi.mock("../../infra/node-sqlite.js", () => ({ openNodeSqliteDatabase: fixture.forbidden }));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: fixture.forbidden }));
vi.mock("../../config/paths.js", () => ({ resolveStateDir: () => "/synthetic-state" }));
vi.mock("../../infra/errors.js", () => ({
  isMissingPathError: fixture.forbidden,
  formatErrorMessage: fixture.forbidden,
}));
vi.mock("../../infra/path-guards.js", () => ({ isPathInside: fixture.forbidden }));
vi.mock("../../infra/git-operation-timing.js", () => ({
  startGitOperationTiming: () => undefined,
}));
vi.mock("../../infra/git-read-cache.js", () => ({ runGitReadOperation: fixture.forbidden }));
vi.mock("../../infra/git-worker.js", () => ({ runGitWorkerOperation: fixture.snapshot }));
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => ({ warn: vi.fn() }) }));
vi.mock("../../process/exec.js", () => ({ runCommandWithTimeout: fixture.forbidden }));
vi.mock("../../process/command-error.js", () => ({ createCommandError: fixture.forbidden }));
vi.mock("../session-slug.js", () => ({ createCrustaceanSlug: fixture.forbidden }));
vi.mock("./allocation.js", () => ({
  withWorktreeAllocationLease: async <T>(
    params: { signal?: AbortSignal; commitGuard?: () => void },
    run: (guard: WorktreeAllocationGuard) => Promise<T>,
  ) => {
    if (fixture.allocationDepth !== 0) {
      throw new Error(
        "Preparation cleanup must reacquire allocation after the original scope exits",
      );
    }
    fixture.allocationDepth += 1;
    fixture.events.push("allocation-enter");
    let active = true;
    const assertOwned = () => {
      if (!active) {
        throw new Error("Allocation scope ended");
      }
    };
    try {
      return await run({
        signal: params.signal,
        commitGuard: () => {
          assertOwned();
          params.signal?.throwIfAborted();
          params.commitGuard?.();
        },
        rollbackGuard: assertOwned,
      });
    } finally {
      active = false;
      fixture.allocationDepth -= 1;
      fixture.events.push("allocation-exit");
    }
  },
}));
// This synthetic fixture tests trusted restore/rollback custody. Actual source-only
// policy and process execution are covered by service.source-only-filters.test.ts.
vi.mock("../../gateway/worker-environments/local-workspace-store.js", () => ({
  localWorkspaceStore: () => ({ get: () => undefined }),
}));
vi.mock("./checkout-policy.js", async () => {
  const git = await import("./git.js");
  return {
    usesSourceOnlyWorktreeGit: async () => false,
    withManagedWorktreeGit: async <T>(
      _params: unknown,
      run: (policy: WorktreeGitPolicy) => Promise<T>,
    ) =>
      run({
        sourceOnly: false,
        run: git.runGit,
        require: git.requireGit,
        worker: { text: fixture.forbidden, buffered: fixture.forbidden },
        withContentEnvironment: fixture.forbidden,
      }),
  };
});
vi.mock("./base-ref.js", () => ({ resolveWorktreeBase: fixture.forbidden }));
vi.mock("./capacity.js", () => ({
  directorySizeBytes: fixture.forbidden,
  estimateWorktreeGitBytes: fixture.forbidden,
  estimateWorktreeCheckoutTransitionBytes: async () => ({
    targetBytes: 10,
    changedBytes: 5,
    requiresFullCheckout: false,
  }),
  requireWorktreeDiskSpace: () => {},
  WORKTREE_SETUP_HEADROOM_BYTES: 0,
}));
vi.mock("./checkout-profiles.js", () => ({ resolveWorktreeSourceProfile: fixture.forbidden }));
vi.mock("./checkout.js", () => ({
  addManagedWorktree: async (params: { commitGuard: () => void }) => {
    params.commitGuard();
    fixture.checkoutPresent = true;
    fixture.events.push("checkout-restored");
    return { code: 0, stdout: "", stderr: "", templateCloned: false };
  },
  materializeManagedWorktree: async (_params: unknown, options: GitOptions) => {
    options.signal?.throwIfAborted();
    options.beforeRun?.();
    return { code: 0, stdout: "", stderr: "" };
  },
  collectWorktreeTemplates: fixture.forbidden,
  WORKTREE_TEMPLATE_DIRECTORY: "templates",
}));
vi.mock("./empty-source.js", () => ({
  ensureEmptyWorktreeSource: fixture.forbidden,
  removeUnusedEmptyWorktreeSource: fixture.forbidden,
}));
vi.mock("./git-lock.js", () => ({
  lockState: async () => ({ kind: "none" }),
  createWorktreeLockPrefilter: fixture.forbidden,
  lockWorktreeForProcess: fixture.forbidden,
  unlockWorktree: fixture.forbidden,
}));
vi.mock("./git.js", () => ({
  runGitBytes: fixture.forbidden,
  runGitBuffered: fixture.forbidden,
  resolveGitRepositoryPaths: async () => ({ canonicalRoot: repoRoot, commonDir }),
  worktreePathExists: async (target: string) =>
    target === repoRoot || (target === checkoutPath && fixture.checkoutPresent),
  runGit: async (_root: string, args: string[], options?: GitOptions) => {
    options?.signal?.throwIfAborted();
    options?.beforeRun?.();
    if (args.join(" ") === "config --get remote.origin.url") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "show-ref") {
      return { code: 1, stdout: "", stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      fixture.events.push("checkout-removed");
      fixture.checkoutPresent = false;
      fixture.livePayload = undefined;
      return { code: 0, stdout: "", stderr: "" };
    }
    throw new Error(`Unexpected synthetic Git command: ${args.join(" ")}`);
  },
  requireGit: async (_root: string, args: string[], options?: GitOptions) => {
    options?.signal?.throwIfAborted();
    options?.beforeRun?.();
    if (args[0] === "rev-parse") {
      if (args.at(-1) === `${snapshotRef}^{commit}`) {
        return fixture.snapshotCommit;
      }
      if (args.at(-1) === "saved-snapshot^" || args.at(-1) === "new-snapshot^") {
        return "branch-head";
      }
    }
    if (args[0] === "update-ref") {
      if (args[1] === "-d" && args.length === 3) {
        fixture.restoreRefCleanup();
      }
      return "";
    }
    if (args[0] === "read-tree" || args[0] === "reset" || args[0] === "branch") {
      return "";
    }
    throw new Error(`Unexpected synthetic Git command: ${args.join(" ")}`);
  },
  commandError: (label: string) => new Error(label),
  listGitWorktrees: fixture.forbidden,
  WORKTREE_CHECKOUT_TIMEOUT_MS: 300_000,
}));
vi.mock("./repository-paths.js", () => ({
  resolveCheckoutRootFromRealPath: async (target: string) => target,
}));
vi.mock("./provisioned-files.js", () => ({
  restoreProvisionedFiles: async () => {
    fixture.livePayload = "restored provisioned content";
  },
  provisionIncludedFiles: fixture.forbidden,
  snapshotProvisionedFiles: fixture.forbidden,
  SNAPSHOT_CHUNK_BYTES: 1024,
}));
vi.mock("./registry.js", () => ({
  getRegistryWorktree: (_env: unknown, id: string) => {
    const record = fixture.records.get(id);
    return record ? { ...record } : undefined;
  },
  listRegistryWorktrees: () => Array.from(fixture.records.values(), (record) => ({ ...record })),
  findLiveRegistryWorktreeByOwner: () => undefined,
  findLiveRegistryWorktreeByPath: fixture.forbidden,
  getRegistryWorktreeProvisionedPaths: (_env: unknown, id: string) =>
    fixture.ledger.get(id)?.map((entry) => (typeof entry === "string" ? entry : entry.path)),
  getRegistryWorktreeProvisionedState: (_env: unknown, id: string) => {
    const data = fixture.ledger.get(id);
    return data?.every((entry) => typeof entry !== "string") ? data : undefined;
  },
  updateRegistryWorktree: (_env: unknown, id: string, patch: RegistryPatch) => {
    const existing = fixture.records.get(id);
    if (!existing) {
      throw new Error("Synthetic registry row is absent");
    }
    const { repositoryIdentity, provisionedPaths, provisionedState, ...recordPatch } = patch;
    fixture.records.set(id, { ...existing, ...recordPatch, ...repositoryIdentity });
    if (provisionedState !== undefined || provisionedPaths !== undefined) {
      fixture.ledger.set(id, provisionedState ?? provisionedPaths ?? []);
    }
  },
  clearRegistryWorktreeProvisionedChunks: () => {
    fixture.oldChunksPresent = false;
  },
  deleteRegistryWorktree: fixture.forbidden,
  insertRegistryWorktree: fixture.forbidden,
  WorktreeRemovalContentionError: class extends Error {},
}));
vi.mock("./removal-git.js", () => ({
  requireManagedWorktreeHead: async () => "branch-head",
  prepareSnapshotBranchDeletion: async () => ({}),
}));
vi.mock("./run-lease.js", () => ({
  claimWorktreeRemoval: () => {
    if (fixture.allocationDepth !== 1 || fixture.checkoutDepth !== 1) {
      throw new Error("Compensation must enter allocation then checkout custody before removal");
    }
    fixture.events.push("removal-claimed");
  },
  abortWorktreeRemoval: () => fixture.events.push("removal-aborted"),
  finalizeWorktreeRemoval: () => fixture.events.push("removal-finalized"),
  hasLiveWorktreeRunLease: fixture.forbidden,
}));
vi.mock("./template-registry.js", () => ({ hasTemplates: fixture.forbidden }));

const repoRoot = path.resolve("/synthetic-repository");
const commonDir = path.join(repoRoot, ".git");
const checkoutPath = path.resolve("/synthetic-worktrees/repository/restored");
const snapshotRef = "refs/openclaw/snapshots/saved-worktree";
const removed: ManagedWorktreeRecord = {
  id: "saved-worktree",
  name: "restored",
  repoRoot,
  repoFingerprint: createHash("sha256").update(`${commonDir}\n`).digest("hex").slice(0, 16),
  path: checkoutPath,
  branch: "openclaw/restored",
  baseRef: "main",
  ownerKind: "manual",
  snapshotRef,
  createdAt: 10,
  lastActiveAt: 20,
  removedAt: 30,
};
const provisioned: ProvisionedFileState[] = [{ path: "local.env", mode: 0o600, chunks: 1 }];
const withRollback: NonNullable<CreateManagedWorktreeParams["withRollback"]> = async (run) => {
  if (fixture.allocationDepth !== 1) {
    throw new Error("Rollback checkout custody entered before allocation");
  }
  fixture.checkoutDepth += 1;
  fixture.events.push("rollback-checkout-enter");
  try {
    return await run(() => {
      if (fixture.checkoutDepth !== 1) {
        throw new Error("Rollback checkout scope ended");
      }
    });
  } finally {
    fixture.checkoutDepth -= 1;
    fixture.events.push("rollback-checkout-exit");
  }
};

function service() {
  return new ManagedWorktreeService({
    env: { OPENCLAW_STATE_DIR: "/synthetic-state" },
    now: () => 40,
    getConfig: () => ({ worktreeAcceleration: false }),
  });
}

function unwindSource(failure: Error): WorktreeSourceStage {
  return async (run) => {
    await run({ assertCurrent: () => {}, assertCheckoutCurrent: () => {} });
    throw failure;
  };
}

function restoredRecord(): ManagedWorktreeRecord {
  const record = { ...removed, lastActiveAt: 40 };
  delete record.removedAt;
  return record;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.records.clear();
  fixture.records.set(removed.id, { ...removed });
  fixture.ledger.clear();
  fixture.ledger.set(removed.id, provisioned);
  fixture.events.length = 0;
  fixture.allocationDepth = 0;
  fixture.checkoutDepth = 0;
  fixture.checkoutPresent = false;
  fixture.livePayload = undefined;
  fixture.oldChunksPresent = true;
  fixture.snapshotCommit = "saved-snapshot";
  fixture.restoreRefCleanup.mockReset();
  fixture.snapshot.mockReset().mockImplementation(async () => {
    fixture.events.push("snapshot-completed");
    fixture.snapshotCommit = "new-snapshot";
    return { snapshotRef, provisionedState: provisioned };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(fixture.forbidden).not.toHaveBeenCalled();
  expect(fixture.allocationDepth).toBe(0);
  expect(fixture.checkoutDepth).toBe(0);
});

it.each(["captured", "failed"] as const)(
  "compensates an acknowledged restore only with a complete recovery snapshot (%s)",
  async (snapshotOutcome) => {
    const owner = service();
    const rollback = vi.spyOn(owner, "rollbackPreparation");
    const sourceFailure = new Error("Source unwind failed after complete restore");
    const snapshotFailure = new Error("Recovery snapshot could not be captured");
    if (snapshotOutcome === "failed") {
      fixture.snapshot.mockRejectedValue(snapshotFailure);
    }
    const failure = await owner
      .createWithOutcome({
        repoRoot,
        name: removed.name,
        withSource: unwindSource(sourceFailure),
        withRollback,
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(rollback).toHaveBeenCalledExactlyOnceWith(restoredRecord(), withRollback);
    expect(fixture.snapshot).toHaveBeenCalledOnce();
    expect(fixture.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "worktree.snapshot",
        input: expect.objectContaining({
          worktreeId: removed.id,
          checkoutPath,
          provisionedPaths: ["local.env"],
        }),
      }),
      expect.any(Object),
    );
    const record = fixture.records.get(removed.id);
    if (snapshotOutcome === "captured") {
      expect(failure).toBe(sourceFailure);
      expect(record).toMatchObject({ removedAt: 40, snapshotRef });
      expect(fixture.snapshotCommit).toBe("new-snapshot");
      expect(fixture.ledger.get(removed.id)).toEqual(provisioned);
      expect(fixture.checkoutPresent).toBe(false);
      expect(fixture.events.indexOf("snapshot-completed")).toBeLessThan(
        fixture.events.indexOf("checkout-removed"),
      );
    } else {
      expect(failure).toBeInstanceOf(AggregateError);
      if (!(failure instanceof AggregateError)) {
        throw new Error("Expected primary source failure and recovery failure");
      }
      expect(failure.cause).toBe(sourceFailure);
      expect(failure.errors[0]).toBe(sourceFailure);
      expect(failure.errors[1]).toBeInstanceOf(WorktreeSnapshotError);
      expect(collectNestedErrorCandidates(failure)).toContain(snapshotFailure);
      expect(record?.removedAt).toBeUndefined();
      expect(fixture.checkoutPresent).toBe(true);
      expect(fixture.livePayload).toBe("restored provisioned content");
      expect(fixture.ledger.get(removed.id)).toEqual(["local.env"]);
      expect(fixture.oldChunksPresent).toBe(false);
      expect(fixture.events).not.toContain("checkout-removed");
      expect(fixture.events).toContain("removal-aborted");
    }
  },
);

it("does not claim a restore whose final recovery-ref cleanup never acknowledged completion", async () => {
  const owner = service();
  const rollback = vi.spyOn(owner, "rollbackPreparation");
  const restoreFailure = new Error("Final restore recovery-ref cleanup did not complete");
  fixture.restoreRefCleanup.mockImplementation(() => {
    throw restoreFailure;
  });
  await expect(
    owner.createWithOutcome({
      repoRoot,
      name: removed.name,
      withSource: unwindSource(new Error("Source must not reach successful unwind")),
      withRollback,
    }),
  ).rejects.toBe(restoreFailure);
  expect(rollback).not.toHaveBeenCalled();
  expect(fixture.snapshot).not.toHaveBeenCalled();
  expect(fixture.records.get(removed.id)?.removedAt).toBeUndefined();
  expect(fixture.checkoutPresent).toBe(true);
  expect(fixture.livePayload).toBe("restored provisioned content");
  expect(fixture.events).not.toContain("removal-claimed");
});

it("does not claim an already live checkout after source unwind", async () => {
  fixture.records.set(removed.id, restoredRecord());
  fixture.ledger.set(removed.id, ["local.env"]);
  fixture.checkoutPresent = true;
  fixture.livePayload = "existing user content";
  const owner = service();
  const rollback = vi.spyOn(owner, "rollbackPreparation");
  const failure = new Error("Source unwind after live reuse");
  await expect(
    owner.createWithOutcome({
      repoRoot,
      name: removed.name,
      withSource: unwindSource(failure),
      withRollback,
    }),
  ).rejects.toBe(failure);
  expect(rollback).not.toHaveBeenCalled();
  expect(fixture.snapshot).not.toHaveBeenCalled();
  expect(fixture.checkoutPresent).toBe(true);
  expect(fixture.livePayload).toBe("existing user content");
});

it("still permits discarding a fresh preparation when its first snapshot fails", async () => {
  const fresh = restoredRecord();
  delete fresh.snapshotRef;
  fixture.records.set(fresh.id, fresh);
  fixture.ledger.set(fresh.id, ["local.env"]);
  fixture.checkoutPresent = true;
  fixture.livePayload = "new preparation output";
  fixture.snapshot.mockRejectedValue(new Error("First preparation snapshot failed"));
  await service().rollbackPreparation(fresh, withRollback);
  expect(fixture.checkoutPresent).toBe(false);
  expect(fixture.records.get(fresh.id)).toMatchObject({ removedAt: 40 });
  expect(fixture.records.get(fresh.id)?.snapshotRef).toBeUndefined();
  expect(fixture.events).toContain("checkout-removed");
});
