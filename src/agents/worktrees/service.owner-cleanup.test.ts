import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import * as sessionReads from "../../config/sessions/session-accessor.entry-read-runtime.js";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.sqlite-entry.js";
import { deleteSessionEntryLifecycle } from "../../config/sessions/session-accessor.sqlite-lifecycle.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { worktreesHandlers } from "../../gateway/server-methods/worktrees.js";
import { createSessionWorktreeBinding } from "../../gateway/session-worktree-binding.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { controllerGate } from "../../sessions/controller-core.test-support.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import {
  isSessionControllerWorkActive,
  isSessionMutationActive,
} from "../../sessions/session-controller.lifecycle.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import * as checkoutGitOwner from "./checkout-git-config.js";
import * as checkoutInspection from "./checkout-inspection.js";
import { executeGitWorktreeOperation } from "./git-worktree-operations.runtime.js";
import * as gitOwner from "./git.js";
import { deferWorktreeCleanup } from "./registry-retirement.js";
import { updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import { acquireWorktreeRunLease } from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import {
  git,
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeRecord, ManagedWorktreeRunEndCleanup } from "./types.js";

let placements: ReturnType<typeof createWorkerSessionPlacementStore>;
const key = "agent:main:conditional-cleanup";
const day = 24 * 60 * 60 * 1000;
const initialize = useManagedWorktreeTestRepository(async (repo) => {
  await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\nnode_modules/\n");
  await git(repo, "add", ".gitignore");
  await git(repo, "commit", "-m", "ignore fixture files");
  await git(repo, "push", "origin", "main");
});
let stateDir: string;
let record: ManagedWorktreeRecord;
let service: ManagedWorktreeService;
let cutoff: number;
const temps = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await cleanupSessionStateForTest({ stateDir });
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeEach(async () => {
  stateDir = temps.make("worktree-owner-conditional-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  setRuntimeConfigSnapshot({});
  placements = createWorkerSessionPlacementStore({ database: openOpenClawStateDatabase() });
  const repoRoot = await initialize(stateDir);
  cutoff = Date.now() - 2 * day;
  service = new ManagedWorktreeService({ env: process.env, getConfig: () => ({}) });
  const repository = await service.resolveRepositoryIdentity(repoRoot);
  record = await materializeManagedWorktreeFixture({
    env: process.env,
    stateDir,
    repoRoot,
    repoFingerprint: repository.fingerprint,
    name: "terminal",
    ownerKind: "session",
    ownerId: key,
    now: cutoff,
  });
  await ownerEntry();
});
const ownerEntry = (patch: Partial<SessionEntry> = {}) =>
  replaceSessionEntry(
    { agentId: "main", sessionKey: key },
    {
      sessionId: "terminal-owner",
      updatedAt: cutoff,
      status: "done",
      worktree: createSessionWorktreeBinding(record, record.repoRoot),
      ...patch,
    },
  );
const registry = () => getRegistryWorktree(process.env, record.id);
const noPendingRemoval = () =>
  expect(
    git(record.repoRoot, "show-ref", "--verify", `refs/openclaw/removals/${record.id}`),
  ).rejects.toThrow();
const afterInspection = (run: () => Promise<unknown>, kind = "lossless") => {
  const inspect = checkoutInspection.inspectManagedWorktreeCheckout;
  vi.spyOn(checkoutInspection, "inspectManagedWorktreeCheckout").mockImplementation(
    async (...args) => {
      const result = await inspect(...args);
      if (args[1] === kind) {
        await run();
      }
      return result;
    },
  );
};
const remove = () => {
  const options = { ownerCleanup: { terminalBefore: cutoff } };
  return service.removeIfLossless(record.id, options);
};

it("retains a terminal owner resumed after listing without a worktree lease", async () => {
  expect((await service.listRegistryRecords())[0]?.id).toBe(record.id);
  const scope = resolveSessionStorePathCore(undefined, { agentId: "main" });
  const gate = controllerGate();
  const turn = withSessionTurn(
    { storePath: scope, sessionKey: key, sessionId: "terminal-owner" },
    gate.run,
  );
  await gate.entered;
  try {
    expect(isSessionControllerWorkActive(scope, [key, "terminal-owner"])).toBe(true);
    await expect(remove()).resolves.toBe(false);
    expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("base\n");
    expect(getRegistryWorktree(process.env, record.id)?.runEndCleanup?.outcome).toBe(
      "retained-busy",
    );
  } finally {
    gate.release();
    await turn;
  }
});

it("retains ignored user files outside snapshot custody", async () => {
  await fs.writeFile(path.join(record.path, "ignored.txt"), "only copy\n");
  await expect(remove()).resolves.toBe(false);
  expect(await fs.readFile(path.join(record.path, "ignored.txt"), "utf8")).toBe("only copy\n");
  expect(registry()?.runEndCleanup?.reason).toContain("ignored-files");
  await noPendingRemoval();
  await fs.unlink(path.join(record.path, "ignored.txt"));
  await expect(remove()).resolves.toBe(true);
});

it.each(["lossless", "custody"])(
  "retains an owner binding changed after %s inspection",
  async (kind) => {
    afterInspection(() => ownerEntry({ worktree: undefined }), kind);
    await expect(remove()).resolves.toBe(false);
    expect(registry()?.removedAt).toBeUndefined();
    expect(registry()?.runEndCleanup?.reason).toContain("owner");
    await noPendingRemoval();
  },
);

it.each(["controller", "placement", "activity"])(
  "retains %s activity admitted after inspection",
  async (activity) => {
    const gate = controllerGate();
    let turn: Promise<void> | undefined;
    afterInspection(async () => {
      if (activity === "controller") {
        turn = withSessionTurn(
          {
            storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
            sessionKey: key,
            sessionId: "terminal-owner",
          },
          gate.run,
        );
        await gate.entered;
      } else if (activity === "placement") {
        await placements.startDispatch({
          sessionId: "terminal-owner",
          sessionKey: key,
          agentId: "main",
        });
      } else {
        await updateRegistryWorktree(process.env, record.id, { lastActiveAt: Date.now() });
        expect(registry()?.lastActiveAt).toBeGreaterThan(cutoff);
      }
    });
    try {
      let cleanup: ManagedWorktreeRunEndCleanup | undefined;
      await expect(
        service.removeIfLossless(record.id, {
          ownerCleanup: { terminalBefore: cutoff },
          onCleanup: (result) => {
            cleanup = result;
          },
        }),
      ).resolves.toBe(false);
      expect(cleanup).toMatchObject({ outcome: "retained-busy", reason: expect.any(String) });
      expect(registry()?.removedAt).toBeUndefined();
      await noPendingRemoval();
    } finally {
      gate.release();
      await turn;
    }
  },
);

it.each(["nonterminal", "recent", "ended-recent", "missing", "unreadable", "worktree-recent"])(
  "requires positive terminal idle owner facts: %s",
  async (state) => {
    if (state === "nonterminal") {
      await ownerEntry({ status: undefined });
    }
    if (state === "ended-recent") {
      await ownerEntry({ endedAt: cutoff + 1 });
    }
    if (state === "recent") {
      await ownerEntry({ lastInteractionAt: cutoff + 1 });
    }
    if (state === "missing") {
      await deleteSessionEntryLifecycle({
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
        target: { canonicalKey: key, storeKeys: [key] },
        archiveTranscript: false,
      });
    }
    if (state === "unreadable") {
      vi.spyOn(sessionReads, "readResolvedSessionStoreTargetsInWorker").mockRejectedValue(
        new Error("owner read unavailable"),
      );
    }
    if (state === "worktree-recent") {
      await updateRegistryWorktree(process.env, record.id, { lastActiveAt: cutoff + 1 });
    }
    await expect(remove()).resolves.toBe(false);
    expect(registry()?.runEndCleanup).toMatchObject({
      outcome: "retained-busy",
      reason: expect.any(String),
    });
    await noPendingRemoval();
  },
);

it("enforces 24 hours and permits equality at an older cutoff", async () => {
  await expect(
    service.removeIfLossless(record.id, { ownerCleanup: { terminalBefore: Date.now() } }),
  ).rejects.toThrow("24 hours");
  await expect(remove()).resolves.toBe(true);
  expect(registry()?.runEndCleanup?.outcome).toBe("removed-lossless");
  await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["before", "after"])("excludes run leases in both directions: %s claim", async (when) => {
  if (when === "before") {
    const lease = await acquireWorktreeRunLease(record.id, { env: process.env });
    try {
      await updateRegistryWorktree(process.env, record.id, { lastActiveAt: cutoff });
      await expect(remove()).resolves.toBe(false);
      expect(registry()?.runEndCleanup?.reason).toContain("locked by live pid");
    } finally {
      await lease.release();
    }
  } else {
    afterInspection(() =>
      expect(acquireWorktreeRunLease(record.id, { env: process.env })).rejects.toThrow(/remov/i),
    );
    await expect(remove()).resolves.toBe(true);
  }
});

it.each(["node_modules", "dirty", "unpublished", "hidden", "nested", "protected", "retry-stop"])(
  "preserves existing protection: %s",
  async (state) => {
    if (state === "node_modules") {
      await fs.mkdir(path.join(record.path, state));
      await fs.writeFile(path.join(record.path, state, "user-file"), "only copy");
    }
    if (state === "dirty") {
      await fs.writeFile(path.join(record.path, "README.md"), "edit");
    }
    if (state === "unpublished") {
      await git(record.path, "commit", "--allow-empty", "-m", "local work");
    }
    if (state === "hidden") {
      await git(record.path, "update-index", "--assume-unchanged", "README.md");
      await fs.writeFile(path.join(record.path, "README.md"), "hidden edit");
    }
    if (state === "nested") {
      await fs.mkdir(path.join(record.path, "nested"));
      await git(path.join(record.path, "nested"), "init");
    }
    if (state === "protected" || state === "retry-stop") {
      await deferWorktreeCleanup(process.env, {
        observed: record,
        reason: "branch-moved",
        ...(state === "retry-stop"
          ? { retry: { stage: "nested-repository", elapsedMs: 0, attempts: 1, retryAt: null } }
          : {}),
      });
    }
    await expect(remove()).resolves.toBe(false);
    if (state === "hidden") {
      expect(registry()?.runEndCleanup?.outcome).toBe("retained-dirty");
      expect(await fs.readFile(path.join(record.path, "README.md"), "utf8")).toBe("hidden edit");
    }
    expect(registry()?.removedAt).toBeUndefined();
    await expect(fs.stat(record.path)).resolves.toBeDefined();
    await noPendingRemoval();
  },
);

it.each(["cancel", "failure", "unknown"])(
  "reports %s without a false removal receipt",
  async (kind) => {
    const abort = new AbortController();
    const error = Object.assign(
      new Error("injected " + kind),
      kind === "unknown" ? { code: "outcome-unknown" } : {},
    );
    afterInspection(async () => {
      if (kind === "cancel") {
        abort.abort(error);
      } else {
        throw error;
      }
    });
    await expect(
      service.removeIfLossless(record.id, {
        signal: abort.signal,
        ownerCleanup: { terminalBefore: cutoff },
      }),
    ).rejects.toThrow("injected " + kind);
    expect(registry()?.removedAt).toBeUndefined();
    expect(registry()?.runEndCleanup?.outcome).toBe(kind === "failure" ? "failed" : undefined);
    if (kind === "unknown") {
      await expect(acquireWorktreeRunLease(record.id, { env: process.env })).rejects.toThrow(
        /remov/i,
      );
    } else {
      const lease = await acquireWorktreeRunLease(record.id, { env: process.env });
      await lease.release();
    }
  },
);

it("returns structured retention then removal through the public RPC handler", async () => {
  const invoke = async () => {
    const respond = vi.fn();
    await worktreesHandlers["worktrees.remove"]!({
      params: { id: record.id, ifLossless: true, ownerCleanup: { terminalBefore: cutoff } },
      respond,
      context: { getRuntimeConfig: () => ({}) },
    } as never);
    return respond.mock.calls[0];
  };
  await fs.writeFile(path.join(record.path, "ignored.txt"), "only copy");
  expect(await invoke()).toEqual([
    true,
    {
      removed: false,
      cleanup: {
        outcome: "retained-busy",
        at: expect.any(Number),
        reason: expect.stringContaining("ignored-files"),
      },
    },
    undefined,
  ]);
  await fs.unlink(path.join(record.path, "ignored.txt"));
  expect(await invoke()).toEqual([
    true,
    { removed: true, cleanup: { outcome: "removed-lossless", at: expect.any(Number) } },
    undefined,
  ]);
  await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("settles an admitted deletion under the owner fence despite cancellation and changed facts", async () => {
  const abort = new AbortController();
  const withGit = checkoutGitOwner.withWorktreeGitConfig;
  vi.spyOn(checkoutGitOwner, "withWorktreeGitConfig").mockImplementation(
    (cwd, sourceOnly, guard, run) =>
      withGit(cwd, sourceOnly, guard, (policy) =>
        run(
          sourceOnly ? policy : { ...policy, run: gitOwner.runGit, require: gitOwner.requireGit },
        ),
      ),
  );
  const run = gitOwner.runGit;
  let deleted = false;
  vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
    const result = await run(cwd, args, options);
    if (args[0] === "worktree" && args[1] === "remove" && result.code === 0) {
      expect(
        isSessionMutationActive(resolveSessionStorePathCore(undefined, { agentId: "main" }), [
          key,
          "terminal-owner",
        ]),
      ).toBe(true);
      deleted = true;
      abort.abort(new Error("cancelled after deletion"));
      await ownerEntry({ endedAt: Date.now() });
    }
    return result;
  });
  await expect(
    service.removeIfLossless(record.id, {
      signal: abort.signal,
      ownerCleanup: { terminalBefore: cutoff },
    }),
  ).rejects.toMatchObject({ code: "OPENCLAW_STATE_LEASE_ABORTED" });
  expect(deleted).toBe(true);
  expect(registry()).toMatchObject({
    removedAt: expect.any(Number),
    runEndCleanup: { outcome: "removed-lossless" },
  });
  await noPendingRemoval();
});

it.each(process.platform === "linux" ? ["device", "subvolume"] : ["device"])(
  "retains a tracked nested filesystem: %s",
  async (kind) => {
    const directory = path.join(record.path, "nested");
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "keep.txt"), "nested data");
    await git(record.path, "add", "nested/keep.txt");
    const inspect = () =>
      executeGitWorktreeOperation({
        type: "worktree.cleanup-inspection",
        input: { kind: "custody", checkoutPath: record.path, provisionedPaths: [] },
      });
    await expect(inspect()).resolves.toEqual({ retainedReason: undefined });
    const statfs = await fs.statfs(record.path);
    const root = await fs.stat(record.path);
    Object.defineProperty(statfs, "type", { value: 0x9123683e });
    vi.spyOn(fs, "statfs").mockResolvedValue(statfs);
    const lstat = fs.lstat;
    vi.spyOn(fs, "lstat").mockImplementation(async (target, options) => {
      const stat = await lstat(target, options);
      if (target.toString() === directory) {
        Object.defineProperty(stat, kind === "device" ? "dev" : "ino", {
          value: kind === "device" ? root.dev + 1 : 256,
        });
      }
      return stat;
    });
    await expect(inspect()).resolves.toEqual({ retainedReason: "ignored-files" });
    expect(await fs.readFile(path.join(directory, "keep.txt"), "utf8")).toBe("nested data");
  },
);
