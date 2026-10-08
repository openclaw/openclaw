import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import * as commandRunner from "../../process/exec-runner.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { updateRegistryWorktreeInDatabase } from "./registry-run-end.worker.js";
import * as registry from "./registry.js";
import { updateRegistryWorktree } from "./registry.js";
import { getRegistryWorktree } from "./registry.test-support.js";
import * as leases from "./run-lease.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (
    await exec("git", ["--no-optional-locks", "-C", cwd, ...args], { encoding: "utf8" })
  ).stdout.trim();
}

describe("exact-state retirement admission and recovery", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  const temps = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(async () => {
      vi.restoreAllMocks();
      await closeOpenClawStateDatabaseAsync();
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let stateDir: string;
  let service: ManagedWorktreeService;
  beforeEach(async () => {
    const root = temps.make("openclaw-exact-race-");
    repo = await initializeRepository(root);
    stateDir = path.join(root, "state");
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    service = new ManagedWorktreeService({
      env,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
  });
  const readme = (directory: string) => fs.readFile(path.join(directory, "README.md"), "utf8");
  async function refNames(ref: string) {
    return await git(repo, "for-each-ref", "--format=%(refname)", ref);
  }
  async function fixture(provisionedPaths: string[] = []) {
    await git(repo, "commit", "--allow-empty", "-m", "recorded branch tip");
    const record = await materializeManagedWorktreeFixture({
      env,
      stateDir,
      repoRoot: repo,
      name: "race",
      now: 1_800_000_000_000,
      ownerKind: "session",
      ownerId: "exact-owner",
      provisionedPaths,
    });
    const branchHead = await git(record.path, "rev-parse", "HEAD");
    await git(record.path, "checkout", "--detach", "HEAD~1");
    const head = await git(record.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(record.path, "README.md"), "staged\n");
    await git(record.path, "add", "README.md");
    await fs.writeFile(path.join(record.path, "README.md"), "working\n");
    const indexPath = path.resolve(
      record.path,
      await git(record.path, "rev-parse", "--git-path", "index"),
    );
    const index = await fs.readFile(indexPath);
    const exactState = {
      ownerKind: record.ownerKind,
      ownerId: record.ownerId,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      head,
      branchHead,
      indexSha256: createHash("sha256").update(index).digest("hex"),
    };
    return {
      record,
      index,
      indexPath,
      exactState,
      request: { id: record.id, reason: "test retirement", exactState },
    };
  }

  it.each(["head", "branch", "index", "file", "activity", "claim", "authority"] as const)(
    "preserves source and completed recovery when %s changes after capture",
    async (kind) => {
      const f = await fixture();
      let token = "";
      const claim = leases.claimWorktreeRemoval;
      vi.spyOn(leases, "claimWorktreeRemoval").mockImplementation(async (environment, request) => {
        token = request.token;
        await claim(environment, request);
      });
      let current = true;
      let injected = false;
      const run = commandRunner.runCommandWithTimeout;
      vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
        const result = await run(...args);
        const argv = args[0];
        if (
          !injected &&
          argv[0] === "git" &&
          argv.includes("update-ref") &&
          argv.includes(`refs/openclaw/removals/${f.record.id}`)
        ) {
          injected = true;
          if (kind === "head") {
            await git(f.record.path, "checkout", "--detach", f.exactState.branchHead);
          }
          if (kind === "branch") {
            await git(repo, "update-ref", `refs/heads/${f.record.branch}`, f.exactState.head);
          }
          if (kind === "index") {
            await git(f.record.path, "add", "README.md");
          }
          if (kind === "file") {
            await fs.writeFile(path.join(f.record.path, "README.md"), "concurrent change\n");
          }
          if (kind === "activity") {
            await updateRegistryWorktree(env, f.record.id, {
              lastActiveAt: f.record.lastActiveAt + 1,
            });
          }
          if (kind === "claim") {
            await leases.abortWorktreeRemoval(env, f.record.id, token);
          }
          if (kind === "authority") {
            current = false;
          }
        }
        return result;
      });
      await expect(
        service.remove({
          ...f.request,
          commitGuard: () => {
            if (!current) {
              throw new Error("caller authority revoked");
            }
          },
        }),
      ).rejects.toThrow(/changed|revoked/);
      expect(injected).toBe(true);
      expect(await fs.stat(f.record.path)).toBeTruthy();
      expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeUndefined();
      const snapshot = await git(
        repo,
        "rev-parse",
        getRegistryWorktree(env, f.record.id)!.snapshotRef!,
      );
      expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("working");
      expect(await git(repo, "rev-parse", `${snapshot}^`)).toBe(f.exactState.head);
      expect(await git(repo, "rev-parse", `${snapshot}^2^`)).toBe(f.exactState.branchHead);
      if (kind !== "index" && kind !== "head") {
        expect(await fs.readFile(f.indexPath)).toEqual(f.index);
      }
      const recovery = service.restore({
        id: f.record.id,
        recoverExactState: f.exactState,
        commitGuard: () => {
          if (!current) {
            throw new Error("caller authority revoked");
          }
        },
      });
      if (kind === "file" || kind === "claim") {
        // A newly authorized recovery may reconcile the original incarnation in
        // place. It must retain late bytes rather than overlay the old capture.
        expect((await recovery).removedAt).toBeUndefined();
        expect(await readme(f.record.path)).toBe(
          kind === "file" ? "concurrent change\n" : "working\n",
        );
        expect(await fs.readFile(f.indexPath)).toEqual(f.index);
      } else {
        await expect(recovery).rejects.toThrow(/preserved|changed|revoked/);
      }
    },
  );

  it.each([false, true])(
    "retains completed recovery across interruption (native archival move completed=%s)",
    async (completed) => {
      const f = await fixture();
      const run = commandRunner.runCommandWithTimeout;
      let interrupted = false;
      vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
        const argv = args[0];
        if (
          !interrupted &&
          argv[0] === "git" &&
          argv.includes("worktree") &&
          argv.includes("move")
        ) {
          interrupted = true;
          if (completed) {
            await run(...args);
          }
          throw new Error("controlled archive interruption");
        }
        return await run(...args);
      });
      await expect(service.remove(f.request)).rejects.toThrow("controlled archive interruption");
      expect(interrupted).toBe(true);
      expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeUndefined();
      const snapshot = await git(
        repo,
        "rev-parse",
        getRegistryWorktree(env, f.record.id)!.snapshotRef!,
      );
      expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("working");
      expect(await git(repo, "rev-parse", f.record.branch)).toBe(f.exactState.branchHead);
      if (!completed) {
        expect(await fs.readFile(f.indexPath)).toEqual(f.index);
        await expect(service.remove(f.request)).rejects.toThrow(
          "Previous worktree removal may be incomplete",
        );
      }
      {
        await service.list();
        await service.gc();
        expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeUndefined();
        const restored = await service.restore({
          id: f.record.id,
          recoverExactState: f.exactState,
        });
        const restoredIndex = path.resolve(
          restored.path,
          await git(restored.path, "rev-parse", "--git-path", "index"),
        );
        expect(await fs.readFile(restoredIndex)).toEqual(f.index);
        expect(await readme(restored.path)).toBe("working\n");
        expect(await git(restored.path, "rev-parse", "HEAD")).toBe(f.exactState.head);
        expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeUndefined();
        expect(await refNames(`refs/openclaw/removals/${f.record.id}`)).toBe("");
      }
    },
  );

  it.each(["run-admission", "move-ack", "cleanup-ack"] as const)(
    "recovers unfinished live retirement with %s fencing",
    async (phase) => {
      const f = await fixture();
      const run = commandRunner.runCommandWithTimeout;
      let moves = 0;
      let attempted = false;
      let rejected = false;
      let admitted: Awaited<ReturnType<typeof leases.acquireWorktreeRunLease>> | undefined;
      vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
        const result = await run(...args);
        if (
          phase === "cleanup-ack" &&
          moves === 2 &&
          args[0].includes("update-ref") &&
          args[0].includes("-d") &&
          args[0].includes("refs/openclaw/removals/" + f.record.id)
        ) {
          moves++;
          throw new Error("controlled native move acknowledgement loss");
        }
        if (args[0].includes("worktree") && args[0].includes("move")) {
          moves++;
          if (moves === 1 || (moves === 2 && phase === "move-ack")) {
            throw new Error("controlled native move acknowledgement loss");
          }
          if (moves === 2 && phase === "run-admission") {
            attempted = true;
            try {
              admitted = await leases.acquireWorktreeRunLease(f.record.id, { env });
            } catch {
              rejected = true;
            }
          }
        }
        return result;
      });
      await expect(service.remove(f.request)).rejects.toThrow(
        "controlled native move acknowledgement loss",
      );
      const recover = () => service.restore({ id: f.record.id, recoverExactState: f.exactState });
      if (phase !== "run-admission") {
        await expect(recover()).rejects.toThrow("controlled native move acknowledgement loss");
      }
      if (phase === "move-ack") {
        expect(await refNames("refs/openclaw/removals/" + f.record.id)).not.toBe("");
        await expect(leases.acquireWorktreeRunLease(f.record.id, { env })).rejects.toThrow(
          "Worktree removal is incomplete",
        );
        expect(leases.hasLiveWorktreeRunLease(env, f.record.id)).toBe(false);
      }
      if (phase === "cleanup-ack") {
        const liveRun = await leases.acquireWorktreeRunLease(f.record.id, { env });
        try {
          await expect(recover()).rejects.toThrow(/busy|locked by live pid/);
          expect(leases.hasLiveWorktreeRunLease(env, f.record.id)).toBe(true);
        } finally {
          await liveRun.release();
        }
      }
      try {
        expect((await recover()).removedAt).toBeUndefined();
        if (phase === "run-admission") {
          expect({ attempted, rejected }).toEqual({ attempted: true, rejected: true });
        }
        expect(await fs.readFile(f.indexPath)).toEqual(f.index);
        expect(await refNames("refs/openclaw/removals/" + f.record.id)).toBe("");
        if (phase === "move-ack") {
          admitted = await leases.acquireWorktreeRunLease(f.record.id, { env });
          expect(leases.hasLiveWorktreeRunLease(env, f.record.id)).toBe(true);
        }
      } finally {
        await admitted?.release();
      }
    },
  );

  it("reverifies a write admitted immediately before native quarantine", async () => {
    const f = await fixture();
    const run = commandRunner.runCommandWithTimeout;
    let injected = false;
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const argv = args[0];
      if (!injected && argv[0] === "git" && argv.includes("worktree") && argv.includes("move")) {
        injected = true;
        await fs.writeFile(path.join(f.record.path, "README.md"), "late source write\n");
      }
      return await run(...args);
    });
    await expect(service.remove(f.request)).rejects.toThrow("changed after exact-state capture");
    expect(injected).toBe(true);
    expect(await readme(f.record.path)).toBe("late source write\n");
    expect(await fs.readFile(f.indexPath)).toEqual(f.index);
    expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeUndefined();
  });

  it.each(["admission", "retirement", "retained-restore", "fallback-restore"] as const)(
    "excludes native Git writers through %s finalization",
    async (phase) => {
      const f = await fixture();
      const restoring = phase === "retained-restore" || phase === "fallback-restore";
      if (restoring) {
        const retired = await service.remove(f.request);
        if (phase === "fallback-restore") {
          await git(repo, "worktree", "remove", "--force", retired.recoveryPath!);
        }
      }
      let checked = false;
      let archived = "";
      if (!restoring) {
        const run = commandRunner.runCommandWithTimeout;
        vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
          const argv = args[0];
          const cwd = argv[argv.indexOf("-C") + 1];
          if (
            phase === "admission" &&
            !checked &&
            cwd?.includes(".openclaw-retiring-") &&
            argv.includes("symbolic-ref")
          ) {
            checked = true;
            await expect(git(cwd, "add", "README.md")).rejects.toThrow(/index.lock/);
            await expect(git(cwd, "update-ref", "HEAD", f.exactState.branchHead)).rejects.toThrow(
              /HEAD.lock/,
            );
            await expect(
              git(repo, "update-ref", `refs/heads/${f.record.branch}`, f.exactState.head),
            ).rejects.toThrow(/lock/);
          }
          const result = await run(...args);
          if (phase === "retirement" && argv.includes("worktree") && argv.includes("move")) {
            archived = argv.at(-1)!;
          }
          return result;
        });
      }
      const admitted: boolean[] = [];
      if (phase !== "admission") {
        const update = registry.updateRegistryWorktree;
        vi.spyOn(registry, "updateRegistryWorktree").mockImplementation((...args) => {
          if (
            args[1] === f.record.id &&
            (restoring
              ? "removedAt" in args[2] && args[2].removedAt === undefined
              : typeof args[2].removedAt === "number")
          ) {
            for (const command of [
              ["add", "README.md"],
              ["checkout", "--detach", f.exactState.branchHead],
              ["update-ref", `refs/heads/${f.record.branch}`, f.exactState.head],
            ]) {
              const result = spawnSync(
                "git",
                ["-C", restoring ? f.record.path : archived, ...command],
                { encoding: "utf8" },
              );
              admitted.push(result.status === 0);
            }
          }
          return update(...args);
        });
      }
      if (!restoring) {
        expect((await service.remove(f.request)).removed).toBe(true);
        if (phase === "admission") {
          expect(checked).toBe(true);
          expect(await git(repo, "rev-parse", f.record.branch)).toBe(f.exactState.branchHead);
        } else {
          expect(admitted).toEqual([false, false, false]);
        }
      }
      const restored = await service.restore({ id: f.record.id });
      if (phase === "admission") {
        const restoredIndex = path.resolve(
          restored.path,
          await git(restored.path, "rev-parse", "--git-path", "index"),
        );
        expect(await fs.readFile(restoredIndex)).toEqual(f.index);
      } else {
        if (restoring) {
          expect(admitted).toEqual([false, false, false]);
        }
        expect(restored.removedAt).toBeUndefined();
        expect(await fs.readFile(f.indexPath)).toEqual(f.index);
        if (restoring) {
          expect(await git(restored.path, "rev-parse", "HEAD")).toBe(f.exactState.head);
          expect(await git(repo, "rev-parse", f.record.branch)).toBe(f.exactState.branchHead);
          await git(restored.path, "add", "README.md");
        }
      }
    },
  );

  it("retains writes through an already-open descriptor after final verification and retirement", async () => {
    const f = await fixture();
    const writer = await fs.open(path.join(f.record.path, "README.md"), "r+");
    const run = commandRunner.runCommandWithTimeout;
    let branchReads = 0;
    try {
      vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
        const argv = args[0];
        const cwd = argv[argv.indexOf("-C") + 1];
        const result = await run(...args);
        if (cwd?.includes(".openclaw-retiring-") && argv.includes("HEAD^{commit}")) {
          branchReads += 1;
          if (branchReads === 1) {
            await writer.write("late descriptor bytes\n", 0, "utf8");
          }
        }
        return result;
      });
      const result = await service.remove(f.request);
      expect(branchReads).toBe(1);
      expect(result.removed).toBe(true);
      expect(await readme(result.recoveryPath!)).toBe("late descriptor bytes\n");
      expect(await git(repo, "show", `${result.snapshotRef}:README.md`)).toBe("working");
      await writer.write("later retired writes!\n", 0, "utf8");
      const restored = await service.restore({ id: f.record.id });
      expect(await readme(restored.path)).toBe("later retired writes!\n");
      expect(await fs.readFile(f.indexPath)).toEqual(f.index);
    } finally {
      await writer.close();
    }
  });

  it("recovers source expiry interrupted after deleting the snapshot ref", async () => {
    const f = await fixture();
    let now = Date.now();
    service = new ManagedWorktreeService({
      env,
      now: () => now,
      getConfig: () => ({ worktreeAcceleration: false }),
    });
    const result = await service.remove(f.request);
    let interrupted = false;
    const run = commandRunner.runCommandWithTimeout;
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const value = await run(...args);
      if (
        !interrupted &&
        args[0].includes("update-ref") &&
        args[0].includes("-d") &&
        args[0].includes(result.snapshotRef!)
      ) {
        interrupted = true;
        throw new Error("controlled post-expiry-ref interruption");
      }
      return value;
    });
    now = result.recoveryRetainedUntil! + 1;
    expect((await service.gc()).snapshotsPruned).toBe(0);
    expect(interrupted).toBe(true);
    expect(getRegistryWorktree(env, f.record.id)).toBeDefined();
    expect((await service.gc()).snapshotsPruned).toBe(1);
    expect(getRegistryWorktree(env, f.record.id)).toBeUndefined();
    expect(await git(repo, "rev-parse", f.record.branch)).toBe(f.exactState.branchHead);
  });

  it("reconciles a native restore interrupted after moving the original source", async () => {
    const f = await fixture();
    await service.remove(f.request);
    const run = commandRunner.runCommandWithTimeout;
    let interrupted = false;
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
      const argv = args[0];
      const result = await run(...args);
      if (
        !interrupted &&
        argv.includes("worktree") &&
        argv.includes("move") &&
        argv.at(-1) === f.record.path
      ) {
        interrupted = true;
        throw new Error("controlled post-restore-move interruption");
      }
      return result;
    });
    await expect(service.restore({ id: f.record.id })).rejects.toThrow(
      "controlled post-restore-move interruption",
    );
    expect(interrupted).toBe(true);
    expect(await readme(f.record.path)).toBe("working\n");
    expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeDefined();
    const restored = await service.restore({ id: f.record.id });
    expect(restored.removedAt).toBeUndefined();
    expect(await fs.readFile(f.indexPath)).toEqual(f.index);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(f.exactState.head);
  });

  it.each(["moved-back", "awaited-check"] as const)(
    "rejects a retained source replaced at %s",
    async (phase) => {
      const f = await fixture();
      const result = await service.remove(f.request);
      const original = path.join(path.dirname(f.record.path), "original-source-held");
      const source = phase === "moved-back" ? f.record.path : result.recoveryPath!;
      const replace = async () => {
        await fs.rename(source, original);
        await fs.cp(original, source, { recursive: true });
        await fs.writeFile(path.join(source, "README.md"), "replacement source\n");
      };
      let replaced = false;
      if (phase === "moved-back") {
        await git(repo, "worktree", "move", result.recoveryPath!, f.record.path);
        await replace();
      } else {
        const run = commandRunner.runCommandWithTimeout;
        vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
          const resultOfCommand = await run(...args);
          const argv = args[0];
          if (!replaced && argv.includes(result.recoveryPath!) && argv.includes("HEAD^{commit}")) {
            replaced = true;
            await replace();
          }
          return resultOfCommand;
        });
      }
      await expect(service.restore({ id: f.record.id })).rejects.toThrow(
        phase === "moved-back" ? "source identity or registration changed" : /source identity/,
      );
      expect(await readme(original)).toBe("working\n");
      expect(await readme(source)).toBe("replacement source\n");
      expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeDefined();
      if (phase === "awaited-check") {
        expect(replaced).toBe(true);
        expect(await git(repo, "rev-parse", result.snapshotRef!)).toMatch(/^[a-f0-9]{40}$/u);
      }
    },
  );

  it("supports repeated retirement after native restore with a new snapshot", async () => {
    const f = await fixture();
    const first = await service.remove(f.request);
    const firstSnapshot = await git(repo, "rev-parse", first.snapshotRef!);
    const restored = await service.restore({ id: f.record.id });
    await fs.writeFile(path.join(restored.path, "README.md"), "second working state\n");
    const second = await service.remove({
      ...f.request,
      exactState: { ...f.exactState, lastActiveAt: restored.lastActiveAt },
    });
    expect(await git(repo, "rev-parse", second.snapshotRef!)).not.toBe(firstSnapshot);
    expect(await git(repo, "show", `${second.snapshotRef}:README.md`)).toBe("second working state");
    const again = await service.restore({ id: f.record.id });
    expect(await readme(again.path)).toBe("second working state\n");
    expect(await fs.readFile(f.indexPath)).toEqual(f.index);
  });

  it.each(["missing", "changed"] as const)(
    "preserves recovery when the retained split-index dependency is %s",
    async (kind) => {
      const f = await fixture();
      await git(f.record.path, "update-index", "--split-index");
      const shared = path.resolve(
        f.record.path,
        await git(f.record.path, "rev-parse", "--shared-index-path"),
      );
      f.exactState.indexSha256 = createHash("sha256")
        .update(await fs.readFile(f.indexPath))
        .digest("hex");
      const result = await service.remove(f.request);
      // Simulate interruption after the native move, before registry finalization.
      await git(repo, "worktree", "move", result.recoveryPath!, f.record.path);
      const bytes = await fs.readFile(shared);
      if (kind === "missing") {
        await fs.unlink(shared);
      } else {
        await fs.writeFile(shared, Buffer.alloc(bytes.length));
      }
      await expect(service.restore({ id: f.record.id })).rejects.toThrow(/shared index/);
      expect(await fs.stat(f.record.path)).toBeTruthy();
      expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeDefined();
      await fs.writeFile(shared, bytes);
      const restored = await service.restore({ id: f.record.id });
      expect(await git(restored.path, "diff", "--cached")).toContain("+staged");
    },
  );

  it.each(["replacement", "restore-moved", "activity-race"] as const)(
    "preserves source and snapshot when expiration custody changes (%s)",
    async (kind) => {
      const f = await fixture();
      let now = Date.now();
      service = new ManagedWorktreeService({
        env,
        now: () => now,
        getConfig: () => ({ worktreeAcceleration: false }),
      });
      const result = await service.remove(f.request);
      const original = path.join(path.dirname(f.record.path), "original-source-held");
      if (kind === "replacement") {
        await fs.rename(result.recoveryPath!, original);
        await fs.cp(original, result.recoveryPath!, { recursive: true });
        await fs.writeFile(path.join(result.recoveryPath!, "README.md"), "replacement source\n");
      }
      if (kind === "restore-moved") {
        await git(repo, "worktree", "move", result.recoveryPath!, f.record.path);
      }
      let changed = false;
      if (kind === "activity-race") {
        const run = commandRunner.runCommandWithTimeout;
        vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
          const value = await run(...args);
          if (
            !changed &&
            args[0].includes("rev-parse") &&
            args[0].includes(`${result.snapshotRef}^{commit}`)
          ) {
            changed = true;
            await updateRegistryWorktree(env, f.record.id, {
              lastActiveAt: f.record.lastActiveAt + 1,
            });
          }
          return value;
        });
      }
      now = result.recoveryRetainedUntil! + 1;
      expect((await service.gc()).snapshotsPruned).toBe(0);
      expect(getRegistryWorktree(env, f.record.id)?.snapshotRef).toBe(result.snapshotRef);
      expect(await git(repo, "rev-parse", result.snapshotRef!)).toMatch(/^[a-f0-9]{40}$/u);
      if (kind === "replacement") {
        expect(await readme(original)).toBe("working\n");
        expect(await readme(result.recoveryPath!)).toBe("replacement source\n");
      } else if (kind === "restore-moved") {
        expect((await service.restore({ id: f.record.id })).removedAt).toBeUndefined();
        expect(await readme(f.record.path)).toBe("working\n");
      } else {
        expect(changed).toBe(true);
        expect(await readme(result.recoveryPath!)).toBe("working\n");
      }
    },
  );

  it("does not overwrite a lifecycle changed at the restore registry transaction", async () => {
    const f = await fixture();
    await service.remove(f.request);
    const update = registry.updateRegistryWorktree;
    let changed = false;
    vi.spyOn(registry, "updateRegistryWorktree").mockImplementation(async (...args) => {
      if (
        !changed &&
        args[1] === f.record.id &&
        "removedAt" in args[2] &&
        args[2].removedAt === undefined
      ) {
        changed = true;
        await update(env, f.record.id, { lastActiveAt: f.record.lastActiveAt + 7 });
      }
      return update(...args);
    });
    await expect(service.restore({ id: f.record.id })).rejects.toThrow(/lifecycle changed/);
    expect(changed).toBe(true);
    expect(getRegistryWorktree(env, f.record.id)?.lastActiveAt).toBe(f.record.lastActiveAt + 7);
    expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeDefined();
    expect(await fs.readFile(f.indexPath)).toEqual(f.index);
    expect((await service.restore({ id: f.record.id })).removedAt).toBeUndefined();
  });

  it.each(["registry", "git-deletion"] as const)(
    "excludes a competing lifecycle writer through expiry %s admission",
    async (phase) => {
      const f = await fixture();
      let now = Date.now();
      service = new ManagedWorktreeService({
        env,
        now: () => now,
        getConfig: () => ({ worktreeAcceleration: false }),
      });
      const result = await service.remove(f.request);
      let attempted = false;
      let rejected = false;
      const write = () => {
        attempted = true;
        try {
          // The synthetic contender runs inside the synchronous expiry transaction.
          runOpenClawStateWriteTransaction(
            ({ db }) =>
              updateRegistryWorktreeInDatabase(db, {
                id: f.record.id,
                patch: { lastActiveAt: f.record.lastActiveAt + 7 },
              }),
            { env },
          );
        } catch {
          rejected = true;
        }
      };
      if (phase === "registry") {
        const remove = registry.deleteRegistryWorktree;
        vi.spyOn(registry, "deleteRegistryWorktree").mockImplementation((...args) => {
          if (args[1] === f.record.id) {
            write();
          }
          return remove(...args);
        });
      } else {
        const run = commandRunner.runCommandWithTimeout;
        vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
          if (
            !attempted &&
            args[0].includes("update-ref") &&
            args[0].includes("-d") &&
            args[0].includes(result.snapshotRef!)
          ) {
            write();
          }
          return await run(...args);
        });
      }
      now = result.recoveryRetainedUntil! + 1;
      const expired = await service.gc();
      if (phase === "registry") {
        expect(expired.snapshotsPruned).toBe(1);
        expect({ attempted, rejected }).toEqual({ attempted: true, rejected: true });
        expect(getRegistryWorktree(env, f.record.id)).toBeUndefined();
      } else {
        expect(attempted).toBe(true);
        expect({
          rejected,
          recordPresent: Boolean(getRegistryWorktree(env, f.record.id)),
          snapshotPresent: Boolean(await refNames(result.snapshotRef!)),
          snapshotsPruned: expired.snapshotsPruned,
        }).toEqual({
          rejected: true,
          recordPresent: false,
          snapshotPresent: false,
          snapshotsPruned: 1,
        });
      }
    },
  );

  it.each([
    "native-add",
    "index-published",
    "finalize",
    "removal-ref",
    "receipt-cleanup",
    "receipt-cleanup-ack",
  ] as const)("recovers object-only restoration interrupted at %s", async (phase) => {
    const f = await fixture();
    const retired = await service.remove(f.request);
    await git(repo, "worktree", "remove", "--force", retired.recoveryPath!);
    let interrupted = false;
    const run = commandRunner.runCommandWithTimeout;
    vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
      if (
        !interrupted &&
        (phase === "receipt-cleanup" || phase === "removal-ref") &&
        args[0].includes("update-ref") &&
        args[0].includes("-d") &&
        args[0].includes(
          (phase === "removal-ref"
            ? "refs/openclaw/removals/"
            : "refs/openclaw/restores/exact-v1/") + f.record.id,
        )
      ) {
        interrupted = true;
        throw new Error("controlled object restore interruption");
      }
      const result = await run(...args);
      if (
        !interrupted &&
        phase === "receipt-cleanup-ack" &&
        args[0].includes("update-ref") &&
        args[0].includes("-d") &&
        args[0].includes("refs/openclaw/restores/exact-v1/" + f.record.id)
      ) {
        interrupted = true;
        throw new Error("controlled object restore interruption");
      }
      if (
        !interrupted &&
        phase === "native-add" &&
        args[0].includes("worktree") &&
        args[0].includes("add")
      ) {
        interrupted = true;
        throw new Error("controlled object restore interruption");
      }
      return result;
    });
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await rename(...args);
      if (!interrupted && phase === "index-published" && args[1] === f.indexPath) {
        interrupted = true;
        throw new Error("controlled object restore interruption");
      }
    });
    const update = registry.updateRegistryWorktree;
    vi.spyOn(registry, "updateRegistryWorktree").mockImplementation((...args) => {
      if (
        !interrupted &&
        phase === "finalize" &&
        args[1] === f.record.id &&
        "removedAt" in args[2] &&
        args[2].removedAt === undefined
      ) {
        interrupted = true;
        throw new Error("controlled object restore interruption");
      }
      return update(...args);
    });
    await expect(service.restore({ id: f.record.id })).rejects.toThrow(
      "controlled object restore interruption",
    );
    expect(interrupted).toBe(true);
    expect(await fs.stat(f.record.path)).toBeTruthy();
    const restoredBytes =
      phase === "index-published" ? "write after restoration commit\n" : "working\n";
    if (phase === "index-published") {
      await fs.writeFile(path.join(f.record.path, "README.md"), restoredBytes);
    }
    expect((await service.restore({ id: f.record.id })).removedAt).toBeUndefined();
    expect(await refNames("refs/openclaw/restores/exact-v1/" + f.record.id)).toBe("");
    expect(await refNames("refs/openclaw/removals/" + f.record.id)).toBe("");
    expect(await git(f.record.path, "status", "--porcelain=v1")).toBe("MM README.md");
    expect(await fs.readFile(f.indexPath)).toEqual(f.index);
    expect(await readme(f.record.path)).toBe(restoredBytes);
  });

  it.each(["staged-only.txt", "unexpected.txt"])(
    "refuses new %s bytes during interrupted fallback",
    async (createdPath) => {
      const f = await fixture();
      const missing = path.join(f.record.path, "staged-only.txt");
      await fs.writeFile(missing, "index-only bytes\n");
      await git(f.record.path, "add", "staged-only.txt");
      await fs.unlink(missing);
      f.request.exactState.indexSha256 = createHash("sha256")
        .update(await fs.readFile(f.indexPath))
        .digest("hex");
      const retired = await service.remove(f.request);
      await git(repo, "worktree", "remove", "--force", retired.recoveryPath!);
      const run = commandRunner.runCommandWithTimeout;
      let interrupted = false;
      vi.spyOn(commandRunner, "runCommandWithTimeout").mockImplementation(async (...args) => {
        const result = await run(...args);
        if (!interrupted && args[0].includes("worktree") && args[0].includes("add")) {
          interrupted = true;
          throw new Error("controlled add interruption");
        }
        return result;
      });
      await expect(service.restore({ id: f.record.id })).rejects.toThrow(
        "controlled add interruption",
      );
      const unexpected = path.join(f.record.path, createdPath);
      await fs.writeFile(unexpected, "concurrent bytes\n");
      await expect(service.restore({ id: f.record.id })).rejects.toThrow(
        /missing.*changed|changed.*missing|unexpected.*path/i,
      );
      expect(await fs.readFile(unexpected, "utf8")).toBe("concurrent bytes\n");
      expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeDefined();
      expect(await git(repo, "rev-parse", retired.snapshotRef!)).toBeTruthy();
    },
  );

  it("never overwrites a file arriving at fallback publication", async () => {
    const f = await fixture();
    const retired = await service.remove(f.request);
    await git(repo, "worktree", "remove", "--force", retired.recoveryPath!);
    const target = path.join(f.record.path, "README.md");
    let injected = false;
    const inject = async (destination: Parameters<typeof fs.rename>[1]) => {
      if (!injected && String(destination) === target) {
        injected = true;
        await fs.writeFile(target, "late publication bytes\n");
      }
    };
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await inject(args[1]);
      return await rename(...args);
    });
    const link = fsSync.linkSync;
    vi.spyOn(fsSync, "linkSync").mockImplementation((...args) => {
      if (!injected && String(args[1]) === target) {
        injected = true;
        fsSync.writeFileSync(target, "late publication bytes\n");
      }
      return link(...args);
    });
    await expect(service.restore({ id: f.record.id })).rejects.toThrow(/EEXIST|changed/);
    expect(injected).toBe(true);
    expect(await fs.readFile(target, "utf8")).toBe("late publication bytes\n");
    expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeDefined();
  });

  it("rejects provisioned ABA bytes that differ from the exact capture", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "saved.secret\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "provisioned fixture");
    await fs.writeFile(path.join(repo, "saved.secret"), "original secret\n");
    const f = await fixture(["saved.secret"]);
    const filename = path.join(f.record.path, "saved.secret");
    await fs.writeFile(filename, "original secret\n");
    await fs.utimes(filename, 1_600_000_000, 1_600_000_000);
    const original = await fs.stat(filename);
    const runCommand = gitExec.executeGitCommandBuffered;
    let captured = false;
    vi.spyOn(gitExec, "executeGitCommandBuffered").mockImplementation(async (...args) => {
      if (
        !captured &&
        args[0] === f.record.path &&
        args[1].includes("--literal-pathspecs") &&
        args[1].includes("ls-files") &&
        args[1].includes("--ignored")
      ) {
        captured = true;
        await fs.writeFile(filename, "different bytes\n");
      }
      return await runCommand(...args);
    });
    await expect(service.remove(f.request)).rejects.toThrow(
      /provisioned exact-state bytes changed after capture/,
    );
    expect(captured).toBe(true);
    await fs.writeFile(filename, "original secret\n");
    await fs.utimes(filename, original.atime, original.mtime);
    expect(await fs.readFile(filename, "utf8")).toBe("original secret\n");
    expect(await fs.readFile(f.indexPath)).toEqual(f.index);
    expect(getRegistryWorktree(env, f.record.id)?.removedAt).toBeUndefined();
  });

  it("keeps ordinary removal guards and refuses a live run or stale owner", async () => {
    const f = await fixture();
    await expect(
      service.remove({ id: f.record.id, reason: "ordinary", allowSnapshotLoss: true }),
    ).rejects.toThrow("HEAD no longer owns");
    await expect(
      service.remove({ ...f.request, exactState: { ...f.exactState, ownerId: "other-owner" } }),
    ).rejects.toThrow("owner or lifecycle changed");
    await expect(service.remove({ ...f.request, allowSnapshotLoss: true })).rejects.toThrow(
      "cannot permit snapshot loss",
    );
    const lease = await leases.acquireWorktreeRunLease(f.record.id, { env });
    try {
      await expect(service.remove(f.request)).rejects.toThrow(/busy|locked/);
    } finally {
      await lease.release();
    }
    expect(getRegistryWorktree(env, f.record.id)?.snapshotRef).toBeUndefined();
    expect(await fs.readFile(f.indexPath)).toEqual(f.index);
  });
});
