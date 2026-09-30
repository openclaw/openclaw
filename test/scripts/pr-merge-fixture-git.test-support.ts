import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";

function createFixtureGit(repo: string, gitEnv: NodeJS.ProcessEnv) {
  const git = (args: string[], input?: string, cwd = repo, env?: NodeJS.ProcessEnv) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
      cwd,
      env: { ...gitEnv, ...env },
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const tree = (owner: string, sibling = "stable\n") => {
    const a = git(["hash-object", "-w", "--stdin"], owner);
    const b = git(["hash-object", "-w", "--stdin"], sibling);
    return git(["mktree"], `100644 blob ${a}\towner.txt\n100644 blob ${b}\tsibling.txt\n`);
  };
  const commit = (
    contents: string,
    parents: string[],
    message = "Fixture commit\n",
    author?: { name: string; email: string },
  ) =>
    git(
      ["commit-tree", contents, ...parents.flatMap((parent) => ["-p", parent])],
      message,
      repo,
      author
        ? {
            GIT_AUTHOR_NAME: author.name,
            GIT_AUTHOR_EMAIL: author.email,
            GIT_COMMITTER_NAME: author.name,
            GIT_COMMITTER_EMAIL: author.email,
          }
        : undefined,
    );
  return { git, tree, commit };
}

export function createMergeGitFixtureFactory(directory: string, gitEnv: NodeJS.ProcessEnv) {
  const root = realpathSync(directory);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(repo);
  const seed = createFixtureGit(repo, gitEnv);
  seed.git(["init", "-q", "-b", "main"]);
  seed.git(["config", "user.name", "Merge Fixture"]);
  seed.git(["config", "user.email", "fixture@example.invalid"]);
  seed.git(["init", "-q", "--bare", remote]);
  const base = seed.commit(seed.tree("before\n"), []);
  seed.git(["update-ref", "refs/heads/main", base]);
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  let prepared: ReturnType<typeof createSourceFixture> | undefined;

  function createSourceFixture(
    fixtureRoot: string,
    sourceMessage?: string,
    sourceVersions: Array<[string, string?]> = [["after\n"]],
    promisor = false,
    sourceAuthor?: { name: string; email: string },
  ) {
    const fixtureRepo = join(fixtureRoot, "repo");
    const fixtureRemote = join(fixtureRoot, "remote.git");
    cpSync(repo, fixtureRepo, copyOptions);
    cpSync(remote, fixtureRemote, copyOptions);
    const owner = createFixtureGit(fixtureRepo, gitEnv);
    const { git, tree, commit } = owner;
    git(["remote", "add", "origin", fixtureRemote]);
    const sourceCommits: string[] = [];
    let head = base;
    for (const [contents, sibling] of sourceVersions) {
      head = commit(tree(contents, sibling), [head], sourceMessage, sourceAuthor);
      sourceCommits.push(head);
    }
    git(["update-ref", "refs/heads/topic", head]);
    git(["push", "-q", "origin", "main", "topic:refs/pull/123/head", "topic"]);
    if (promisor) {
      git(["--git-dir=" + fixtureRemote, "config", "uploadpack.allowFilter", "true"]);
      renameSync(fixtureRepo, join(fixtureRoot, "seed"));
      git(
        [
          "clone",
          "--no-checkout",
          "--filter=blob:none",
          "--branch=topic",
          `file://${fixtureRemote}`,
          fixtureRepo,
        ],
        undefined,
        fixtureRoot,
      );
      expect(git(["config", "--bool", "remote.origin.promisor"])).toBe("true");
      expect(
        readdirSync(join(fixtureRepo, ".git/objects/pack")).some((name) =>
          name.endsWith(".promisor"),
        ),
      ).toBe(true);
    }
    // Production URLs still use real Git transport inside the private case.
    git(["config", `url.file://${fixtureRemote}.insteadOf`, "https://github.com/fixture/repo"]);
    git([
      "config",
      "--add",
      `url.file://${fixtureRemote}.insteadOf`,
      "https://github.com/fixture/repo.git",
    ]);
    const worktree = join(fixtureRepo, ".worktrees/pr-123");
    git(["worktree", "add", "-q", "-b", "pr-123-prep", worktree, head]);
    writeFileSync(join(fixtureRepo, ".git/info/exclude"), ".local/\n");
    return {
      ...owner,
      repo: fixtureRepo,
      remote: fixtureRemote,
      worktree,
      base,
      head,
      sourceCommits,
    };
  }

  return (
    fixtureRoot: string,
    sourceMessage?: string,
    sourceVersions: Array<[string, string?]> = [["after\n"]],
    promisor = false,
    sourceAuthor?: { name: string; email: string },
  ) => {
    // Attribution, multi-commit and filtered-clone cases still construct their own source history.
    if (
      sourceMessage !== undefined ||
      sourceAuthor !== undefined ||
      promisor ||
      sourceVersions.length !== 1 ||
      sourceVersions[0]?.[0] !== "after\n" ||
      sourceVersions[0]?.[1] !== undefined
    ) {
      return createSourceFixture(
        fixtureRoot,
        sourceMessage,
        sourceVersions,
        promisor,
        sourceAuthor,
      );
    }
    if (!prepared) {
      const preparedRoot = join(root, "prepared");
      mkdirSync(preparedRoot);
      prepared = createSourceFixture(preparedRoot);
    }
    const fixtureRepo = join(fixtureRoot, "repo");
    const fixtureRemote = join(fixtureRoot, "remote.git");
    const worktree = join(fixtureRepo, ".worktrees/pr-123");
    // Copies own refs, index and loose objects: corruption/GC cases must neither
    // read a shared alternate nor mutate the seed or another case's objects.
    cpSync(prepared.repo, fixtureRepo, copyOptions);
    cpSync(prepared.remote, fixtureRemote, copyOptions);
    writeFileSync(
      join(fixtureRepo, ".git/config"),
      readFileSync(join(prepared.repo, ".git/config"), "utf8").replaceAll(
        prepared.remote,
        fixtureRemote,
      ),
    );
    writeFileSync(join(worktree, ".git"), `gitdir: ${fixtureRepo}/.git/worktrees/pr-123\n`);
    writeFileSync(join(fixtureRepo, ".git/worktrees/pr-123/gitdir"), `${worktree}/.git\n`);
    return {
      ...createFixtureGit(fixtureRepo, gitEnv),
      repo: fixtureRepo,
      remote: fixtureRemote,
      worktree,
      base,
      head: prepared.head,
      sourceCommits: [...prepared.sourceCommits],
    };
  };
}
