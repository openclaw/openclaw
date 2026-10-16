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
import { parse } from "yaml";

function createFixtureGit(repo: string, gitEnv: NodeJS.ProcessEnv, fixedTreeEntries = "") {
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
    return git(
      ["mktree"],
      `${fixedTreeEntries}100644 blob ${a}\towner.txt\n100644 blob ${b}\tsibling.txt\n`,
    );
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
  // Preserve the real protected publisher inputs in synthetic history so the
  // exact-main owner check remains part of each admission fixture.
  const workflowPath = ".github/workflows/security-review.yml";
  const workflow = readFileSync(new URL(`../../${workflowPath}`, import.meta.url), "utf8");
  const publisher = parse(workflow);
  const checkout = publisher.jobs.review.steps.find(
    (step: { id?: string }) => step.id === "checkout",
  );
  const sources: string[] = [
    workflowPath,
    ...checkout.with["sparse-checkout"]
      .trim()
      .split(/\r?\n/u)
      .map((path: string) => path.trim().replace(/^\//u, "")),
  ];
  type SourceTree = Map<string, string | SourceTree>;
  const sourceTree: SourceTree = new Map();
  for (const path of sources) {
    const parts = path.split("/");
    let parent = sourceTree;
    for (const part of parts.slice(0, -1)) {
      const child = parent.get(part) ?? new Map<string, string | SourceTree>();
      if (typeof child === "string") {
        throw new Error("Publisher source collides with a directory");
      }
      parent.set(part, child);
      parent = child;
    }
    parent.set(
      parts.at(-1)!,
      seed.git(
        ["hash-object", "-w", "--stdin"],
        readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
      ),
    );
  }
  const sourceEntries = (entries: SourceTree): string =>
    [...entries]
      .map(([name, value]) =>
        typeof value === "string"
          ? `100644 blob ${value}\t${name}\n`
          : `040000 tree ${seed.git(["mktree"], sourceEntries(value))}\t${name}\n`,
      )
      .join("");
  const fixedTreeEntries = sourceEntries(sourceTree);
  const baseTree = seed.git(
    ["mktree"],
    `${fixedTreeEntries}${seed.git(["ls-tree", seed.tree("before\n")])}\n`,
  );
  const base = seed.commit(baseTree, []);
  seed.git(["update-ref", "refs/heads/main", base]);
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  const preparedSources = new Map<string, ReturnType<typeof createSourceFixture>>();

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
    const owner = createFixtureGit(fixtureRepo, gitEnv, fixedTreeEntries);
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
    // Attribution and filtered-clone cases still construct their own source history.
    if (sourceMessage !== undefined || sourceAuthor !== undefined || promisor) {
      return createSourceFixture(
        fixtureRoot,
        sourceMessage,
        sourceVersions,
        promisor,
        sourceAuthor,
      );
    }
    const sourceKey = JSON.stringify(sourceVersions);
    let prepared = preparedSources.get(sourceKey);
    if (!prepared) {
      const preparedRoot = join(root, `prepared-${preparedSources.size}`);
      mkdirSync(preparedRoot);
      prepared = createSourceFixture(preparedRoot, undefined, sourceVersions);
      preparedSources.set(sourceKey, prepared);
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
      ...createFixtureGit(fixtureRepo, gitEnv, fixedTreeEntries),
      repo: fixtureRepo,
      remote: fixtureRemote,
      worktree,
      base,
      head: prepared.head,
      sourceCommits: [...prepared.sourceCommits],
    };
  };
}
