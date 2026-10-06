import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as gitExec from "../../infra/git-exec.js";
import * as workerContext from "../../infra/git-worker-context.js";
import {
  classifyWorktreeEvictions,
  prepareWorktreeEvictionRepositories,
  purgeWorktreeCheckout,
} from "./eviction.runtime.js";
import { listGitWorktrees, requireGit, runGit } from "./git.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createEvictionCheckouts(root: string, count: number) {
  const repoRoot = path.join(root, "source");
  await fs.mkdir(root, { recursive: true });
  await requireGit(root, ["init", "--template=", "-b", "main", repoRoot]);
  await requireGit(repoRoot, [
    "-c",
    "user.name=OpenClaw Test",
    "-c",
    "user.email=openclaw-test@example.invalid",
    "-c",
    "commit.gpgSign=false",
    "commit",
    "--allow-empty",
    "-m",
    "eviction source",
  ]);
  const records = Array.from({ length: count }, (_, index) => ({
    id: `tree-${index}`,
    path: path.join(root, `tree-${index}`),
    repoRoot,
  }));
  for (const record of records) {
    await requireGit(repoRoot, ["worktree", "add", "--detach", record.path, "HEAD"]);
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
  const unrelatedHead = await requireGit(unrelated.repoRoot, ["rev-parse", "HEAD"]);
  const unrelatedInventory = await listGitWorktrees(unrelated.repoRoot);
  vi.stubEnv("GIT_DIR", path.join(unrelated.repoRoot, ".git"));
  vi.stubEnv("GIT_COMMON_DIR", path.join(unrelated.repoRoot, ".git"));
  vi.stubEnv("GIT_WORK_TREE", unrelatedCheckout.path);
  const text = vi.spyOn(gitExec, "executeGitCommand");
  const bytes = vi.spyOn(gitExec, "executeGitCommandBytes");
  const buffered = vi.spyOn(gitExec, "executeGitCommandBuffered");
  vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);

  await purgeWorktreeCheckout(victim, records);

  expect(
    text.mock.calls.length + bytes.mock.calls.length + buffered.mock.calls.length,
  ).toBeLessThanOrEqual(2);
  vi.unstubAllEnvs();
  await expect(fs.stat(victim.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await listGitWorktrees(repoRoot)).map((entry) => entry.path).toSorted()).toEqual(
    [repoRoot, ...records.slice(1).map((record) => record.path)].toSorted(),
  );
  for (const record of [...records.slice(1), unrelatedCheckout]) {
    expect(await fs.readFile(path.join(record.path, "unsaved.txt"), "utf8")).toBe(`${record.id}\n`);
  }
  expect(await listGitWorktrees(unrelated.repoRoot)).toEqual(unrelatedInventory);
  expect(await requireGit(unrelated.repoRoot, ["rev-parse", "HEAD"])).toBe(unrelatedHead);
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

  await expect(purgeWorktreeCheckout(victim, records)).rejects.toThrow(
    /inspection exceeded.*budget/,
  );

  expect(effects.mock.calls.some(([effect]) => effect.type === "worktree.eviction-admit")).toBe(
    false,
  );
  expect(
    commands.mock.calls.some(([, args]) => args[0] === "worktree" && args[1] === "remove"),
  ).toBe(false);
  expect(await fs.readFile(path.join(victim.path, "unsaved.txt"), "utf8")).toBe(`${victim.id}\n`);
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
  await requireGit(root, ["init", "--template=", "-b", "main", source]);
  await fs.writeFile(path.join(source, "source-owned.txt"), "source bytes\n");
  await fs.mkdir(record.path, { recursive: true });
  await fs.writeFile(path.join(record.path, "claimed.txt"), "claimed bytes\n");
  const originalParent = path.join(root, "original-claimed");
  let redirected = false;
  vi.spyOn(workerContext, "requestGitWorkerEffect").mockImplementation(async (effect) => {
    if (effect.type === "worktree.eviction-admit") {
      await fs.rename(claimedParent, originalParent);
      await fs.symlink(
        protectedParent,
        claimedParent,
        process.platform === "win32" ? "junction" : "dir",
      );
      redirected = true;
    }
    return undefined;
  });

  await expect(purgeWorktreeCheckout(record, [record])).rejects.toThrow("purge target changed");

  expect(redirected).toBe(true);
  expect(await fs.readFile(path.join(source, "source-owned.txt"), "utf8")).toBe("source bytes\n");
  expect(await fs.readFile(path.join(originalParent, "checkout", "claimed.txt"), "utf8")).toBe(
    "claimed bytes\n",
  );
  expect((await listGitWorktrees(source)).map((entry) => entry.path)).toContain(source);
});

it("recognizes a multi-commit squash, invalidates changed heads, and purges only the claimed checkout", async () => {
  const root = tempDirs.make("openclaw-eviction-");
  const repoRoot = path.join(root, "repo");
  await requireGit(root, ["init", "--template=", "-b", "main", repoRoot]);
  await requireGit(repoRoot, ["config", "user.name", "OpenClaw Test"]);
  await requireGit(repoRoot, ["config", "user.email", "openclaw-test@example.invalid"]);
  await requireGit(repoRoot, ["config", "commit.gpgSign", "false"]);
  await fs.writeFile(path.join(repoRoot, "base"), "base\n");
  await requireGit(repoRoot, ["add", "."]);
  await requireGit(repoRoot, ["commit", "-m", "base"]);
  const merged = { id: "merged", path: path.join(root, "merged"), repoRoot, branch: "merged" };
  const squashed = {
    id: "squashed",
    path: path.join(root, "squashed"),
    repoRoot,
    branch: "squashed",
  };
  const classify = async (records: Array<typeof squashed>) => {
    const [repository] = await prepareWorktreeEvictionRepositories([repoRoot]);
    return classifyWorktreeEvictions(
      records.map((record) => ({
        ...record,
        head: repository!.heads[path.resolve(record.path)],
        defaultHead: repository!.defaultHead,
      })),
    );
  };
  for (const item of [merged, squashed]) {
    await requireGit(repoRoot, ["worktree", "add", "-b", item.branch, item.path]);
  }
  for (const filename of ["one", "two"]) {
    await fs.writeFile(path.join(squashed.path, filename), `${filename}\n`);
    await requireGit(squashed.path, ["add", "."]);
    await requireGit(squashed.path, ["commit", "-m", filename]);
  }
  await requireGit(repoRoot, ["merge", "--squash", squashed.branch]);
  await requireGit(repoRoot, ["commit", "-m", "landed squash"]);
  expect(
    (await requireGit(repoRoot, ["cherry", "main", squashed.branch]))
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
  await requireGit(squashed.path, ["add", "."]);
  await requireGit(squashed.path, ["commit", "-m", "new work"]);
  expect(await classify([squashed])).toEqual([{ id: "squashed", reason: "idle-age" }]);

  await requireGit(repoRoot, ["remote", "add", "origin", "https://example.invalid/repo.git"]);
  expect(await classify([merged])).toEqual([{ id: "merged", reason: "idle-age" }]);
  await requireGit(repoRoot, ["update-ref", "refs/remotes/origin/main", "main"]);
  await requireGit(repoRoot, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  expect(await classify([merged])).toEqual([{ id: "merged", reason: "merged" }]);

  await fs.mkdir(path.join(squashed.path, "nested", ".git"), { recursive: true });
  await fs.writeFile(path.join(squashed.path, "unsaved"), "dirty data\n");
  await requireGit(repoRoot, ["worktree", "lock", "--reason", "old owner", squashed.path]);
  const branchHead = await requireGit(repoRoot, ["rev-parse", squashed.branch]);
  const authority = vi
    .spyOn(workerContext, "requestGitWorkerEffect")
    .mockRejectedValueOnce(new Error("claim lost"));
  await expect(purgeWorktreeCheckout(squashed, [merged, squashed])).rejects.toThrow("claim lost");
  expect(await fs.readFile(path.join(squashed.path, "unsaved"), "utf8")).toBe("dirty data\n");
  authority.mockResolvedValue(undefined);
  await purgeWorktreeCheckout(squashed, [merged, squashed]);
  await expect(fs.stat(squashed.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await requireGit(repoRoot, ["rev-parse", squashed.branch])).toBe(branchHead);
  expect(await fs.readFile(path.join(merged.path, "base"), "utf8")).toBe("base\n");
  expect((await runGit(repoRoot, ["status", "--porcelain"])).stdout).toBe("");
  await expect(
    purgeWorktreeCheckout({ id: "source", repoRoot, path: repoRoot }, [merged]),
  ).rejects.toThrow("source repository");
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
    await requireGit(root, ["init", "--template=", "-b", "main", repository]);
    await requireGit(repository, [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "synthetic source",
    ]);
  }
  const outer = { id: "outer", path: path.join(root, "outer"), repoRoot };
  const external = { id: "external", path: path.join(root, "external"), repoRoot: source };
  const unknown = {
    id: "unknown",
    path: path.join(root, "unknown"),
    repoRoot: path.join(root, "missing-source"),
  };
  await requireGit(repoRoot, ["worktree", "add", "-b", "outer", outer.path]);
  await requireGit(source, ["worktree", "add", "-b", "external", external.path]);
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
        await requireGit(originalSource, ["worktree", "repair", external.path]);
        await requireGit(repoRoot, ["worktree", "add", "-b", "replacement-source", source]);
        await fs.writeFile(path.join(source, "staged-source.txt"), "staged source bytes\n");
        await requireGit(source, ["add", "staged-source.txt"]);
        const privateDirectory = await requireGit(source, ["rev-parse", "--absolute-git-dir"]);
        const commonDirectory = await fs.realpath(
          path.resolve(source, await requireGit(source, ["rev-parse", "--git-common-dir"])),
        );
        sourcePrivateDirectory = path.join(outer.path, "source-private-git");
        await fs.rename(privateDirectory, sourcePrivateDirectory);
        await fs.writeFile(path.join(sourcePrivateDirectory, "commondir"), `${commonDirectory}\n`);
        await fs.writeFile(path.join(source, ".git"), `gitdir: ${sourcePrivateDirectory}\n`);
        sourcePrivateHead = await fs.readFile(path.join(sourcePrivateDirectory, "HEAD"));
        sourcePrivateIndex = await fs.readFile(path.join(sourcePrivateDirectory, "index"));
      } else {
        await requireGit(source, [
          "init",
          "--separate-git-dir",
          path.join(target === "metadata" ? outer.path : root, "relocated-git"),
        ]);
        await requireGit(source, ["worktree", "repair", external.path]);
      }
      if (target === "source behind a symlink") {
        await fs.writeFile(path.join(source, "source-data.txt"), "source data\n");
        const relocatedSource = path.join(outer.path, "relocated-source");
        await fs.rename(source, relocatedSource);
        await fs.symlink(
          relocatedSource,
          source,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
    }
    return undefined;
  });
  await expect(purgeWorktreeCheckout(outer, [outer, external, unknown])).rejects.toThrow(
    `repository dependency: ${external.id}`,
  );
  expect(relocated).toBe(true);
  expect(await fs.readFile(path.join(outer.path, "preserved.txt"), "utf8")).toBe("outer data\n");
  expect(await requireGit(external.path, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
  if (target === "source behind a symlink") {
    expect(await fs.readFile(path.join(source, "source-data.txt"), "utf8")).toBe("source data\n");
  }
  if (sourcePrivateDirectory) {
    expect(await fs.readFile(path.join(sourcePrivateDirectory, "HEAD"))).toEqual(sourcePrivateHead);
    expect(await fs.readFile(path.join(sourcePrivateDirectory, "index"))).toEqual(
      sourcePrivateIndex,
    );
    expect(await requireGit(source, ["rev-parse", "--verify", "HEAD"])).toBeTruthy();
  }
});

it.each(["available", "renamed", "replaced"] as const)(
  "preserves its own shared source metadata inside the checkout when the source is %s",
  async (sourceState) => {
    const root = tempDirs.make("openclaw-eviction-own-metadata-");
    const repoRoot = path.join(root, "source");
    const record = { id: "owned", path: path.join(root, "owned"), repoRoot };
    await requireGit(root, ["init", "--template=", "-b", "main", repoRoot]);
    await requireGit(repoRoot, [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "source objects",
    ]);
    const head = await requireGit(repoRoot, ["rev-parse", "HEAD"]);
    await requireGit(repoRoot, ["worktree", "add", "-b", "owned", record.path]);
    await requireGit(repoRoot, [
      "init",
      "--separate-git-dir",
      path.join(record.path, "source-git"),
    ]);
    await requireGit(repoRoot, ["worktree", "repair", record.path]);
    await fs.writeFile(path.join(record.path, "unsaved.txt"), "owned checkout bytes\n");
    if (sourceState !== "available") {
      await fs.rename(repoRoot, path.join(root, "renamed-source"));
    }
    if (sourceState === "replaced") {
      await requireGit(root, ["init", "--template=", "-b", "main", repoRoot]);
      await requireGit(repoRoot, [
        "-c",
        "user.name=OpenClaw Test",
        "-c",
        "user.email=openclaw-test@example.invalid",
        "-c",
        "commit.gpgSign=false",
        "commit",
        "--allow-empty",
        "-m",
        "unrelated replacement source",
      ]);
      expect(await requireGit(repoRoot, ["rev-parse", "HEAD"])).not.toBe(head);
    }
    vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);
    await expect(purgeWorktreeCheckout(record, [record])).rejects.toThrow(
      sourceState === "available"
        ? /source Git metadata|primary repository/
        : /source Git metadata/,
    );
    expect(await fs.readFile(path.join(record.path, "unsaved.txt"), "utf8")).toBe(
      "owned checkout bytes\n",
    );
    expect(await requireGit(record.path, ["rev-parse", "refs/heads/main"])).toBe(head);
    await expect(requireGit(record.path, ["cat-file", "-e", `${head}^{commit}`])).resolves.toBe("");
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
    await requireGit(root, ["init", "--template=", "-b", "main", donor]);
    await fs.writeFile(path.join(donor, filename), contents);
    await requireGit(donor, ["add", filename]);
    await requireGit(donor, [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "borrowed source objects",
    ]);
    const commit = await requireGit(donor, ["rev-parse", "HEAD"]);
    const blob = await requireGit(donor, ["rev-parse", `HEAD:${filename}`]);
    await fs.writeFile(
      path.join(repoRoot, ".git", "objects", "info", "alternates"),
      `${"# padding\n".repeat(120_000)}${path.join(donor, ".git", "objects")}\n`,
    );
    await requireGit(repoRoot, ["update-ref", "refs/heads/borrowed", commit]);
    let actualSource = repoRoot;
    if (sourceKind === "linked checkout source") {
      actualSource = path.join(root, "relocated-source");
      await fs.rename(repoRoot, actualSource);
      await requireGit(actualSource, ["worktree", "repair", victim.path]);
      await createEvictionCheckouts(root, 0);
    }
    for (const repository of [actualSource, victim.path]) {
      expect(await requireGit(repository, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
      expect(await requireGit(repository, ["cat-file", "blob", blob])).toBe(contents.trim());
    }
    vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);

    await expect(purgeWorktreeCheckout(victim, records)).rejects.toThrow(
      /source Git object dependencies are incomplete/,
    );

    expect(await fs.readFile(path.join(victim.path, "unsaved.txt"), "utf8")).toBe(`${victim.id}\n`);
    expect(await fs.readFile(path.join(donor, filename), "utf8")).toBe(contents);
    for (const repository of [actualSource, victim.path]) {
      expect(await requireGit(repository, ["cat-file", "-e", `${commit}^{commit}`])).toBe("");
      expect(await requireGit(repository, ["cat-file", "blob", blob])).toBe(contents.trim());
    }
  },
);

it.each(["standalone replacement", "broken pointer"] as const)(
  "keeps idle %s contents purgeable when no shared source metadata resolves",
  async (kind) => {
    const root = tempDirs.make("openclaw-eviction-unresolved-own-metadata-");
    const record = {
      id: "owned",
      path: path.join(root, "owned"),
      repoRoot: path.join(root, "missing-source"),
    };
    if (kind === "standalone replacement") {
      await requireGit(root, ["init", "--template=", "-b", "main", record.path]);
    } else {
      await fs.mkdir(record.path);
      await fs.writeFile(path.join(record.path, ".git"), "gitdir: missing-metadata\n");
    }
    await fs.writeFile(path.join(record.path, "unsaved.txt"), "eligible idle bytes\n");
    vi.spyOn(workerContext, "requestGitWorkerEffect").mockResolvedValue(undefined);
    await purgeWorktreeCheckout(record, [record]);
    await expect(fs.stat(record.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it.each([true, false])(
  "preserves its own source relocated inside the checkout during admission (registered=%s)",
  async (registered) => {
    const root = tempDirs.make("openclaw-eviction-own-source-admit-");
    const source = path.join(root, "source");
    const metadata = path.join(root, "source-metadata");
    const record = { id: "owned", repoRoot: source, path: path.join(root, "owned") };
    const relocatedSource = path.join(record.path, "relocated-source");
    const contents = "synthetic primary checkout bytes\n";
    await requireGit(root, [
      "init",
      "--template=",
      "-b",
      "main",
      "--separate-git-dir",
      metadata,
      source,
    ]);
    await fs.writeFile(path.join(source, "source-owned.txt"), contents);
    await requireGit(source, ["add", "source-owned.txt"]);
    await requireGit(source, [
      "-c",
      "user.name=OpenClaw Test",
      "-c",
      "user.email=openclaw-test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "-m",
      "synthetic source",
    ]);
    const head = await requireGit(source, ["rev-parse", "HEAD"]);
    if (registered) {
      await requireGit(source, ["worktree", "add", "--detach", record.path, "HEAD"]);
    } else {
      await fs.mkdir(record.path);
      await fs.writeFile(path.join(record.path, "source-owned.txt"), contents);
    }
    let relocated = false;
    vi.spyOn(workerContext, "requestGitWorkerEffect").mockImplementation(async (effect) => {
      if (effect.type === "worktree.eviction-admit" && !relocated) {
        await fs.rename(source, relocatedSource);
        await fs.symlink(
          relocatedSource,
          source,
          process.platform === "win32" ? "junction" : "dir",
        );
        relocated = true;
      }
      return undefined;
    });

    await expect(purgeWorktreeCheckout(record, [record])).rejects.toThrow(/source repository/);

    expect(relocated).toBe(true);
    expect(await fs.realpath(source)).toBe(relocatedSource);
    expect(await fs.readFile(path.join(source, "source-owned.txt"), "utf8")).toBe(contents);
    expect(await fs.readFile(path.join(record.path, "source-owned.txt"), "utf8")).toBe(contents);
    expect(await requireGit(source, ["rev-parse", "--verify", "HEAD"])).toBe(head);
    expect((await listGitWorktrees(source)).some((entry) => entry.path === record.path)).toBe(
      registered,
    );
  },
);
