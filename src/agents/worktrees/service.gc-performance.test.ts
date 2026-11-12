import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import * as gitExec from "../../infra/git-exec.js";
import { createWarnLogCapture } from "../../logging/test-helpers/warn-log-capture.js";
import { withProjectCheckoutLifecycle } from "../../projects/project-checkout.js";
import * as stateDatabase from "../../state/openclaw-state-db.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { WorktreeGcProgress } from "./gc-progress.js";
import { createWorktreeGitMaintenance } from "./git-maintenance.js";
import { requireGit, runGit } from "./git.js";
import * as registryReads from "./registry-read.js";
import { deleteRegistryWorktree, insertRegistryWorktree } from "./registry.js";
import { listRegistryWorktrees } from "./registry.test-support.js";
import { ManagedWorktreeService, WORKTREE_GC_INTERVAL_MS } from "./service.js";
import {
  makeWorktreeRecord,
  materializeManagedWorktreeFixtures,
  useManagedWorktreeTestRepository,
} from "./service.test-support.js";
import type { ManagedWorktreeGcResult, ManagedWorktreeRecord } from "./types.js";

const offlineGit = { env: { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "" } };
const git = (cwd: string, ...args: string[]) => requireGit(cwd, args);
const read = (target: string, file: string) => fs.readFile(path.join(target, file), "utf8");
const expectMissing = (target: string) =>
  expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
const packsPath = (repo: string) => path.join(repo, ".git", "objects", "pack");
const packNames = async (repo: string) =>
  (await fs.readdir(packsPath(repo))).filter((name) => name.endsWith(".pack")).toSorted();
const objectTypes = (repo: string, objects: string[]) =>
  requireGit(repo, ["cat-file", "--batch-check=%(objecttype)"], {
    input: `${objects.join("\n")}\n`,
    ...offlineGit,
  });
async function pack(repo: string, objects: string[], deterministic = false) {
  const hash = await requireGit(
    repo,
    [
      "pack-objects",
      ...(deterministic ? ["--window=0", "--threads=1"] : []),
      path.join(packsPath(repo), "pack"),
    ],
    { input: `${objects.join("\n")}\n` },
  );
  return `pack-${hash}`;
}
async function packBlobs(repo: string, contents: (string | Buffer)[], deterministic = false) {
  const objects: string[] = [],
    packs: string[] = [];
  for (const input of contents) {
    const object = await requireGit(repo, ["hash-object", "-w", "--stdin"], { input });
    objects.push(object);
    packs.push(await pack(repo, [object], deterministic));
  }
  return { objects, packs };
}

beforeEach(() => {
  setRuntimeConfigSnapshot({});
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("worktree Git maintenance", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterAll(async () => {
      await stateDatabase.closeOpenClawStateDatabaseAsync();
      stateDatabase.closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  const env = {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("worktree-gc-maintenance-state-"),
  };

  const initRepo = useManagedWorktreeTestRepository();
  function captureWarnings(label: string) {
    const capture = createWarnLogCapture(label);
    onTestFinished(() => capture.cleanup());
    return capture;
  }
  const register = (repo: string, id: string, overrides: Partial<ManagedWorktreeRecord> = {}) =>
    insertRegistryWorktree(
      env,
      makeWorktreeRecord(repo, id, {
        repoFingerprint: id,
        ownerKind: "manual",
        ...overrides,
      }),
    );
  const materialize = (repoRoot: string, names: string[], stateDir = path.dirname(repoRoot)) =>
    materializeManagedWorktreeFixtures({ env, repoRoot, stateDir, names, now: 1 });
  async function partialClone(root: string, name = "partial") {
    const source = await initRepo(root);
    await git(source, "config", "uploadpack.allowFilter", "true");
    const repo = path.join(root, name);
    await git(
      root,
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(source).href,
      repo,
    );
    return { source, repo };
  }
  async function fixture(name: string) {
    const root = tempDirs.make(`worktree-${name}-`);
    const repo = await initRepo(root);
    const [record] = await materialize(repo, [name], root);
    return { root, repo, worktree: record! };
  }

  beforeAll(async () => {
    await registryReads.readRegistryWorktrees(env);
    await registryReads.readWorktreeCleanupState(env);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const record of listRegistryWorktrees(env)) {
      await deleteRegistryWorktree(env, record.id);
    }
  });

  it("repairs linked-index-only objects on explicit retry without rewriting the index or files", async () => {
    const { root, repo, worktree } = await fixture("index-only");
    const remote = path.join(root, "remote.git");
    await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    const staged = "staged content\n";
    const missing = await requireGit(remote, ["hash-object", "-w", "--stdin"], { input: staged });
    await requireGit(repo, ["hash-object", "-w", "--stdin"], { input: staged });
    await git(
      worktree.path,
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${missing},staged.txt`,
    );
    await fs.writeFile(path.join(worktree.path, "staged.txt"), "unstaged content\n");
    const indexPath = path.resolve(
      worktree.path,
      await git(worktree.path, "rev-parse", "--git-path", "index"),
    );
    const index = await fs.readFile(indexPath);
    await fs.unlink(path.join(repo, ".git", "objects", missing.slice(0, 2), missing.slice(2)));
    await git(repo, "config", "remote.origin.promisor", "true");
    await git(repo, "config", "remote.origin.partialclonefilter", "blob:none");
    await git(repo, "remote", "set-url", "origin", path.join(root, "unavailable.git"));
    const maintain = createWorktreeGitMaintenance(env);
    const logs = captureWarnings("worktree-index-object-repair");
    await maintain({ retryDeferred: true });
    expect(await logs.findText("worktree Git maintenance suspended (objects)")).toContain(
      "--retry-deferred",
    );
    await git(repo, "remote", "set-url", "origin", remote);
    await maintain({});
    expect((await runGit(repo, ["cat-file", "-e", missing], offlineGit)).code).not.toBe(0);
    await maintain({ retryDeferred: true });
    expect(await requireGit(repo, ["cat-file", "blob", missing], offlineGit)).toBe(
      "staged content",
    );
    expect(await fs.readFile(indexPath)).toEqual(index);
    expect(await read(worktree.path, "staged.txt")).toBe("unstaged content\n");
  });

  it("makes bounded repair progress when a live index exceeds the per-pass object limit", async () => {
    const root = tempDirs.make("worktree-object-repair-limit-");
    const source = await initRepo(root);
    const count = 4097;
    const blobs = Array.from({ length: count }, (_, index) => {
      const content = `payload-${index}\n`;
      return `blob\nmark :${index + 1}\ndata ${Buffer.byteLength(content)}\n${content}`;
    });
    await requireGit(source, ["fast-import", "--quiet"], {
      input: `${blobs.join("\n")}\ncommit refs/heads/bulk-repair\ncommitter Test <test@example.invalid> 1 +0000\ndata 6\nrepair\ndeleteall\n${Array.from({ length: count }, (_, index) => `M 100644 :${index + 1} file-${index}`).join("\n")}\n\n`,
    });
    await git(source, "config", "uploadpack.allowFilter", "true");
    const repo = path.join(root, "partial");
    await git(
      root,
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      "--branch",
      "bulk-repair",
      pathToFileURL(source).href,
      repo,
    );
    await git(repo, "read-tree", "HEAD");
    await register(repo, "repair-limit", { branch: "bulk-repair" });
    const objects = await git(source, "ls-tree", "-r", "--format=%(objectname)", "bulk-repair");
    const missing = async () =>
      (
        await requireGit(repo, ["cat-file", "--batch-check"], {
          input: `${objects}\n`,
          ...offlineGit,
        })
      )
        .split("\n")
        .filter((line) => line.endsWith(" missing")).length;
    expect(await missing()).toBe(count);
    const maintain = createWorktreeGitMaintenance(env);
    const logs = captureWarnings("worktree-object-repair-limit");
    await maintain({ retryDeferred: true });
    expect(await missing()).toBe(1);
    expect(await logs.findText("4096-object limit")).toContain("retry");
    await maintain({ retryDeferred: true });
    expect(await missing()).toBe(0);
  });

  it("resumes past an over-budget worktree after restart without losing later staged objects", async () => {
    const { root, repo, worktree } = await fixture("repair-resume");
    const remote = path.join(root, "remote.git");
    await git(remote, "config", "uploadpack.allowAnySHA1InWant", "true");
    const input = "staged object on a later worktree\n";
    const missing = await requireGit(remote, ["hash-object", "-w", "--stdin"], { input });
    await requireGit(repo, ["hash-object", "-w", "--stdin"], { input });
    await git(
      worktree.path,
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${missing},staged.txt`,
    );
    await fs.writeFile(path.join(worktree.path, "staged.txt"), "unstaged contents\n");
    const indexPath = path.resolve(
      worktree.path,
      await git(worktree.path, "rev-parse", "--git-path", "index"),
    );
    const index = await fs.readFile(indexPath);
    await fs.unlink(path.join(repo, ".git", "objects", missing.slice(0, 2), missing.slice(2)));
    await git(repo, "config", "remote.origin.promisor", "true");
    await git(repo, "config", "remote.origin.partialclonefilter", "blob:none");
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const execute = gitExec.executeGitCommand;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await execute(cwd, args, options);
      // Model an expensive primary checkout inventory using the real Git result;
      // the deadline must not keep later linked indexes from ever being repaired.
      if (cwd === repo && args[0] === "rev-list") {
        now += 300_001;
      }
      return result;
    });
    const first = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ retryDeferred: true, progress: first });
    expect(first.result.outcome).toBe("partial");
    expect((await runGit(repo, ["cat-file", "-e", missing], offlineGit)).code).not.toBe(0);
    await stateDatabase.closeOpenClawStateDatabaseAsync();
    await createWorktreeGitMaintenance(env)({ retryDeferred: true });
    expect(await requireGit(repo, ["cat-file", "blob", missing], offlineGit)).toBe(input.trim());
    expect(await fs.readFile(indexPath)).toEqual(index);
    expect(await read(worktree.path, "staged.txt")).toBe("unstaged contents\n");
  });

  it("repairs stale pack lookup without rebuilding a repository-wide index", async () => {
    const repo = await initRepo(tempDirs.make("worktree-stale-pack-index-"));
    const packDirectory = path.join(repo, ".git", "objects", "pack");
    const indexPath = path.join(packDirectory, "multi-pack-index");
    await git(repo, "repack", "-a", "-d");
    await git(repo, "multi-pack-index", "write");
    const staleIndex = await fs.readFile(indexPath);
    const oldPacks = new Set(
      (await fs.readdir(packDirectory)).filter((name) => name.endsWith(".idx")),
    );
    await fs.writeFile(path.join(repo, "replacement.txt"), "replacement pack\n");
    await git(repo, "add", "replacement.txt");
    await git(repo, "commit", "-m", "replace pack");
    await git(repo, "repack", "-a", "-d");
    const currentPacks = (await fs.readdir(packDirectory)).filter((name) => name.endsWith(".idx"));
    expect(currentPacks.every((name) => !oldPacks.has(name))).toBe(true);
    const [record] = await materialize(repo, ["repair"]);
    // Reproduce an interrupted pack replacement without removing any reachable objects.
    await fs.writeFile(indexPath, staleIndex);
    const chainDirectory = path.join(packDirectory, "multi-pack-index.d");
    const checksum = staleIndex.subarray(-20).toString("hex");
    await fs.mkdir(chainDirectory);
    await fs.writeFile(path.join(chainDirectory, `multi-pack-index-${checksum}.midx`), staleIndex);
    const chainPath = path.join(chainDirectory, "multi-pack-index-chain");
    await fs.writeFile(chainPath, `${checksum}\n`);
    await createWorktreeGitMaintenance(env)({});

    await expectMissing(indexPath);
    await expectMissing(chainPath);
    await git(repo, "multi-pack-index", "verify");
    expect(await git(repo, "show", "HEAD:replacement.txt")).toBe("replacement pack");
    expect(await git(record!.path, "show", "HEAD:replacement.txt")).toBe("replacement pack");
  });

  it("maintains each shared repository and suspends failures until explicitly retried", async () => {
    const repo = await initRepo(tempDirs.make("worktree-gc-first-repo-"));
    const otherRepo = await initRepo(tempDirs.make("worktree-gc-second-repo-"));
    for (const repoRoot of [repo, otherRepo]) {
      await git(repoRoot, "repack", "-d");
    }
    for (const [index, repoRoot] of [repo, repo, otherRepo].entries()) {
      const name = `manual-${index}`;
      const worktreePath = path.join(repoRoot, name);
      await fs.mkdir(worktreePath);
      await register(repoRoot, name, {
        path: worktreePath,
        branch: `openclaw/${name}`,
      });
    }
    const records = await registryReads.readRegistryWorktrees(env);
    await stateDatabase.closeOpenClawStateDatabaseAsync();
    vi.spyOn(registryReads, "readRegistryWorktrees").mockResolvedValue(records);
    // Advance the scheduler without putting the host ahead of the real lease worker.
    let now = Date.now() - 3 * WORKTREE_GC_INTERVAL_MS;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const maintain = createWorktreeGitMaintenance(env);
    const controller = new AbortController();
    const execute = gitExec.executeGitCommand;
    const maintenanceRoots: string[] = [];
    const repairRoots: string[] = [];
    let failPackRepair = false;
    const commands = vi
      .spyOn(gitExec, "executeGitCommand")
      .mockImplementation(async (cwd, args, options) => {
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          repairRoots.push(cwd);
          if (failPackRepair && cwd === repo) {
            throw new Error("pack directory unavailable");
          }
        }
        if (args[0] !== "maintenance") {
          return await execute(cwd, args, options);
        }
        options?.beforeRun?.();
        maintenanceRoots.push(cwd);
        return {
          ...createCommandResult({
            stderr: cwd === repo ? "gc is already running" : "",
            code: cwd === repo ? 1 : 0,
          }),
          timeoutMs: options?.timeoutMs ?? 120_000,
        };
      });
    const logs = captureWarnings("worktree-gc-maintenance");
    const progress = new WorktreeGcProgress();
    await maintain({ signal: controller.signal, progress });
    const result = progress.result;
    expect(result).toMatchObject({
      removed: [],
      outcome: "partial",
      issues: [{ stage: "git-maintenance", id: repo, outcome: "failed" }],
      issueCount: 1,
    });
    expect(maintenanceRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
    expect(repairRoots.toSorted()).toEqual([repo, otherRepo].toSorted());
    const warning = await logs.findText("worktree Git maintenance");
    expect(warning).toContain("gc is already running");
    now += WORKTREE_GC_INTERVAL_MS;
    await maintain({ signal: controller.signal });
    expect(maintenanceRoots).toHaveLength(3);
    expect(repairRoots).toHaveLength(4);
    expect(maintenanceRoots.at(-1)).toBe(otherRepo);
    failPackRepair = true;
    now += WORKTREE_GC_INTERVAL_MS;
    await maintain({ signal: controller.signal });
    expect(repairRoots).toHaveLength(6);
    failPackRepair = false;
    now += WORKTREE_GC_INTERVAL_MS;
    await maintain({ signal: controller.signal });
    expect(repairRoots).toHaveLength(7);
    expect(maintenanceRoots).toHaveLength(5);
    await maintain({ signal: controller.signal, retryDeferred: true });
    expect(maintenanceRoots).toHaveLength(7);
    expect(repairRoots).toHaveLength(9);
    const calls = commands.mock.calls.length;
    controller.abort(new Error("cleanup cancelled"));
    await expect(maintain({ signal: controller.signal })).rejects.toThrow("cleanup cancelled");
    expect(commands).toHaveBeenCalledTimes(calls);
  });

  it("maintains partial clones without fetching missing historical heads", async () => {
    const root = tempDirs.make("worktree-maintenance-partial-clone-");
    const { source, repo: clone } = await partialClone(root, "clone");
    await git(source, "commit", "--allow-empty", "-m", "historical head");
    const missing = await git(source, "rev-parse", "HEAD");
    // A retained branch can outlive the partial clone's locally available objects.
    await fs.writeFile(path.join(clone, ".git", "refs", "heads", "historical"), `${missing}\n`);
    await git(clone, "config", "maintenance.commit-graph.auto", "-1");
    await register(clone, "partial-clone", { path: clone, branch: "main" });
    const trace = path.join(root, "maintenance-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    vi.stubEnv("GIT_NO_LAZY_FETCH", undefined);
    vi.stubEnv("GIT_ALLOW_PROTOCOL", "file");
    try {
      expect((await new ManagedWorktreeService({ env }).gc()).outcome).toBe("completed");
      expect(await fs.readFile(trace, "utf8")).not.toContain("upload-pack");
      expect((await runGit(clone, ["cat-file", "-e", missing], offlineGit)).code).not.toBe(0);
      await fs.access(
        path.join(clone, ".git", "objects", "info", "commit-graphs", "commit-graph-chain"),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports incomplete maintenance when its inventory fails", async () => {
    vi.spyOn(registryReads, "readRegistryWorktrees").mockRejectedValueOnce(
      new Error("maintenance inventory unavailable"),
    );
    const logs = captureWarnings("worktree-gc-inventory");
    const result = await new ManagedWorktreeService({ env }).gc();
    expect(result).toMatchObject({
      removed: [],
      outcome: "partial",
      issues: [{ stage: "git-maintenance", outcome: "failed" }],
      issueCount: 1,
    });
    expect(await logs.findText("worktree Git maintenance inventory failed")).toContain(
      "maintenance inventory unavailable",
    );
  });

  it("consolidates indexed promisor packs without fetching, losing local objects, or removing kept packs", async () => {
    const root = tempDirs.make("worktree-pack-consolidation-");
    const { repo } = await partialClone(root);
    const packDirectory = path.join(repo, ".git", "objects", "pack");
    const missing = await git(repo, "rev-list", "--objects", "--all", "--missing=print");
    expect(missing).toContain("?");
    const { objects, packs: generated } = await packBlobs(
      repo,
      Array.from({ length: 18 }, (_, index) => `payload-${index}`),
    );
    for (const [index, stem] of generated.entries()) {
      if (index < 17) {
        await fs.writeFile(path.join(packDirectory, `${stem}.promisor`), "");
      }
    }
    const kept = generated[0]!;
    await fs.writeFile(path.join(packDirectory, `${kept}.keep`), "retained by another owner");
    await git(repo, "prune-packed");
    await git(repo, "multi-pack-index", "write");
    await register(repo, "consolidate", { branch: "main" });
    const execute = gitExec.executeGitCommand;
    const commands = vi
      .spyOn(gitExec, "executeGitCommand")
      .mockImplementation(async (cwd, args, options) => {
        if (args.at(-1) === "openclaw-consolidate") {
          throw new Error("pack publication failed");
        }
        return execute(cwd, args, options);
      });
    const beforeFailure = await packNames(repo);
    const failed = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ progress: failed });
    expect(failed.result.gitMaintenance?.stage).toBe("suspended");
    expect(await packNames(repo)).toEqual(beforeFailure);
    commands.mockImplementation(execute);
    const trace = path.join(root, "pack-trace.jsonl");
    vi.stubEnv("GIT_TRACE2_EVENT", trace);
    const checkpoints: Array<NonNullable<ManagedWorktreeGcResult["gitMaintenance"]>> = [];
    const result = await new ManagedWorktreeService({ env }).gc({
      checkpoint: async (progress) => {
        if (progress.gitMaintenance) {
          checkpoints.push({ ...progress.gitMaintenance });
        }
      },
    });
    expect(result).toMatchObject({ outcome: "completed", packsRemoved: 16 });
    expect(checkpoints).toEqual(
      expect.arrayContaining([
        { repoRoot: repo, stage: "packs", packsBefore: 19, packsAfter: undefined },
        { repoRoot: repo, stage: "maintenance", packsBefore: 19, packsAfter: 3 },
      ]),
    );
    const remaining = await fs.readdir(packDirectory);
    expect(remaining.filter((name) => name.endsWith(".pack"))).toHaveLength(3);
    expect(remaining).toContain(`${kept}.pack`);
    expect(remaining).toContain(`${generated[17]}.pack`);
    expect(remaining.filter((name) => name.endsWith(".promisor"))).toHaveLength(2);
    expect(await objectTypes(repo, objects)).toBe(objects.map(() => "blob").join("\n"));
    expect(await git(repo, "rev-list", "--objects", "--all", "--missing=print")).toBe(missing);
    await git(repo, "multi-pack-index", "verify");
    expect(await fs.readFile(trace, "utf8")).not.toContain("upload-pack");
    // A tiny duplicate does not force rewriting its dominant pack or rebuilding
    // a full MIDX just to discover redundant copies.
    const duplicate = await pack(repo, [objects[1]!]);
    await fs.writeFile(path.join(packDirectory, `${duplicate}.promisor`), "");
    await createWorktreeGitMaintenance(env)({});
    const afterDuplicate = await fs.readdir(packDirectory);
    expect(afterDuplicate.filter((name) => name.endsWith(".pack"))).toHaveLength(4);
    expect(afterDuplicate.filter((name) => name.endsWith(".promisor"))).toHaveLength(3);
    expect(await git(repo, "cat-file", "-t", objects[1]!)).toBe("blob");
    await git(repo, "multi-pack-index", "verify");
  });

  it("rolls up equal-sized small packs while leaving a dominant pack untouched", async () => {
    const repo = await initRepo(tempDirs.make("worktree-geometric-packs-"));
    const directory = path.join(repo, ".git", "objects", "pack");
    const dominant = Buffer.alloc(4096);
    for (let offset = 0; offset < dominant.length; offset += 4) {
      dominant.writeUInt32BE(offset, offset);
    }
    const { objects, packs: stems } = await packBlobs(repo, ["small-a", "small-b", dominant]);
    const packs = stems.map((stem) => path.join(directory, `${stem}.pack`));
    const sizes = await Promise.all(packs.map(async (name) => (await fs.stat(name)).size));
    expect(sizes[2]).toBeGreaterThan(sizes[0]! + sizes[1]!);
    await git(repo, "prune-packed");
    await register(repo, "geometric-packs", { branch: "main" });
    const progress = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ progress });
    expect(progress.result.gitMaintenance).toMatchObject({
      stage: "completed",
      packsBefore: 3,
      packsAfter: 2,
    });
    await fs.access(packs[2]!);
    expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
  });

  it.each([
    { label: "index", packBytes: 240_000_000, indexBytes: 20_000_000 },
    { label: "pack", packBytes: 5_600_000_000, indexBytes: 20_000_000 },
  ])(
    "consolidates a backlog exceeding the old $label budget",
    async ({ packBytes, indexBytes }) => {
      const repo = await initRepo(tempDirs.make("worktree-backlog-"));
      const { objects, packs: stems } = await packBlobs(repo, [
        "backlog-a",
        "backlog-b",
        "backlog-c",
      ]);
      await git(repo, "prune-packed");
      await register(repo, "backlog", { branch: "main" });
      const stat = fs.stat;
      const paths = new Set(stems.map((stem) => path.join(packsPath(repo), stem)));
      // Admission sees production-sized metadata; Git still verifies real fixture objects.
      vi.spyOn(fs, "stat").mockImplementation(async (...args) => {
        const result = await stat(...args);
        const name = String(args[0]);
        if (result && paths.has(name.replace(/\.(pack|idx)$/, ""))) {
          result.size = name.endsWith(".pack") ? packBytes : indexBytes;
        }
        return result;
      });
      const progress = new WorktreeGcProgress();
      await createWorktreeGitMaintenance(env)({ progress });
      expect(progress.result.gitMaintenance).toMatchObject({
        stage: "completed",
        packsBefore: 3,
        packsAfter: 1,
      });
      expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
    },
  );

  it("skips a busy project without suspending or consuming its hourly maintenance slot", async () => {
    const repo = await initRepo(tempDirs.make("worktree-busy-maintenance-"));
    await packBlobs(repo, ["busy-a", "busy-b", "busy-c"]);
    await register(repo, "busy-maintenance", { branch: "main" });
    const maintain = createWorktreeGitMaintenance(env);
    await withProjectCheckoutLifecycle(repo, { env }, async () => {
      const progress = new WorktreeGcProgress();
      await maintain({ progress });
      expect(await packNames(repo)).toHaveLength(3);
      expect(progress.result.issues).toEqual([
        expect.objectContaining({ stage: "git-maintenance", outcome: "deferred" }),
      ]);
    });
    await maintain({});
    expect(await packNames(repo)).toHaveLength(1);
  });

  it("defers a pass whose maintenance lease expires instead of suspending repository maintenance", async () => {
    const repo = await initRepo(tempDirs.make("worktree-lost-lease-maintenance-"));
    const { objects } = await packBlobs(repo, ["lost-a", "lost-b", "lost-c"]);
    await git(repo, "prune-packed");
    await register(repo, "lost-lease", { branch: "main" });
    const real = Date.now();
    // Keep the scheduler behind the real lease worker except for the stalled heartbeat.
    let now = real - 3 * WORKTREE_GC_INTERVAL_MS;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const execute = gitExec.executeGitCommand;
    let stalled = false;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await execute(cwd, args, options);
      if (args.at(-1) === "openclaw-consolidate" && !stalled) {
        stalled = true;
        // The host misses every renewal while Git rewrites packs, as in production.
        now = real + 60_000;
      }
      return result;
    });
    const maintain = createWorktreeGitMaintenance(env);
    let progress = new WorktreeGcProgress();
    await maintain({ progress });
    expect(progress.result.issues).toEqual([
      expect.objectContaining({ stage: "git-maintenance", outcome: "deferred" }),
    ]);
    now = real - WORKTREE_GC_INTERVAL_MS;
    progress = new WorktreeGcProgress();
    await maintain({ progress });
    expect(progress.result.gitMaintenance?.stage).toBe("completed");
    expect(await packNames(repo)).toHaveLength(1);
    expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
  });

  it("admits foreground checkout preparation while packs are rewritten", async () => {
    const repo = await initRepo(tempDirs.make("worktree-pack-ref-queue-"));
    const { objects } = await packBlobs(repo, ["queue-a", "queue-b", "queue-c"]);
    await git(repo, "prune-packed");
    await register(repo, "pack-ref-queue", { branch: "main" });
    const execute = gitExec.executeGitCommand;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      // A base-ref fetch must not wait for the whole verification and rewrite.
      const signal = AbortSignal.timeout(5_000);
      if (args.at(-1) === "openclaw-consolidate") {
        const peer = new WorktreeGcProgress();
        await createWorktreeGitMaintenance(env)({ progress: peer });
        expect(peer.result.issues).toEqual([
          expect.objectContaining({ stage: "git-maintenance", outcome: "deferred" }),
        ]);
        await withProjectCheckoutLifecycle(repo, { env, signal, waitMs: 0 }, async (lease) => {
          await requireGit(
            repo,
            ["worktree", "add", "-b", "foreground", path.join(repo, "foreground")],
            {
              signal: lease.signal,
              beforeRun: () => lease.assertCurrent(),
            },
          );
        });
      }
      return await execute(cwd, args, options);
    });
    const progress = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ progress });
    expect(progress.result.gitMaintenance).toMatchObject({ stage: "completed", packsAfter: 1 });
    expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
    expect(await git(path.join(repo, "foreground"), "rev-parse", "HEAD")).toBe(
      await git(repo, "rev-parse", "HEAD"),
    );
  });

  it("defers pack retirement to foreground preparation and retries without suspending", async () => {
    const repo = await initRepo(tempDirs.make("worktree-retirement-yield-"));
    const { objects } = await packBlobs(repo, ["yield-a", "yield-b", "yield-c"]);
    await git(repo, "prune-packed");
    await register(repo, "retirement-yield", { branch: "main" });
    const entered = createDeferred();
    const release = createDeferred();
    const execute = gitExec.executeGitCommand;
    let foreground: Promise<void> | undefined;
    const commands = vi
      .spyOn(gitExec, "executeGitCommand")
      .mockImplementation(async (cwd, args, options) => {
        const result = await execute(cwd, args, options);
        if (args.at(-1) === "openclaw-consolidate") {
          foreground = withProjectCheckoutLifecycle(repo, { env, waitMs: 0 }, async () => {
            entered.resolve();
            await release.promise;
          });
          await Promise.race([entered.promise, foreground]);
        }
        return result;
      });
    const maintain = createWorktreeGitMaintenance(env);
    const progress = new WorktreeGcProgress();
    try {
      await maintain({ progress });
      expect(progress.result.issues).toEqual([
        expect.objectContaining({ stage: "git-maintenance", outcome: "deferred" }),
      ]);
      expect(await packNames(repo)).toHaveLength(4);
      expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
    } finally {
      release.resolve();
      await foreground;
      commands.mockRestore();
    }
    await maintain({});
    expect(await packNames(repo)).toHaveLength(1);
    expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
  });

  it("bounds retirement while finishing the current pack's sidecars", async () => {
    const repo = await initRepo(tempDirs.make("worktree-retirement-budget-"));
    const { objects } = await packBlobs(repo, ["bounded-a", "bounded-b", "bounded-c"]);
    await git(repo, "prune-packed");
    await register(repo, "retirement-budget", { branch: "main" });
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const remove = fs.rm;
    let retired: string | undefined;
    const retirement = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      await remove(target, options);
      if (String(target).startsWith(packsPath(repo)) && String(target).endsWith(".idx")) {
        retired = String(target).slice(0, -4);
        now += 251;
      }
    });
    const progress = new WorktreeGcProgress();
    const maintain = createWorktreeGitMaintenance(env);
    await maintain({ progress });
    expect(progress.result.gitMaintenance).toMatchObject({ stage: "completed", packsAfter: 3 });
    expect(retired).toBeDefined();
    for (const extension of ["idx", "pack", "rev", "bitmap", "promisor"]) {
      await expect(fs.access(`${retired}.${extension}`)).rejects.toHaveProperty("code", "ENOENT");
    }
    expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
    retirement.mockRestore();
    await maintain({ checkBacklog: true });
    expect((await packNames(repo)).length).toBeLessThan(3);
    expect(await objectTypes(repo, objects)).toBe("blob\nblob\nblob");
  });

  it("retains a replacement that is already an input and a pack pinned during publication", async () => {
    const repo = await initRepo(tempDirs.make("worktree-pack-existing-output-"));
    const directory = path.join(repo, ".git", "objects", "pack");
    const { objects, packs: inputs } = await packBlobs(
      repo,
      Array.from({ length: 15 }, (_, index) => `retained-${index}`),
      true,
    );
    for (const stem of inputs) {
      await fs.utimes(path.join(directory, `${stem}.pack`), 1, 1);
    }
    const union = await pack(repo, objects, true);
    await fs.utimes(path.join(directory, `${union}.pack`), 2, 2);
    await git(repo, "prune-packed");
    await register(repo, "existing-output", { branch: "main" });
    const execute = gitExec.executeGitCommand;
    vi.spyOn(gitExec, "executeGitCommand").mockImplementation(async (cwd, args, options) => {
      const result = await execute(cwd, args, options);
      if (args.at(-1) === "openclaw-consolidate") {
        expect(result.stdout.trim()).toBe(`pack\t${union.slice(5)}`);
        await fs.writeFile(
          path.join(directory, `${inputs[0]}.keep`),
          "another writer pinned this input",
        );
      }
      return result;
    });
    const progress = new WorktreeGcProgress();
    await createWorktreeGitMaintenance(env)({ progress });
    expect(progress.result.gitMaintenance).toMatchObject({
      stage: "completed",
      packsBefore: 16,
      packsAfter: 2,
    });
    expect(await packNames(repo)).toEqual([`${inputs[0]}.pack`, `${union}.pack`].toSorted());
    expect(await objectTypes(repo, objects)).toBe(objects.map(() => "blob").join("\n"));
  });

  it.skipIf(process.platform !== "linux")(
    "removes old abandoned temporary packs only after their open writer closes",
    async () => {
      const repo = await initRepo(tempDirs.make("worktree-temporary-packs-"));
      const directory = path.join(repo, ".git", "objects", "pack");
      const old = path.join(directory, "tmp_pack_abandoned");
      // An interrupted index-pack leaves its index beside the temporary pack.
      const oldIndex = path.join(directory, "tmp_idx_abandoned");
      const active = path.join(directory, "tmp_pack_active");
      const young = path.join(directory, "tmp_pack_young");
      const unrelated = path.join(directory, "operator-note");
      const link = path.join(directory, "tmp_pack_symlink");
      for (const file of [old, oldIndex, active, young, unrelated]) {
        await fs.writeFile(file, "retain or reclaim");
      }
      const yesterday = new Date(Date.now() - 48 * 60 * 60_000);
      for (const file of [old, oldIndex, active, unrelated]) {
        await fs.utimes(file, yesterday, yesterday);
      }
      await fs.symlink(unrelated, link);
      // A full batch of retained paths must not starve later abandoned packs.
      for (let index = 0; index < 256; index++) {
        await fs.symlink(unrelated, path.join(directory, `tmp_pack_aaa${index}`));
      }
      await register(repo, "temporary", { branch: "main" });
      const service = new ManagedWorktreeService({ env });
      const writer = await fs.open(active, "r+");
      try {
        await service.gc();
        await fs.access(active);
        await expectMissing(old);
        await expectMissing(oldIndex);
      } finally {
        await writer.close();
      }
      await service.gc({ retryDeferred: true });
      await expectMissing(old);
      await expectMissing(active);
      for (const file of [young, unrelated, link]) {
        await fs.access(file);
      }
    },
  );

  it("preserves shared reflog history and maintains repositories with already-missing reflog objects", async () => {
    const root = tempDirs.make("worktree-maintenance-reflogs-");
    const repo = await initRepo(root);
    await git(repo, "config", "gc.auto", "0");
    const [survivor, removed] = await materialize(repo, ["survivor", "removed"], root);
    const base = await git(repo, "rev-parse", "HEAD");
    await git(survivor!.path, "checkout", "--detach");
    await git(survivor!.path, "commit", "--allow-empty", "-m", "reflog-only commit");
    const retained = await git(survivor!.path, "rev-parse", "HEAD");
    await git(survivor!.path, "checkout", survivor!.branch);
    const service = new ManagedWorktreeService({ env });
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
    await packBlobs(
      repo,
      Array.from({ length: 3 }, (_, index) => `pack-${index}`),
    );
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
});
