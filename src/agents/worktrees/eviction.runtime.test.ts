import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import * as workerContext from "../../infra/git-worker-context.js";
import {
  classifyWorktreeEvictions,
  prepareWorktreeEvictionRepositories,
  purgeWorktreeCheckout as purgeCheckout,
} from "./eviction.runtime.js";
import { gitIdentity, initializeGitFixture } from "./git-fixture.test-support.js";
import { listGitWorktrees, requireGit as git, runGit } from "./git.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function commitFixture(repo: string, message: string, allowEmpty = false) {
  await git(repo, [
    ...gitIdentity,
    "-c",
    "commit.gpgSign=false",
    "commit",
    ...(allowEmpty ? ["--allow-empty"] : []),
    "-m",
    message,
  ]);
}
const init = (cwd: string, repo: string, ...options: string[]) =>
  git(cwd, ["init", "--template=", "-b", "main", ...options, repo]);
const read = (directory: string, filename: string) =>
  fs.readFile(path.join(directory, filename), "utf8");
const linkDirectory = (target: string, link: string) =>
  fs.symlink(target, link, process.platform === "win32" ? "junction" : "dir");
async function relocateGit(repo: string, gitDir: string, linked: string) {
  await git(repo, ["init", "--separate-git-dir", gitDir]);
  await git(repo, ["worktree", "repair", linked]);
}

async function createEvictionCheckouts(root: string, count: number) {
  const repoRoot = path.join(root, "source");
  await fs.mkdir(root, { recursive: true });
  await init(root, repoRoot);
  await commitFixture(repoRoot, "eviction source", true);
  const records = Array.from({ length: count }, (_, index) => ({
    id: `tree-${index}`,
    path: path.join(root, `tree-${index}`),
    repoRoot,
  }));
  for (const record of records) {
    await git(repoRoot, ["worktree", "add", "--detach", record.path, "HEAD"]);
    await fs.writeFile(path.join(record.path, "unsaved.txt"), `${record.id}\n`);
  }
  return { repoRoot, records };
}

it("purges a fleet checkout with a constant Git process budget despite ambient repository redirects", async () => {
  const root = tempDirs.make("openclaw-eviction-fleet-");
  const { repoRoot, records } = await createEvictionCheckouts(root, 13);
  const unrelated = await createEvictionCheckouts(path.join(root, "unrelated"), 1);
  const victim = records[0]!;
  const unrelatedCheckout = unrelated.records[0]!;
  const unrelatedHead = await git(unrelated.repoRoot, ["rev-parse", "HEAD"]);
  const unrelatedInventory = await listGitWorktrees(unrelated.repoRoot);
  vi.stubEnv("GIT_DIR", path.join(unrelated.repoRoot, ".git"));
  vi.stubEnv("GIT_COMMON_DIR", path.join(unrelated.repoRoot, ".git"));
  vi.stubEnv("GIT_WORK_TREE", unrelatedCheckout.path);
  const text = vi.spyOn(gitExec, "executeGitCommand");
  const bytes = vi.spyOn(gitExec, "executeGitCommandBytes");
  const buffered = vi.spyOn(gitExec, "executeGitCommandBuffered");
  vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);

  await purgeCheckout(victim, records);

  expect(
    text.mock.calls.length + bytes.mock.calls.length + buffered.mock.calls.length,
  ).toBeLessThanOrEqual(2);
  vi.unstubAllEnvs();
  await expect(fs.stat(victim.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await listGitWorktrees(repoRoot)).map((entry) => entry.path).toSorted()).toEqual(
    [repoRoot, ...records.slice(1).map((record) => record.path)].toSorted(),
  );
  for (const record of [...records.slice(1), unrelatedCheckout]) {
    expect(await read(record.path, "unsaved.txt")).toBe(`${record.id}\n`);
  }
  expect(await listGitWorktrees(unrelated.repoRoot)).toEqual(unrelatedInventory);
  expect(await git(unrelated.repoRoot, ["rev-parse", "HEAD"])).toBe(unrelatedHead);
});

it("defers an expired metadata census before admitting or deleting the checkout", async () => {
  const root = tempDirs.make("openclaw-eviction-census-budget-");
  const { repoRoot, records } = await createEvictionCheckouts(root, 1);
  const victim = records[0]!;
  const execute = gitExec.executeGitCommand;
  const commands = vi
    .spyOn(gitExec, "executeGitCommand")
    .mockImplementation(async (cwd, args, options) => {
      const result = await execute(cwd, args, options);
      if (args[0] === "worktree" && args[1] === "list") {
        let elapsed = 0;
        vi.spyOn(performance, "now").mockImplementation(() => (elapsed += 5_001));
      }
      return result;
    });
  const effects = vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);

  await expect(purgeCheckout(victim, records)).rejects.toThrow(/inspection exceeded.*budget/);

  expect(effects.mock.calls.some(([effect]) => effect.type === "worktree.eviction-admit")).toBe(
    false,
  );
  expect(
    commands.mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "remove"),
  ).toBe(false);
  expect(await read(victim.path, "unsaved.txt")).toBe(`${victim.id}\n`);
  vi.restoreAllMocks();
  expect((await listGitWorktrees(repoRoot)).some((entry) => entry.path === victim.path)).toBe(true);
});

it("refuses a purge target redirected through its parent during admission", async () => {
  const root = tempDirs.make("openclaw-eviction-parent-redirect-");
  const protectedParent = path.join(root, "protected");
  const claimedParent = path.join(root, "claimed");
  const source = path.join(protectedParent, "checkout");
  const record = { id: "claimed", repoRoot: source, path: path.join(claimedParent, "checkout") };
  await fs.mkdir(protectedParent);
  await init(root, source);
  await fs.writeFile(path.join(source, "source-owned.txt"), "source bytes\n");
  await fs.mkdir(record.path, { recursive: true });
  await fs.writeFile(path.join(record.path, "claimed.txt"), "claimed bytes\n");
  const originalParent = path.join(root, "original-claimed");
  let redirected = false;
  vi.spyOn(workerContext, "requestGitWorkerEffect").mockImplementation(async (effect) => {
    if (effect.type === "worktree.eviction-admit") {
      await fs.rename(claimedParent, originalParent);
      await linkDirectory(protectedParent, claimedParent);
      redirected = true;
    }
    return undefined;
  });

  await expect(purgeCheckout(record, [record])).rejects.toThrow("purge target changed");

  expect(redirected).toBe(true);
  expect(await read(source, "source-owned.txt")).toBe("source bytes\n");
  expect(await read(path.join(originalParent, "checkout"), "claimed.txt")).toBe("claimed bytes\n");
  expect((await listGitWorktrees(source)).map((entry) => entry.path)).toContain(source);
});

it("recognizes a multi-commit squash, invalidates changed heads, and purges only the claimed checkout", async () => {
  const root = tempDirs.make("openclaw-eviction-");
  const repoRoot = await initializeGitFixture(root, "repo", "base", "base\n");
  const merged = { id: "merged", path: path.join(root, "merged"), repoRoot };
  const squashed = { id: "squashed", path: path.join(root, "squashed"), repoRoot };
  const classify = async (records: Array<typeof squashed>) => {
    const [repository] = await prepareWorktreeEvictionRepositories([repoRoot]);
    return classifyWorktreeEvictions(
      records.map((record) => ({
        ...record,
        branch: record.id,
        head: repository!.heads[path.resolve(record.path)],
        defaultHead: repository!.defaultHead,
      })),
    );
  };
  for (const item of [merged, squashed]) {
    await git(repoRoot, ["worktree", "add", "-b", item.id, item.path]);
  }
  for (const filename of ["one", "two"]) {
    await fs.writeFile(path.join(squashed.path, filename), `${filename}\n`);
    await git(squashed.path, ["add", "."]);
    await git(squashed.path, ["commit", "-m", filename]);
  }
  await git(repoRoot, ["merge", "--squash", squashed.id]);
  await git(repoRoot, ["commit", "-m", "landed squash"]);
  expect(
    (await git(repoRoot, ["cherry", "main", squashed.id]))
      .split("\n")
      .every((line) => line.startsWith("+")),
  ).toBe(true);
  const unrelatedObjects = path.join(root, "unrelated-objects");
  await fs.mkdir(unrelatedObjects);
  vi.stubEnv("GIT_OBJECT_DIRECTORY", unrelatedObjects);
  vi.stubEnv("GIT_ALTERNATE_OBJECT_DIRECTORIES", unrelatedObjects);
  const current = vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);
  try {
    expect(await classify([merged, squashed])).toEqual([
      { id: "merged", reason: "merged" },
      { id: "squashed", reason: "squashed" },
    ]);
  } finally {
    current.mockRestore();
    vi.unstubAllEnvs();
  }
  await fs.writeFile(path.join(squashed.path, "new-work"), "unlanded\n");
  await git(squashed.path, ["add", "."]);
  await git(squashed.path, ["commit", "-m", "new work"]);
  expect(await classify([squashed])).toEqual([{ id: "squashed", reason: "idle-age" }]);

  await git(repoRoot, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  expect(await classify([merged])).toEqual([{ id: "merged", reason: "idle-age" }]);
  const originMain = "refs/remotes/origin/main";
  await git(repoRoot, ["update-ref", originMain, "main"]);
  await git(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", originMain]);
  expect(await classify([merged])).toEqual([{ id: "merged", reason: "merged" }]);

  await fs.mkdir(path.join(squashed.path, "nested", ".git"), { recursive: true });
  await fs.writeFile(path.join(squashed.path, "unsaved"), "dirty data\n");
  await git(repoRoot, ["worktree", "lock", "--reason", "old owner", squashed.path]);
  const branchHead = await git(repoRoot, ["rev-parse", squashed.id]);
  const authority = vi
    .spyOn(workerContext, "requestGitWorkerEffect")
    .mockRejectedValueOnce(new Error("claim lost"));
  await expect(purgeCheckout(squashed, [merged, squashed])).rejects.toThrow("claim lost");
  expect(await read(squashed.path, "unsaved")).toBe("dirty data\n");
  authority.mockResolvedValue(undefined);
  await purgeCheckout(squashed, [merged, squashed]);
  await expect(fs.stat(squashed.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await git(repoRoot, ["rev-parse", squashed.id])).toBe(branchHead);
  expect(await read(merged.path, "base")).toBe("base\n");
  expect((await runGit(repoRoot, ["status", "--porcelain"])).stdout).toBe("");
  await expect(purgeCheckout({ id: "source", repoRoot, path: repoRoot }, [merged])).rejects.toThrow(
    "source repository",
  );
});

it.each([
  ["metadata", "worktree.eviction-fence"],
  ["metadata", "worktree.eviction-admit"],
  ["source behind a symlink", "worktree.eviction-admit"],
  ["source private metadata", "worktree.eviction-admit"],
] as const)("rechecks relocated %s after awaiting %s", async (target, phase) => {
  const root = tempDirs.make("openclaw-eviction-fence-race-");
  const repoRoot = path.join(root, "repo");
  const source = path.join(root, "external-source");
  for (const repository of [repoRoot, source]) {
    await init(root, repository);
    await commitFixture(repository, "synthetic source", true);
  }
  const outer = { id: "outer", path: path.join(root, "outer"), repoRoot };
  const external = { id: "external", path: path.join(root, "external"), repoRoot: source };
  const missingSource = path.join(root, "missing-source");
  const unknown = { id: "unknown", path: path.join(root, "unknown"), repoRoot: missingSource };
  await git(repoRoot, ["worktree", "add", "-b", "outer", outer.path]);
  await git(source, ["worktree", "add", "-b", "external", external.path]);
  await fs.writeFile(path.join(outer.path, "preserved.txt"), "outer data\n");
  let relocated = false;
  let sourcePrivateDirectory: string | undefined;
  let sourcePrivateHead: Buffer | undefined;
  let sourcePrivateIndex: Buffer | undefined;
  vi.spyOn(workerContext, "requestGitWorkerEffect").mockImplementation(async (effect) => {
    if (effect.type === phase) {
      if (effect.type === "worktree.eviction-fence") {
        expect(effect.input.worktreeIds).toEqual([unknown.id]);
      }
      relocated = true;
      if (target === "source private metadata") {
        const originalSource = path.join(root, "original-source");
        await fs.rename(source, originalSource);
        await git(originalSource, ["worktree", "repair", external.path]);
        await git(repoRoot, ["worktree", "add", "-b", "replacement-source", source]);
        await fs.writeFile(path.join(source, "staged-source.txt"), "staged source bytes\n");
        await git(source, ["add", "staged-source.txt"]);
        const privateDirectory = await git(source, ["rev-parse", "--absolute-git-dir"]);
        const commonDirectory = await fs.realpath(
          path.resolve(source, await git(source, ["rev-parse", "--git-common-dir"])),
        );
        sourcePrivateDirectory = path.join(outer.path, "source-private-git");
        await fs.rename(privateDirectory, sourcePrivateDirectory);
        await fs.writeFile(path.join(sourcePrivateDirectory, "commondir"), `${commonDirectory}\n`);
        await fs.writeFile(path.join(source, ".git"), `gitdir: ${sourcePrivateDirectory}\n`);
        sourcePrivateHead = await fs.readFile(path.join(sourcePrivateDirectory, "HEAD"));
        sourcePrivateIndex = await fs.readFile(path.join(sourcePrivateDirectory, "index"));
      } else {
        const gitDir = path.join(target === "metadata" ? outer.path : root, "relocated-git");
        await relocateGit(source, gitDir, external.path);
      }
      if (target === "source behind a symlink") {
        await fs.writeFile(path.join(source, "source-data.txt"), "source data\n");
        const relocatedSource = path.join(outer.path, "relocated-source");
        await fs.rename(source, relocatedSource);
        await linkDirectory(relocatedSource, source);
      }
    }
    return undefined;
  });
  await expect(purgeCheckout(outer, [outer, external, unknown])).rejects.toThrow(
    `repository dependency: ${external.id}`,
  );
  expect(relocated).toBe(true);
  expect(await read(outer.path, "preserved.txt")).toBe("outer data\n");
  expect(await git(external.path, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
  if (target === "source behind a symlink") {
    expect(await read(source, "source-data.txt")).toBe("source data\n");
  }
  if (sourcePrivateDirectory) {
    expect(await fs.readFile(path.join(sourcePrivateDirectory, "HEAD"))).toEqual(sourcePrivateHead);
    expect(await fs.readFile(path.join(sourcePrivateDirectory, "index"))).toEqual(
      sourcePrivateIndex,
    );
    expect(await git(source, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
  }
});

it.each(["available", "renamed", "replaced"] as const)(
  "preserves its own shared source metadata inside the checkout when the source is %s",
  async (sourceState) => {
    const root = tempDirs.make("openclaw-eviction-own-metadata-");
    const repoRoot = path.join(root, "source");
    const record = { id: "owned", path: path.join(root, "owned"), repoRoot };
    await init(root, repoRoot);
    await commitFixture(repoRoot, "source objects", true);
    const head = await git(repoRoot, ["rev-parse", "HEAD"]);
    await git(repoRoot, ["worktree", "add", "-b", "owned", record.path]);
    await relocateGit(repoRoot, path.join(record.path, "source-git"), record.path);
    await fs.writeFile(path.join(record.path, "unsaved.txt"), "owned checkout bytes\n");
    if (sourceState !== "available") {
      await fs.rename(repoRoot, path.join(root, "renamed-source"));
    }
    if (sourceState === "replaced") {
      await init(root, repoRoot);
      await commitFixture(repoRoot, "unrelated replacement source", true);
      expect(await git(repoRoot, ["rev-parse", "HEAD"])).not.toBe(head);
    }
    vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);
    await expect(purgeCheckout(record, [record])).rejects.toThrow(
      sourceState === "available"
        ? /source Git metadata|primary repository/
        : /source Git metadata/,
    );
    expect(await read(record.path, "unsaved.txt")).toBe("owned checkout bytes\n");
    expect(await git(record.path, ["rev-parse", "refs/heads/main"])).toBe(head);
    await expect(git(record.path, ["cat-file", "-e", `${head}^{commit}`])).resolves.toBe("");
  },
);

it.each(["recorded source", "linked checkout source"] as const)(
  "preserves borrowed objects when its %s has oversized valid alternates",
  async (sourceKind) => {
    const root = tempDirs.make("openclaw-eviction-incomplete-own-objects-");
    const { repoRoot, records } = await createEvictionCheckouts(root, 1);
    const victim = records[0]!;
    const donor = path.join(victim.path, "donor");
    const filename = "borrowed-only.txt";
    const contents = "source object bytes stored only inside the eviction candidate\n";
    await init(root, donor);
    await fs.writeFile(path.join(donor, filename), contents);
    await git(donor, ["add", filename]);
    await commitFixture(donor, "borrowed source objects");
    const commit = await git(donor, ["rev-parse", "HEAD"]);
    const blob = await git(donor, ["rev-parse", `HEAD:${filename}`]);
    await fs.writeFile(
      path.join(repoRoot, ".git", "objects", "info", "alternates"),
      `${"# padding\n".repeat(120_000)}${path.join(donor, ".git", "objects")}\n`,
    );
    await git(repoRoot, ["update-ref", "refs/heads/borrowed", commit]);
    let actualSource = repoRoot;
    if (sourceKind === "linked checkout source") {
      actualSource = path.join(root, "relocated-source");
      await fs.rename(repoRoot, actualSource);
      await git(actualSource, ["worktree", "repair", victim.path]);
      await createEvictionCheckouts(root, 0);
    }
    for (const repository of [actualSource, victim.path]) {
      expect(await git(repository, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
      expect(await git(repository, ["cat-file", "blob", blob])).toBe(contents.trim());
    }
    vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);

    await expect(purgeCheckout(victim, records)).rejects.toThrow(
      /source Git object dependencies are incomplete/,
    );

    expect(await read(victim.path, "unsaved.txt")).toBe(`${victim.id}\n`);
    expect(await read(donor, filename)).toBe(contents);
    for (const repository of [actualSource, victim.path]) {
      expect(await git(repository, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
      expect(await git(repository, ["cat-file", "blob", blob])).toBe(contents.trim());
    }
  },
);

it("keeps an idle standalone replacement purgeable when no shared source metadata resolves", async () => {
  const root = tempDirs.make("openclaw-eviction-unresolved-own-metadata-");
  const repoRoot = path.join(root, "missing-source");
  const record = { id: "owned", path: path.join(root, "owned"), repoRoot };
  await init(root, record.path);
  await fs.writeFile(path.join(record.path, "unsaved.txt"), "eligible idle bytes\n");
  vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);
  await purgeCheckout(record, [record]);
  await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([true, false])(
  "preserves its own source relocated inside the checkout during admission (registered=%s)",
  async (registered) => {
    const root = tempDirs.make("openclaw-eviction-own-source-admit-");
    const source = path.join(root, "source");
    const metadata = path.join(root, "source-metadata");
    const record = { id: "owned", repoRoot: source, path: path.join(root, "owned") };
    const relocatedSource = path.join(record.path, "relocated-source");
    const contents = "synthetic primary checkout bytes\n";
    await init(root, source, "--separate-git-dir", metadata);
    await fs.writeFile(path.join(source, "source-owned.txt"), contents);
    await git(source, ["add", "source-owned.txt"]);
    await commitFixture(source, "synthetic source");
    const head = await git(source, ["rev-parse", "HEAD"]);
    if (registered) {
      await git(source, ["worktree", "add", "--detach", record.path, "HEAD"]);
    } else {
      await fs.mkdir(record.path);
      await fs.writeFile(path.join(record.path, "source-owned.txt"), contents);
    }
    let relocated = false;
    vi.spyOn(workerContext, "requestGitWorkerEffect").mockImplementation(async (effect) => {
      if (effect.type === "worktree.eviction-admit" && !relocated) {
        await fs.rename(source, relocatedSource);
        await linkDirectory(relocatedSource, source);
        relocated = true;
      }
      return undefined;
    });

    await expect(purgeCheckout(record, [record])).rejects.toThrow(/source repository/);

    expect(relocated).toBe(true);
    expect(await fs.realpath(source)).toBe(relocatedSource);
    expect(await read(source, "source-owned.txt")).toBe(contents);
    expect(await read(record.path, "source-owned.txt")).toBe(contents);
    expect(await git(source, ["rev-parse", "--verify", "HEAD"])).toBe(head);
    expect((await listGitWorktrees(source)).some((entry) => entry.path === record.path)).toBe(
      registered,
    );
  },
);
