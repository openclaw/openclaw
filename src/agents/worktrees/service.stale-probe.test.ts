import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as worktreeGit from "./git.js";
import { getRegistryWorktree, updateRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

describe("ManagedWorktreeService missing-path observations", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;
  const now = 1_700_000_000_000;
  const completedGcResult = {
    removed: [],
    orphansDeleted: 0,
    snapshotsPruned: 0,
    outcome: "completed",
    issues: [],
    issueCount: 0,
    protectedCount: 0,
    limitsSatisfied: true,
  };

  beforeEach(async () => {
    root = await fs.realpath(tempDirs.make("openclaw-worktree-stale-probe-"));
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  async function fixture(name: string, repoRoot = repo) {
    const created = await materializeManagedWorktreeFixture({ env, name, now, repoRoot, stateDir });
    const identity = await service.resolveRepositoryIdentity(repoRoot);
    const repositoryIdentity = {
      repoRoot: identity.repoRoot,
      repoFingerprint: identity.fingerprint,
    };
    updateRegistryWorktree(env, created.id, { repositoryIdentity });
    return { ...created, ...repositoryIdentity };
  }

  function holdPathObservation(target: string) {
    const entered = createDeferred();
    const inspect = createDeferred();
    const sampled = createDeferred<boolean>();
    const resume = createDeferred();
    const exists = worktreeGit.worktreePathExists;
    let intercepted = false;
    vi.spyOn(worktreeGit, "worktreePathExists").mockImplementation(async (candidate) => {
      if (candidate !== target || intercepted) {
        return await exists(candidate);
      }
      intercepted = true;
      entered.resolve();
      await inspect.promise;
      const present = await exists(candidate);
      sampled.resolve(present);
      await resume.promise;
      return present;
    });
    return { entered, inspect, sampled, resume };
  }

  it.each(["list", "gc"] as const)(
    "%s retires an unchanged missing checkout",
    async (operation) => {
      const created = await fixture("missing");
      await git(repo, "worktree", "remove", "--force", created.path);
      const result = operation === "list" ? await service.list() : await service.gc();
      expect(getRegistryWorktree(env, created.id)).toEqual({ ...created, removedAt: now });
      if (operation === "list") {
        expect(result).toEqual([]);
      } else {
        expect(result).toEqual(completedGcResult);
      }
    },
  );

  it.each(["list", "gc"] as const)(
    "%s preserves a checkout restored after a missing-path observation",
    async (operation) => {
      const created = await fixture("restored");
      await fs.writeFile(path.join(created.path, "README.md"), "restored user changes\n");
      const gate = holdPathObservation(created.path);
      const observing = operation === "list" ? service.list() : service.gc();
      try {
        await gate.entered.promise;
        await service.remove({ id: created.id, reason: "test-restore" });
        gate.inspect.resolve();
        await expect(gate.sampled.promise).resolves.toBe(false);
        const restored = await service.restore({ id: created.id });
        expect(restored.lastActiveAt).toBeGreaterThan(created.lastActiveAt);
        expect(restored.repoRoot).toBe(created.repoRoot);
        expect(restored.repoFingerprint).toBe(created.repoFingerprint);
        gate.resume.resolve();
        const result = await observing;
        expect(getRegistryWorktree(env, created.id)).toEqual(restored);
        expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
          "restored user changes\n",
        );
        if (operation === "list") {
          expect(result).toEqual([restored]);
        } else {
          expect(result).toEqual(completedGcResult);
        }
      } finally {
        gate.inspect.resolve();
        gate.resume.resolve();
        await observing;
      }
    },
  );

  it.each(["list", "gc"] as const)(
    "%s preserves a checkout rebound after a missing-path observation",
    async (operation) => {
      const clone = path.join(root, "clone");
      await execFileAsync("git", ["clone", "--no-hardlinks", repo, clone]);
      await git(clone, "remote", "set-url", "origin", path.join(root, "remote.git"));
      const liveIdentity = await service.resolveRepositoryIdentity(clone);
      const staleIdentity = await service.resolveRepositoryIdentity(repo);
      const created = await fixture("rebound", liveIdentity.repoRoot);
      updateRegistryWorktree(env, created.id, {
        repositoryIdentity: {
          repoRoot: staleIdentity.repoRoot,
          repoFingerprint: staleIdentity.fingerprint,
        },
      });
      await fs.writeFile(path.join(created.path, "README.md"), "retained user changes\n");
      const temporarilyAbsent = path.join(root, "temporarily-absent");
      await fs.rename(created.path, temporarilyAbsent);
      const gate = holdPathObservation(created.path);
      gate.inspect.resolve();
      const observing = operation === "list" ? service.list() : service.gc();
      try {
        await expect(gate.sampled.promise).resolves.toBe(false);
        await fs.rename(temporarilyAbsent, created.path);
        await expect(service.removeIfLossless(created.id)).resolves.toBe(false);
        const rebound = getRegistryWorktree(env, created.id);
        expect(rebound).toMatchObject({
          repoRoot: liveIdentity.repoRoot,
          repoFingerprint: liveIdentity.fingerprint,
          lastActiveAt: created.lastActiveAt,
          runEndCleanup: { outcome: "retained-dirty" },
        });
        expect(rebound?.removedAt).toBeUndefined();
        gate.resume.resolve();
        const result = await observing;
        expect(getRegistryWorktree(env, created.id)).toEqual(rebound);
        expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe(
          "retained user changes\n",
        );
        if (operation === "list") {
          expect(result).toEqual([rebound]);
        } else {
          expect(result).toEqual(completedGcResult);
        }
      } finally {
        gate.inspect.resolve();
        gate.resume.resolve();
        await observing;
      }
    },
  );
});
