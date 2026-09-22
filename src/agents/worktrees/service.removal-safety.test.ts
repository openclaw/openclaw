import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import * as gitOwner from "./git.js";
import { getRegistryWorktree } from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const execFileAsync = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("git", ["-C", cwd, ...args])).stdout.trim();
}

describe("managed removal custody", () => {
  const initializeRepository = useManagedWorktreeTestRepository();
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-removal-"));
    repo = await initializeRepository(root);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    service = new ManagedWorktreeService({ env });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });
  async function materialize(name: string) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now: Date.now(),
      repoRoot: repo,
      stateDir: env.OPENCLAW_STATE_DIR!,
    });
  }

  it("uses native non-force removal without pruning a missing sibling registration", async () => {
    const created = await materialize("lossless");
    const sibling = path.join(root, "sibling");
    await git(repo, "worktree", "add", "--detach", sibling, "HEAD");
    await fs.rename(sibling, path.join(root, "sibling-parked"));
    const trace = path.join(root, "git-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);

    const commands = (await fs.readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; argv?: string[] })
      .filter((entry) => entry.event === "start")
      .map((entry) => entry.argv ?? []);
    const removal = commands.filter((args) => args.includes("worktree") && args.includes("remove"));
    expect(removal).toHaveLength(1);
    expect(removal[0]).not.toContain("--force");
    expect(commands.some((args) => args.includes("branch") && args.includes("-D"))).toBe(false);
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(sibling);
    expect(await git(repo, "branch", "--list", created.branch)).toBe("");
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["switched", "detached"])(
    "retains the recorded unpublished branch after HEAD is %s",
    async (kind) => {
      const created = await materialize(kind);
      await git(created.path, "commit", "--allow-empty", "-m", "unpublished work");
      const tip = await git(created.path, "rev-parse", "HEAD");
      if (kind === "switched") {
        await git(created.path, "checkout", "-b", "replacement", "main");
      } else {
        await git(created.path, "checkout", "--detach", "main");
      }

      await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
        /branch|HEAD/,
      );

      expect(await git(repo, "rev-parse", created.branch)).toBe(tip);
      await expect(fs.stat(created.path)).resolves.toBeDefined();
      expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    },
  );

  it.each(["none", "single", "multiple"])(
    "archives and restores unpublished work with %s tracking",
    async (tracking) => {
      const created = await materialize(tracking);
      if (tracking !== "none") {
        await git(repo, "config", `branch.${created.branch}.remote`, ".");
        await git(repo, "config", "--add", `branch.${created.branch}.merge`, "refs/heads/main");
        if (tracking === "multiple") {
          await git(
            repo,
            "config",
            "--add",
            `branch.${created.branch}.merge`,
            "refs/heads/another",
          );
        }
      }
      await git(created.path, "commit", "--allow-empty", "-m", "unpublished task work");
      const head = await git(created.path, "rev-parse", "HEAD");
      await fs.writeFile(path.join(created.path, "untracked.txt"), "saved work\n");

      const result = await service.remove({ id: created.id, reason: "archive" });
      expect(result).toMatchObject({
        removed: true,
        snapshotRef: `refs/openclaw/snapshots/${created.id}`,
      });
      expect(await git(repo, "branch", "--list", created.branch)).toBe("");
      const restored = await service.restore({ id: created.id });
      expect(await git(restored.path, "rev-parse", "HEAD")).toBe(head);
      expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
        "saved work\n",
      );
    },
  );

  it("retains hidden dirty work instead of relying on status flags", async () => {
    const created = await materialize("hidden-dirty");
    await git(created.path, "update-index", "--assume-unchanged", "README.md");
    await fs.writeFile(path.join(created.path, "README.md"), "hidden change\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");
    await expect(service.removeIfLossless(created.id)).resolves.toBe(false);
    expect(getRegistryWorktree(env, created.id)?.runEndCleanup?.outcome).toBe("retained-dirty");
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("hidden change\n");
  });

  it("preserves an advanced tip even if upstream also advances after snapshot", async () => {
    const created = await materialize("late-tip");
    await git(repo, "config", `branch.${created.branch}.remote`, ".");
    await git(repo, "config", "--add", `branch.${created.branch}.merge`, "refs/heads/upstream");
    await git(repo, "branch", "upstream", "HEAD");
    const runGit = gitOwner.runGit;
    let advanced = "";
    vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        await git(created.path, "commit", "--allow-empty", "-m", "late unpublished work");
        advanced = await git(created.path, "rev-parse", "HEAD");
        await git(repo, "update-ref", "refs/heads/upstream", advanced);
      }
      return await runGit(cwd, args, options);
    });
    await expect(service.removeIfLossless(created.id)).rejects.toThrow(/not fully merged/);
    expect(await git(repo, "rev-parse", created.branch)).toBe(advanced);
    expect(getRegistryWorktree(env, created.id)?.runEndCleanup?.outcome).toBe("failed");
  });

  it("retains a new unpublished HEAD after the lossless inspection", async () => {
    const created = await materialize("after-inspection");
    const release = service.release.bind(service);
    let advanced = "";
    vi.spyOn(service, "release").mockImplementation(async (id) => {
      await release(id);
      await git(created.path, "commit", "--allow-empty", "-m", "new unpublished work");
      advanced = await git(created.path, "rev-parse", "HEAD");
    });

    await expect(service.removeIfLossless(created.id)).rejects.toThrow(
      "HEAD changed after lossless inspection",
    );
    expect(await git(repo, "rev-parse", created.branch)).toBe(advanced);
    await expect(fs.stat(created.path)).resolves.toBeDefined();
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
  });

  it("lets native Git refuse late untracked files without escalating to force", async () => {
    const created = await materialize("late-dirty");
    const runGit = gitOwner.runGit;
    const removals: string[][] = [];
    vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        removals.push(args);
        await fs.writeFile(path.join(created.path, "late.txt"), "new work\n");
      }
      return await runGit(cwd, args, options);
    });

    await expect(service.removeIfLossless(created.id)).rejects.toThrow(/untracked files/);
    expect(removals).toHaveLength(1);
    expect(removals[0]).not.toContain("--force");
    expect(await fs.readFile(path.join(created.path, "late.txt"), "utf8")).toBe("new work\n");
    expect(await git(repo, "branch", "--list", created.branch)).toContain(created.branch);
    expect(getRegistryWorktree(env, created.id)?.runEndCleanup?.outcome).toBe("failed");
  });

  it("does not overwrite a completed snapshot after a partial deletion failure", async () => {
    const created = await materialize("partial");
    await fs.writeFile(path.join(created.path, "README.md"), "complete recovery content\n");
    const runGit = gitOwner.runGit;
    const fault = vi.spyOn(gitOwner, "runGit").mockImplementation(async (cwd, args, options) => {
      if (args[0] === "worktree" && args[1] === "remove") {
        await fs.unlink(path.join(created.path, "README.md"));
        return {
          ...(await runGit(cwd, ["status", "--porcelain"], options)),
          code: 1,
          stderr: "injected partial removal",
        };
      }
      return await runGit(cwd, args, options);
    });
    await expect(service.remove({ id: created.id, reason: "archive" })).rejects.toThrow(
      "injected partial removal",
    );
    fault.mockRestore();
    const snapshotRef = getRegistryWorktree(env, created.id)!.snapshotRef!;
    const snapshot = await git(repo, "rev-parse", snapshotRef);
    await expect(service.remove({ id: created.id, reason: "retry" })).rejects.toThrow(
      "Previous worktree removal may be incomplete",
    );
    expect(await git(repo, "rev-parse", snapshotRef)).toBe(snapshot);
    expect(await git(repo, "show", `${snapshot}:README.md`)).toBe("complete recovery content");
    expect(await git(repo, "rev-parse", `refs/openclaw/removals/${created.id}`)).toBe(snapshot);
  });

  it("expires a pending HEAD pin after snapshot-loss removal without orphaning it", async () => {
    let now = Date.now();
    service = new ManagedWorktreeService({ env, now: () => now });
    const created = await materialize("snapshot-loss-finalization");
    const nested = path.join(created.path, "nested");
    await fs.mkdir(nested);
    await git(nested, "init", "-b", "main");
    const head = await git(created.path, "rev-parse", "HEAD");
    const pendingRef = `refs/openclaw/removals/${created.id}`;
    const requireGit = gitOwner.requireGit;
    const fault = vi
      .spyOn(gitOwner, "requireGit")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "update-ref" && args[1] === "-d" && args[2] === pendingRef) {
          throw new Error("injected pending-ref deletion failure");
        }
        return await requireGit(cwd, args, options);
      });
    await expect(
      service.remove({ id: created.id, reason: "archive", allowSnapshotLoss: true }),
    ).rejects.toThrow("injected pending-ref deletion failure");
    expect(getRegistryWorktree(env, created.id)).toMatchObject({ removedAt: now });
    expect(getRegistryWorktree(env, created.id)?.snapshotRef).toBeUndefined();
    expect(await git(repo, "rev-parse", pendingRef)).toBe(head);

    now += 31 * 24 * 60 * 60 * 1000;
    const failed = await service.gc();
    expect(failed.snapshotsPruned).toBe(0);
    expect(getRegistryWorktree(env, created.id)).toBeDefined();
    fault.mockRestore();
    const retried = await service.gc();
    expect(retried.snapshotsPruned).toBe(1);
    expect(getRegistryWorktree(env, created.id)).toBeUndefined();
    await expect(git(repo, "show-ref", "--verify", pendingRef)).rejects.toThrow();
    expect(await git(repo, "rev-parse", created.branch)).toBe(head);
  });
});
