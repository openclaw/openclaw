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

const fixturePaths = (root: string) => ({
  repo: join(root, "repo"),
  remote: join(root, "remote.git"),
  worktree: join(root, "repo/.worktrees/pr-123"),
});
type SourceArgs = [
  root: string,
  message?: string,
  versions?: Array<[string, string?]>,
  promisor?: boolean,
  author?: { name: string; email: string },
];

export function createFixtureGit(repo: string, gitEnv: NodeJS.ProcessEnv, fixedTreeEntries = "") {
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
    signed = false,
  ) =>
    git(
      [
        "commit-tree",
        ...(signed ? ["-S"] : []),
        contents,
        ...parents.flatMap((parent) => ["-p", parent]),
      ],
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
  const { repo, remote } = fixturePaths(root);
  mkdirSync(repo);
  const seed = createFixtureGit(repo, gitEnv);
  seed.git(["init", "-q", "-b", "main"]);
  seed.git(["config", "user.name", "Merge Fixture"]);
  seed.git(["config", "user.email", "fixture@example.invalid"]);
  seed.git(["init", "-q", "--bare", remote]);
  // Copied fixture trees must stay quiescent after each joined Git command.
  for (const repository of [repo, remote]) {
    seed.git(["config", "maintenance.auto", "false"], undefined, repository);
    seed.git(["config", "gc.auto", "0"], undefined, repository);
  }
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
  // Let Git build nested trees without touching the seed's checkout index.
  const indexEnv = { GIT_INDEX_FILE: join(root, "publisher.index") };
  const entries = sources
    .map((path) => {
      const blob = seed.git(
        ["hash-object", "-w", "--stdin"],
        readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"),
      );
      return `100644 ${blob}\t${path}\n`;
    })
    .join("");
  seed.git(["update-index", "--index-info"], entries, repo, indexEnv);
  const publisherTree = seed.git(["write-tree"], undefined, repo, indexEnv);
  const fixedTreeEntries = `${seed.git(["ls-tree", publisherTree])}\n`;
  const baseTree = seed.git(
    ["mktree"],
    `${fixedTreeEntries}${seed.git(["ls-tree", seed.tree("before\n")])}\n`,
  );
  const base = seed.commit(baseTree, []);
  seed.git(["update-ref", "refs/heads/main", base]);
  const copyOptions = { recursive: true, mode: fsConstants.COPYFILE_FICLONE };
  const preparedSources = new Map<string, ReturnType<typeof createSourceFixture>>();

  function createSourceFixture(
    ...[
      fixtureRoot,
      sourceMessage,
      sourceVersions = [["after\n"]],
      promisor = false,
      sourceAuthor,
    ]: SourceArgs
  ) {
    const paths = fixturePaths(fixtureRoot);
    cpSync(repo, paths.repo, copyOptions);
    cpSync(remote, paths.remote, copyOptions);
    const owner = createFixtureGit(paths.repo, gitEnv, fixedTreeEntries);
    const { git, tree, commit } = owner;
    git(["remote", "add", "origin", paths.remote]);
    const sourceCommits: string[] = [];
    let head = base;
    for (const [contents, sibling] of sourceVersions) {
      head = commit(tree(contents, sibling), [head], sourceMessage, sourceAuthor);
      sourceCommits.push(head);
    }
    git(["update-ref", "refs/heads/topic", head]);
    git(["push", "-q", "origin", "main", "topic:refs/pull/123/head", "topic"]);
    if (promisor) {
      git(["--git-dir=" + paths.remote, "config", "uploadpack.allowFilter", "true"]);
      renameSync(paths.repo, join(fixtureRoot, "seed"));
      git(
        [
          "clone",
          "--config=maintenance.auto=false",
          "--config=gc.auto=0",
          "--no-checkout",
          "--filter=blob:none",
          "--branch=topic",
          `file://${paths.remote}`,
          paths.repo,
        ],
        undefined,
        fixtureRoot,
      );
      expect(git(["config", "--bool", "remote.origin.promisor"])).toBe("true");
      expect(
        readdirSync(join(paths.repo, ".git/objects/pack")).some((name) =>
          name.endsWith(".promisor"),
        ),
      ).toBe(true);
    }
    // Production URLs still use real Git transport inside the private case.
    for (const suffix of ["", ".git"]) {
      git([
        "config",
        "--add",
        `url.file://${paths.remote}.insteadOf`,
        `https://github.com/fixture/repo${suffix}`,
      ]);
    }
    git(["worktree", "add", "-q", "-b", "pr-123-prep", paths.worktree, head]);
    writeFileSync(join(paths.repo, ".git/info/exclude"), ".local/\n");
    return { ...owner, ...paths, base, head, sourceCommits };
  }

  return (...args: SourceArgs) => {
    const [
      fixtureRoot,
      sourceMessage,
      sourceVersions = [["after\n"]],
      promisor = false,
      sourceAuthor,
    ] = args;
    // Attribution and filtered-clone cases still construct their own source history.
    if (sourceMessage !== undefined || sourceAuthor !== undefined || promisor) {
      return createSourceFixture(...args);
    }
    const sourceKey = JSON.stringify(sourceVersions);
    let prepared = preparedSources.get(sourceKey);
    if (!prepared) {
      const preparedRoot = join(root, `prepared-${preparedSources.size}`);
      mkdirSync(preparedRoot);
      prepared = createSourceFixture(preparedRoot, undefined, sourceVersions);
      preparedSources.set(sourceKey, prepared);
    }
    const paths = fixturePaths(fixtureRoot);
    // Copies own refs, index and loose objects: corruption/GC cases must neither
    // read a shared alternate nor mutate the seed or another case's objects.
    cpSync(prepared.repo, paths.repo, copyOptions);
    cpSync(prepared.remote, paths.remote, copyOptions);
    writeFileSync(
      join(paths.repo, ".git/config"),
      readFileSync(join(prepared.repo, ".git/config"), "utf8").replaceAll(
        prepared.remote,
        paths.remote,
      ),
    );
    writeFileSync(join(paths.worktree, ".git"), `gitdir: ${paths.repo}/.git/worktrees/pr-123\n`);
    writeFileSync(join(paths.repo, ".git/worktrees/pr-123/gitdir"), `${paths.worktree}/.git\n`);
    return {
      ...createFixtureGit(paths.repo, gitEnv, fixedTreeEntries),
      ...paths,
      base,
      head: prepared.head,
      sourceCommits: [...prepared.sourceCommits],
    };
  };
}
