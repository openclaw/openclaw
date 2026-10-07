import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { repairWorktreePackIndex } from "./git-maintenance.js";
import { requireGit } from "./git.js";
import * as registryReads from "./registry-read.js";
import {
  deleteRegistryWorktree,
  insertRegistryWorktree,
  listRegistryWorktrees,
} from "./registry.js";
import { ManagedWorktreeService } from "./service.js";
import {
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
const env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("worktree-gc-maintenance-state-") };

const initRepo = useManagedWorktreeTestRepository();

beforeAll(async () => {
  await registryReads.readRegistryWorktrees(env);
  await registryReads.readWorktreeCleanupState(env);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const record of listRegistryWorktrees(env)) {
    deleteRegistryWorktree(env, record.id);
  }
});

it("rebuilds pack lookup when its previous index names a removed pack", async () => {
  const repo = await initRepo(tempDirs.make("worktree-stale-pack-index-"));
  const packDirectory = path.join(repo, ".git", "objects", "pack");
  const indexPath = path.join(packDirectory, "multi-pack-index");
  await requireGit(repo, ["repack", "-a", "-d"]);
  await repairWorktreePackIndex(repo);
  const staleIndex = await fs.readFile(indexPath);
  const oldPacks = new Set(
    (await fs.readdir(packDirectory)).filter((name) => name.endsWith(".idx")),
  );
  await fs.writeFile(path.join(repo, "replacement.txt"), "replacement pack\n");
  await requireGit(repo, ["add", "replacement.txt"]);
  await requireGit(repo, ["commit", "-m", "replace pack"]);
  await requireGit(repo, ["repack", "-a", "-d"]);
  const currentPacks = (await fs.readdir(packDirectory)).filter((name) => name.endsWith(".idx"));
  expect(currentPacks.every((name) => !oldPacks.has(name))).toBe(true);
  // Reproduce an interrupted pack replacement without removing any reachable objects.
  await fs.writeFile(indexPath, staleIndex);

  await repairWorktreePackIndex(repo);

  await requireGit(repo, ["multi-pack-index", "verify"]);
  expect(await requireGit(repo, ["show", "HEAD:replacement.txt"])).toBe("replacement pack");
});

it("maintains each shared repository and suspends failures until explicitly retried", async () => {
  const repo = await initRepo(tempDirs.make("worktree-gc-first-repo-"));
  const otherRepo = await initRepo(tempDirs.make("worktree-gc-second-repo-"));
  for (const repoRoot of [repo, otherRepo]) {
    await requireGit(repoRoot, ["repack", "-d"]);
  }
  for (const [index, repoRoot] of [repo, repo, otherRepo].entries()) {
    const name = `manual-${index}`;
    const worktreePath = path.join(repoRoot, name);
    await fs.mkdir(worktreePath);
    await insertRegistryWorktree(env, {
      id: name,
      name,
      repoFingerprint: name,
      repoRoot,
      path: worktreePath,
      branch: `openclaw/${name}`,
      baseRef: "HEAD",
      ownerKind: "manual",
      createdAt: 1,
      lastActiveAt: 1,
    });
  }
  const service = new ManagedWorktreeService({ env, now: () => 3 });
  const controller = new AbortController();
  const execute = gitExec.executeGitCommand;
  const maintenanceRoots: string[] = [];
  const repairRoots: string[] = [];
  const taskOrders: string[][] = [];
  const commands = vi
    .spyOn(gitExec, "executeGitCommand")
    .mockImplementation(async (cwd, args, options) => {
      if (args[0] === "multi-pack-index") {
        repairRoots.push(cwd);
      }
      if (args[0] !== "maintenance") {
        return await execute(cwd, args, options);
      }
      expect(repairRoots.at(-1)).toBe(cwd);
      taskOrders.push(args.filter((arg) => arg.startsWith("--task=")));
      expect(options).toMatchObject({
        killProcessTree: true,
        signal: controller.signal,
        timeoutMs: 30 * 60_000,
        beforeRun: expect.any(Function),
      });
      options?.beforeRun?.();
      maintenanceRoots.push(cwd);
      return {
        stdout: "",
        stderr: cwd === repo ? "gc is already running" : "",
        code: cwd === repo ? 1 : 0,
        signal: null,
        killed: false,
        termination: "exit",
        timeoutMs: options?.timeoutMs ?? 120_000,
      };
    });
  const logs = createWarnLogCapture("worktree-gc-maintenance");
  try {
    const result = await service.gc({ signal: controller.signal });
    expect(result).toMatchObject({
      removed: [],
      outcome: "completed",
      issues: [],
      issueCount: 0,
    });
    expect(maintenanceRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
    expect(repairRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
    // Git honors task order; graph traversal must not starve pack-index repair.
    expect(taskOrders).toEqual(
      [repo, otherRepo].map(() => [
        "--task=incremental-repack",
        "--task=commit-graph",
        "--task=loose-objects",
      ]),
    );
    const warning = await logs.findText("worktree Git maintenance");
    expect(warning).toContain("gc is already running");
    // Removal must still repair this repo after broad maintenance has been suspended.
    await repairWorktreePackIndex(repo, { signal: controller.signal });
    expect(repairRoots.at(-1)).toBe(repo);
    await service.gc({ signal: controller.signal });
    expect(maintenanceRoots).toHaveLength(3);
    expect(repairRoots).toHaveLength(4);
    expect(maintenanceRoots.at(-1)).toBe(otherRepo);
    await service.gc({ signal: controller.signal, retryDeferred: true });
    expect(maintenanceRoots).toHaveLength(5);
    expect(repairRoots).toHaveLength(6);
    const calls = commands.mock.calls.length;
    controller.abort(new Error("cleanup cancelled"));
    await expect(service.gc({ signal: controller.signal })).rejects.toThrow("cleanup cancelled");
    expect(commands).toHaveBeenCalledTimes(calls);
  } finally {
    logs.cleanup();
  }
});

it("warns without changing completed cleanup when the maintenance inventory fails", async () => {
  vi.spyOn(registryReads, "readRegistryWorktrees").mockRejectedValueOnce(
    new Error("maintenance inventory unavailable"),
  );
  const logs = createWarnLogCapture("worktree-gc-inventory");
  try {
    const result = await new ManagedWorktreeService({ env }).gc();
    expect(result).toMatchObject({ removed: [], outcome: "completed", issues: [], issueCount: 0 });
    expect(await logs.findText("worktree Git maintenance inventory failed")).toContain(
      "maintenance inventory unavailable",
    );
  } finally {
    logs.cleanup();
  }
});

it.each([false, true])(
  "skips maintenance without live records (removed record: %s)",
  async (removedRecord) => {
    const root = tempDirs.make("worktree-gc-no-maintenance-");
    if (removedRecord) {
      await insertRegistryWorktree(env, {
        id: "removed",
        name: "removed",
        repoFingerprint: "fixture",
        repoRoot: root,
        path: path.join(root, "removed"),
        branch: "openclaw/removed",
        baseRef: "HEAD",
        ownerKind: "manual",
        createdAt: 1,
        lastActiveAt: 1,
        removedAt: 2,
      });
    }
    const commands = vi.spyOn(gitExec, "executeGitCommand");
    expect((await new ManagedWorktreeService({ env, now: () => 3 }).gc()).outcome).toBe(
      "completed",
    );
    expect(commands.mock.calls.filter(([, args]) => args[0] === "maintenance")).toEqual([]);
  },
);

it("preserves shared reflog history and maintains repositories with already-missing reflog objects", async () => {
  const root = tempDirs.make("worktree-maintenance-reflogs-");
  const repo = await initRepo(root);
  const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
  await git(repo, "config", "gc.auto", "0");
  const [survivor, removed] = await materializeManagedWorktreeFixtures({
    env,
    stateDir: root,
    repoRoot: repo,
    names: ["survivor", "removed"],
    now: 1,
  });
  const base = await git(repo, "rev-parse", "HEAD");
  await git(survivor!.path, "checkout", "--detach");
  await git(survivor!.path, "commit", "--allow-empty", "-m", "reflog-only commit");
  const retained = await git(survivor!.path, "rev-parse", "HEAD");
  await git(survivor!.path, "checkout", survivor!.branch);
  const service = new ManagedWorktreeService({ env, now: () => 3 });
  const removedLog = path.resolve(
    removed!.path,
    await git(removed!.path, "rev-parse", "--git-path", "logs/HEAD"),
  );
  await fs.access(removedLog);
  await service.remove({ id: removed!.id, reason: "test" });
  await expect(fs.access(removedLog)).rejects.toMatchObject({ code: "ENOENT" });
  await git(repo, "repack", "-d");
  const missing = "a".repeat(base.length);
  const broken = await requireGit(repo, ["hash-object", "-w", "-t", "commit", "--stdin"], {
    input: Buffer.from(
      `tree ${missing}\nparent ${base}\nauthor Test <test@example.invalid> 1780000000 +0000\ncommitter Test <test@example.invalid> 1780000000 +0000\n\nmissing reflog tree\n`,
    ),
  });
  const reflog = path.resolve(
    survivor!.path,
    await git(survivor!.path, "rev-parse", "--git-path", "logs/HEAD"),
  );
  const timestamp = Math.floor(Date.now() / 1000);
  await fs.appendFile(
    reflog,
    `${base} ${broken} Test <test@example.invalid> ${timestamp} +0000\tmissing tree\n${broken} ${missing} Test <test@example.invalid> ${timestamp} +0000\tmissing commit\n`,
  );
  const history = await fs.readFile(reflog, "utf8");
  for (let index = 0; index < 3; index++) {
    const object = await requireGit(repo, ["hash-object", "-w", "--stdin"], {
      input: Buffer.from(`pack-${index}`),
    });
    await requireGit(repo, ["pack-objects", path.join(repo, ".git", "objects", "pack", "pack")], {
      input: Buffer.from(`${object}\n`),
    });
  }
  await git(repo, "config", "gc.auto", "1");
  await git(repo, "config", "gc.autoPackLimit", "1");
  for (const task of ["commit-graph", "loose-objects", "incremental-repack"]) {
    await git(repo, "config", `maintenance.${task}.auto`, "-1");
  }
  const logs = createWarnLogCapture("worktree-maintenance-reflogs");
  try {
    expect((await service.gc()).outcome).toBe("completed");
    expect(await logs.findText("worktree Git maintenance")).toBeUndefined();
    expect(await fs.readFile(reflog, "utf8")).toBe(history);
    expect(await git(repo, "cat-file", "-t", retained)).toBe("commit");
    await fs.access(
      path.join(repo, ".git", "objects", "info", "commit-graphs", "commit-graph-chain"),
    );
  } finally {
    logs.cleanup();
  }
});
