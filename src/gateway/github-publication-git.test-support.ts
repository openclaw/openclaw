import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { deleteRegistryWorktree, insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type {
  commandResult as publicationCommandResult,
  githubPublicationTestMocks,
} from "./github-publication.test-support.js";

type PublicationPullRequestFixture = {
  url: string;
  userId: number;
  state: string;
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
};

export function publicationPullRequestResponse(pr: PublicationPullRequestFixture) {
  return {
    html_url: pr.url,
    number: Number(pr.url.split("/").at(-1)),
    user: { id: pr.userId },
    state: pr.state,
    body: pr.body,
    head: { ref: pr.headRef, sha: pr.headSha, repo: { full_name: "openclaw/openclaw" } },
    base: { ref: pr.baseRef, repo: { full_name: "openclaw/openclaw" } },
  };
}

export async function readPublicationCommit(
  git: (...args: string[]) => Promise<string>,
  commit: string,
) {
  const [sha, tree, parents, ...message] = (
    await git("show", "-s", "--no-show-signature", "--format=%H%n%T%n%P%n%B", commit)
  ).split("\n");
  return {
    sha,
    tree: { sha: tree },
    parents: parents!
      .split(" ")
      .filter(Boolean)
      .map((parent) => ({ sha: parent })),
    message: message.join("\n"),
  };
}

/** Synthetic Git/GitHub transport for coordinator tests; real-Git fixtures wrap it below. */
export function createSyntheticPublicationTransport(params: {
  root: string;
  syntheticIndex: string;
  branch: string;
  oldHead: string;
  newHead: string;
  workspaceTree: string;
  baseHead: string;
  commands: string[][];
  commandCalls: Array<{ argv: string[]; input?: string }>;
  commandResult: typeof publicationCommandResult;
}) {
  const {
    root,
    syntheticIndex,
    branch,
    oldHead,
    newHead,
    workspaceTree,
    baseHead,
    commands,
    commandCalls,
    commandResult,
  } = params;
  const replies: Record<string, [string?, number?]> = {
    "git symbolic-ref --quiet --short HEAD": [`${branch}\n`],
    [`git symbolic-ref --quiet refs/heads/${branch}`]: ["", 1],
    "git rev-parse --verify --quiet MERGE_HEAD": ["", 1],
    "git rev-parse --verify HEAD^{commit}": [`${oldHead}\n`],
    "git show -s --no-show-signature --format=%H%n%T%n%P%n%B HEAD": [
      `${oldHead}\n${workspaceTree}\n${oldHead}\nexisting commit\n`,
    ],
    "git config --local --includes --bool --get extensions.worktreeConfig": ["", 1],
    "git rev-parse --git-path info/attributes": [path.join(root, "missing-info-attributes")],
    "git rev-parse --git-path info/grafts": [path.join(root, "missing-grafts")],
    "git var GIT_ATTR_GLOBAL": [path.join(root, "missing-global-attributes")],
    "git var GIT_ATTR_SYSTEM": [path.join(root, "missing-global-attributes")],
    [`git rev-parse ${baseHead}^{tree}`]: ["e".repeat(40) + "\n"],
    "git rev-parse --verify --end-of-options origin/main^{commit}": [`${baseHead}\n`],
  };
  let remotePublished = false;
  let publicationMessage = "";
  const pullRequest = {
    html_url: "https://github.com/openclaw/openclaw/pull/125200",
    number: 125200,
    user: { id: 42 },
    state: "open",
    body: "",
    head: { ref: branch, sha: newHead, repo: { full_name: "openclaw/openclaw" } },
    base: { ref: "main", repo: { full_name: "openclaw/openclaw" } },
  };
  return async (argv: string[], options?: { input?: string }) => {
    commands.push(argv);
    commandCalls.push({ argv, input: options?.input });
    const command = argv.join(" ");
    if (replies[command]) {
      return commandResult(...replies[command]);
    }

    if (
      command.startsWith(
        "gh api --hostname github.com repos/openclaw/openclaw --jq {fork, default_branch, parent:",
      )
    ) {
      return commandResult('{"fork":false,"default_branch":"main"}\n');
    }
    const baseRefPrefix = "gh api --hostname github.com repos/openclaw/openclaw/git/ref/heads/";
    if (command.startsWith(baseRefPrefix)) {
      const selectedBranch = command.slice(baseRefPrefix.length).split(" --jq", 1)[0];
      return commandResult(JSON.stringify({ ref: `refs/heads/${selectedBranch}`, sha: baseHead }));
    }

    if (
      (argv.includes("--includes") && argv.includes("--get-regexp")) ||
      (argv[0] === "git" &&
        argv[1] === "config" &&
        (argv.includes("--global") || argv.includes("--system")) &&
        argv.includes("core.attributesFile"))
    ) {
      return commandResult("", 1);
    }
    if (command.startsWith("git ls-tree -r -z --full-tree ")) {
      return commandResult();
    }
    if (argv.includes("rev-parse") && argv.includes("--git-path") && argv.at(-1) === "index") {
      return commandResult(syntheticIndex);
    }
    if (command.endsWith("write-tree")) {
      return commandResult(`${workspaceTree}\n`);
    }
    if (command.startsWith("git commit-tree ")) {
      publicationMessage = options?.input ?? "";
      return commandResult(`${newHead}\n`);
    }

    if (
      command.startsWith(
        "git -c credential.helper= -c credential.helper=!gh auth git-credential ls-remote",
      )
    ) {
      return commandResult(remotePublished ? `${newHead}\trefs/heads/${branch}\n` : "");
    }
    if (argv.includes("push")) {
      remotePublished = true;
      return commandResult();
    }
    if (command.includes(" repos/openclaw/openclaw/pulls ") && command.includes("state=all")) {
      return commandResult("[]\n");
    }
    if (argv.includes("GET") && argv.includes("repos/openclaw/openclaw/pulls/125200")) {
      return commandResult(JSON.stringify(pullRequest));
    }
    if (argv.includes(`repos/openclaw/openclaw/git/commits/${newHead}`)) {
      return commandResult(
        JSON.stringify({
          sha: newHead,
          tree: { sha: workspaceTree },
          parents: [{ sha: oldHead }],
          message: publicationMessage,
        }),
      );
    }
    if (
      command ===
      "gh api --hostname github.com --method POST repos/openclaw/openclaw/pulls --input -"
    ) {
      pullRequest.body = JSON.parse(options!.input!).body;
      return commandResult(JSON.stringify(pullRequest));
    }
    return commandResult();
  };
}

/** Real local Git/index with synthetic remote effects; no credential helper reaches a subprocess. */
export async function createRealPublicationWorkspace(params: {
  root: string;
  branch: string;
  sessionKey: string;
  realWorktree: boolean;
  mocks: ReturnType<typeof githubPublicationTestMocks>;
  commandResult: typeof publicationCommandResult;
  interruptAt?: "push" | "observe" | "index" | "create";
}) {
  const { root, branch, sessionKey, realWorktree, mocks, commandResult, interruptAt } = params;
  const json = (value: unknown) => commandResult(JSON.stringify(value));
  const { runCommandBuffered } =
    await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  const { updateGitHubPublicationBranchAndIndex } = await vi.importActual<
    typeof import("./github-publication-git-index.js")
  >("./github-publication-git-index.js");
  const cwd = path.join(root, "repository");
  const home = path.join(root, "git-home");
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  const isolatedEnv = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GH_TOKEN: undefined,
    GITHUB_TOKEN: undefined,
    GH_CONFIG_DIR: undefined,
  };
  type CommandOptions = { cwd?: string; env?: NodeJS.ProcessEnv; input?: string };
  const local = async (argv: string[], options?: CommandOptions) =>
    await runCommandBuffered(argv, {
      cwd,
      ...options,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Publication Test",
        GIT_AUTHOR_EMAIL: "publication@example.test",
        GIT_COMMITTER_NAME: "Publication Test",
        GIT_COMMITTER_EMAIL: "publication@example.test",
        ...options?.env,
        ...isolatedEnv,
      },
      timeoutMs: 10000,
      maxOutputBytes: 256 * 1024,
    });
  const git = async (...args: string[]) => {
    const result = await local(["git", ...args]);
    if (result.code !== 0) {
      throw new Error(result.stderr.toString("utf8"));
    }
    return result.stdout.toString("utf8").trim();
  };
  await git("init", "--initial-branch=main");
  await fs.writeFile(path.join(cwd, "artifact.txt"), "base\n");
  await git("add", "artifact.txt");
  await git("commit", "-m", "base");
  const baseHead = await git("rev-parse", "HEAD");
  await git("checkout", "-b", branch);
  await fs.writeFile(path.join(cwd, "artifact.txt"), "staged\n");
  await git("add", "artifact.txt");
  await fs.writeFile(path.join(cwd, "artifact.txt"), "accepted\n");
  const worktree = { ...mocks.findWorktree("session", sessionKey), path: cwd, repoRoot: cwd };
  mocks.findWorktree.mockReturnValue(worktree);
  mocks.findWorktreeById.mockReturnValue(worktree);
  const loaded = mocks.loadSession(sessionKey);
  const entry = {
    ...loaded.entry,
    worktree: { ...loaded.entry.worktree, id: worktree.id, repoRoot: cwd },
  };
  if (!realWorktree) {
    await deleteRegistryWorktree(process.env, worktree.id);
  }
  await insertRegistryWorktree(process.env, {
    ...worktree,
    name: "publication",
    createdAt: Date.now(),
    lastActiveAt: Date.now(),
  });
  await upsertSessionEntryCore(
    { agentId: "main", sessionKey },
    { ...entry, updatedAt: Date.now() },
  );
  if (!realWorktree) {
    mocks.loadSession.mockReturnValue({ ...loaded, entry });
  }
  mocks.resolveRepository.mockResolvedValue({
    checkoutRoot: cwd,
    repoRoot: cwd,
    fingerprint: worktree.repoFingerprint,
    originUrl: "git@github.com:openclaw/openclaw.git",
  });
  mocks.updateIndex.mockImplementation(updateGitHubPublicationBranchAndIndex);
  const remote = mocks.runCommand.getMockImplementation()!;
  let interrupted = false;
  let remoteHead = "";
  let remoteBranch = branch;
  let publishedPullRequest: PublicationPullRequestFixture | undefined;
  const remoteCommits = new Set([baseHead]);
  const effects: string[] = [];
  function interrupt(at: typeof interruptAt, message: string, ready = true) {
    if (!interrupted && interruptAt === at && ready) {
      interrupted = true;
      throw new Error(message);
    }
  }
  mocks.runCommand.mockImplementation(async (argv: string[], options?: CommandOptions) => {
    if (argv[0] === "gh") {
      const pr = publishedPullRequest;
      if (
        pr &&
        argv.includes("GET") &&
        argv.some((arg) => arg === `repos/openclaw/openclaw/pulls/${pr.url.split("/").at(-1)}`)
      ) {
        return json(
          publicationPullRequestResponse({
            ...pr,
            headSha: remoteHead,
            headRef: remoteBranch,
          }),
        );
      }
      const commitPath = "repos/openclaw/openclaw/git/commits/";
      const commit = argv.find((arg) => arg.startsWith(commitPath))?.slice(commitPath.length);
      if (commit) {
        if (!remoteCommits.has(commit)) {
          return commandResult("", 1);
        }
        return json(await readPublicationCommit(git, commit));
      }
      if (argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))) {
        return json({ ref: "refs/heads/main", sha: baseHead });
      }
      if (argv.includes("POST")) {
        effects.push("pull_request");
        interrupt("create", "synthetic PR response lost");
        const response = await remote(argv, options);
        if (argv.some((arg) => arg.endsWith("/pulls")) && response.code === 0) {
          const input = JSON.parse(options!.input!);
          publishedPullRequest = {
            url: JSON.parse(response.stdout.toString()).html_url,
            userId: 42,
            state: "open",
            body: input.body,
            headSha: remoteHead,
            headRef: remoteBranch,
            baseRef: input.base,
          };
        }
        return response;
      }
      return await remote(argv, options);
    }
    if (argv.includes("fetch")) {
      return commandResult();
    }
    if (argv.includes("push")) {
      effects.push("push");
      const refspec = argv.find((arg) => /^[a-f0-9]+:refs\/heads\//u.test(arg));
      if (!refspec) {
        throw new Error("Publication fixture expected an exact commit push.");
      }
      [remoteHead, remoteBranch] = refspec.split(":refs/heads/") as [string, string];
      remoteCommits.add(remoteHead);
      interrupt("push", "synthetic push response lost");
      return commandResult();
    }
    if (argv.includes("ls-remote")) {
      interrupt("observe", "synthetic remote observation unavailable", Boolean(remoteHead));
      return commandResult(remoteHead ? `${remoteHead}\trefs/heads/${remoteBranch}\n` : "");
    }
    const result = await local(argv, options);
    interrupt("index", "synthetic ref update response lost", argv.includes("update-ref"));
    return result;
  });
  return { cwd, git, effects };
}
