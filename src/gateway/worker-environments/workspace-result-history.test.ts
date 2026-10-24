import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { runCommandBuffered } from "../../process/exec.js";
import { captureWorkspaceSnapshot } from "./workspace-manifest-worker.js";
import {
  adoptStagedWorkerWorkspaceHistory,
  applyStagedWorkerWorkspaceResult,
  readStagedWorkerWorkspaceResult,
  workerWorkspaceResultRef,
  workerWorkspaceResultStaging,
} from "./workspace-result-staging.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const git = (root: string, ...args: string[]) =>
  requireGit(
    root,
    [
      "-c",
      "user.name=Workspace Test",
      "-c",
      "user.email=workspace@example.invalid",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ],
    { timeoutMs: 10_000 },
  );

async function fixture(kind: "fast-forward" | "moved" | "divergent" | "empty" = "fast-forward") {
  const root = tempDirs.make("workspace-history-");
  const local = path.join(root, "local");
  const worker = path.join(root, "worker");
  await fs.mkdir(local);
  await git(local, "init", "--quiet");
  await fs.writeFile(path.join(local, "tracked.txt"), "base\n");
  await fs.writeFile(path.join(local, "local.txt"), "local base\n");
  await git(local, "add", ".");
  await git(local, "commit", "--quiet", "-m", "base");
  const baseCommit = await git(local, "rev-parse", "HEAD");
  const base = await captureWorkspaceSnapshot({ root: local, baseCommit });
  await git(root, "clone", "--quiet", "--no-local", local, worker);
  if (kind === "divergent") {
    await git(worker, "checkout", "--quiet", "--orphan", "rewritten");
  }
  if (kind !== "empty") {
    await fs.writeFile(path.join(worker, "tracked.txt"), "committed\n");
    await git(worker, "add", ".");
  }
  await git(worker, "commit", "--quiet", "--allow-empty", "-m", "worker-authored commit");
  const headCommit = await git(worker, "rev-parse", "HEAD");
  let gitPackPath: string | undefined;
  if (kind !== "divergent") {
    const pack = await runCommandBuffered(
      ["git", "-C", worker, "pack-objects", "--revs", "--stdout"],
      {
        timeoutMs: 10_000,
        input: Buffer.from(`${headCommit}\n^${baseCommit}\n`),
        maxOutputBytes: 1024 * 1024,
      },
    );
    expect(pack.code).toBe(0);
    gitPackPath = path.join(root, "worker.pack");
    await fs.writeFile(gitPackPath, pack.stdout);
  }
  if (kind !== "empty") {
    await fs.writeFile(path.join(worker, "tracked.txt"), "uncommitted edit\n");
    await fs.writeFile(path.join(worker, "new.txt"), "uncommitted new file\n");
  }
  const current = await captureWorkspaceSnapshot({ root: worker, baseCommit });
  let expectedLocalHead = baseCommit;
  if (kind === "moved") {
    await git(local, "commit", "--quiet", "--allow-empty", "-m", "local branch advanced");
    expectedLocalHead = await git(local, "rev-parse", "HEAD");
  }
  const ref = workerWorkspaceResultRef(`history-${kind}`);
  await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
    root: local,
    stagingRoot: worker,
    stagedResultRef: ref,
    baseManifestRef: base.manifestRef,
    currentManifestRef: current.manifestRef,
    baseManifestRaw: base.rawManifest,
    currentManifestRaw: current.rawManifest,
    gitHistory: { baseCommit, headCommit, descendsFromBase: kind !== "divergent" },
    gitPackPath,
  });
  return { local, worker, ref, baseCommit, headCommit, expectedLocalHead, base };
}

const journal = {
  load: async () => undefined,
  begin: async () => {},
  commit: async () => {},
  abort: async () => {},
};

it("retains worker history through result GC and adopts it while leaving later edits unstaged", async () => {
  const f = await fixture();
  expect((await readStagedWorkerWorkspaceResult(f.local, f.ref)).gitHistory?.headCommit).toBe(
    f.headCommit,
  );
  await git(f.local, "gc", "--prune=now", "--quiet");
  expect(await git(f.local, "show", "-s", "--format=%s", `${f.ref}^`)).toBe(
    "worker-authored commit",
  );
  await applyStagedWorkerWorkspaceResult({
    root: f.local,
    stagedResultRef: f.ref,
    expectedBaseManifestRef: f.base.manifestRef,
    journal,
  });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.baseCommit);
  await expect(
    adoptStagedWorkerWorkspaceHistory({ root: f.local, stagedResultRef: f.ref }),
  ).resolves.toBeUndefined();
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.headCommit);
  expect(await git(f.local, "show", "HEAD:tracked.txt")).toBe("committed");
  expect(await fs.readFile(path.join(f.local, "tracked.txt"), "utf8")).toBe("uncommitted edit\n");
  expect(await git(f.local, "diff", "--cached", "--name-only")).toBe("");
  expect(await git(f.local, "diff", "--name-only")).toBe("tracked.txt");
  expect(await git(f.local, "status", "--porcelain")).toContain("?? new.txt");
  // Recovery after the ref update repeats the index cutover without another commit.
  await adoptStagedWorkerWorkspaceHistory({ root: f.local, stagedResultRef: f.ref });
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.headCommit);
});

it.each(["edited", "deleted"] as const)(
  "preserves unrelated staged content when its working file is %s",
  async (workingFile) => {
    const f = await fixture();
    const file = path.join(f.local, "local.txt");
    await fs.writeFile(file, "staged content\n");
    await git(f.local, "add", "local.txt");
    if (workingFile === "edited") {
      await fs.writeFile(file, "working content\n");
    } else {
      await fs.rm(file);
    }
    await applyStagedWorkerWorkspaceResult({
      root: f.local,
      stagedResultRef: f.ref,
      expectedBaseManifestRef: f.base.manifestRef,
      journal,
    });
    for (let replay = 0; replay < 2; replay++) {
      await expect(
        adoptStagedWorkerWorkspaceHistory({ root: f.local, stagedResultRef: f.ref }),
      ).resolves.toBeUndefined();
      expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.headCommit);
      expect(await git(f.local, "show", ":local.txt")).toBe("staged content");
      expect(await git(f.local, "diff", "--cached", "--name-only")).toBe("local.txt");
      if (workingFile === "edited") {
        expect(await fs.readFile(file, "utf8")).toBe("working content\n");
      } else {
        await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
      }
    }
  },
);

it("keeps the branch and staged content when the index conflicts with worker commits", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.local, "tracked.txt"), "staged local content\n");
  await git(f.local, "add", "tracked.txt");
  await fs.writeFile(path.join(f.local, "tracked.txt"), "base\n");
  await applyStagedWorkerWorkspaceResult({
    root: f.local,
    stagedResultRef: f.ref,
    expectedBaseManifestRef: f.base.manifestRef,
    journal,
  });
  await expect(
    adoptStagedWorkerWorkspaceHistory({ root: f.local, stagedResultRef: f.ref }),
  ).resolves.toContain("staged changes conflict with worker commits");
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.baseCommit);
  expect(await git(f.local, "show", ":tracked.txt")).toBe("staged local content");
  expect(await fs.readFile(path.join(f.local, "tracked.txt"), "utf8")).toBe("uncommitted edit\n");
});

it.each([
  ["moved", "Gateway branch moved since dispatch"],
  ["divergent", "worker history does not descend from the dispatch base"],
] as const)(
  "keeps file reconciliation when history is %s and names the fallback",
  async (kind, reason) => {
    const f = await fixture(kind);
    await applyStagedWorkerWorkspaceResult({
      root: f.local,
      stagedResultRef: f.ref,
      expectedBaseManifestRef: f.base.manifestRef,
      journal,
    });
    await expect(
      adoptStagedWorkerWorkspaceHistory({ root: f.local, stagedResultRef: f.ref }),
    ).resolves.toContain(reason);
    expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.expectedLocalHead);
    expect(await fs.readFile(path.join(f.local, "tracked.txt"), "utf8")).toBe("uncommitted edit\n");
    expect(await fs.readFile(path.join(f.local, "new.txt"), "utf8")).toBe("uncommitted new file\n");
  },
);

it("adopts an empty worker commit when file manifests are identical", async () => {
  const f = await fixture("empty");
  await expect(
    adoptStagedWorkerWorkspaceHistory({ root: f.local, stagedResultRef: f.ref }),
  ).resolves.toBeUndefined();
  expect(await git(f.local, "rev-parse", "HEAD")).toBe(f.headCommit);
  expect(await git(f.local, "status", "--porcelain")).toBe("");
});
