import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { insertRegistryWorktree } from "../agents/worktrees/registry.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type {
  commandResult as publicationCommandResult,
  githubPublicationTestMocks,
} from "./github-publication.test-support.js";

/** Real local Git/index with synthetic remote effects; no credential helper reaches a subprocess. */
export async function createRealPublicationWorkspace({
  root,
  branch,
  sessionKey,
  realWorktree,
  mocks,
  commandResult,
  interruptAt,
}: {
  root: string;
  branch: string;
  sessionKey: string;
  realWorktree: boolean;
  mocks: ReturnType<typeof githubPublicationTestMocks>;
  commandResult: typeof publicationCommandResult;
  interruptAt?: "push" | "observe" | "index" | "create";
}) {
  const { runCommandBuffered } =
    await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
  const { updateGitHubPublicationBranchAndIndex } = await vi.importActual<
    typeof import("./github-publication-git-index.js")
  >("./github-publication-git-index.js");
  const cwd = path.join(root, "repository");
  const home = path.join(root, "git-home");
  await fs.mkdir(cwd);
  await fs.mkdir(home);
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: "Publication Test",
    GIT_AUTHOR_EMAIL: "publication@example.test",
    GIT_COMMITTER_NAME: "Publication Test",
    GIT_COMMITTER_EMAIL: "publication@example.test",
  };
  const local = async (
    argv: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
  ) =>
    await runCommandBuffered(argv, {
      cwd,
      ...options,
      env: {
        ...env,
        ...options?.env,
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_GLOBAL: os.devNull,
        GIT_CONFIG_SYSTEM: os.devNull,
        GIT_DIR: undefined,
        GIT_WORK_TREE: undefined,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        GH_CONFIG_DIR: undefined,
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
  const entry = { ...loaded.entry, worktree: { ...loaded.entry.worktree, repoRoot: cwd } };
  if (realWorktree) {
    insertRegistryWorktree(process.env, {
      ...worktree,
      name: "publication",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { ...entry, updatedAt: Date.now() },
    );
  } else {
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
  const remoteCommits = new Set([baseHead]);
  const effects: string[] = [];
  mocks.runCommand.mockImplementation(
    async (argv: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }) => {
      if (argv[0] === "gh") {
        const commitPath = "repos/openclaw/openclaw/git/commits/";
        const commit = argv.find((arg) => arg.startsWith(commitPath))?.slice(commitPath.length);
        if (commit) {
          if (!remoteCommits.has(commit)) {
            return commandResult("", 1);
          }
          const [tree, parents, message] = await Promise.all([
            git("rev-parse", commit + "^{tree}"),
            git("show", "-s", "--format=%P", commit),
            git("show", "-s", "--format=%B", commit),
          ]);
          return commandResult(
            JSON.stringify({
              sha: commit,
              tree: { sha: tree },
              parents: parents
                .split(" ")
                .filter(Boolean)
                .map((sha) => ({ sha })),
              message,
            }),
          );
        }
        if (argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: baseHead }));
        }
        if (argv.includes("POST")) {
          effects.push("pull_request");
          if (!interrupted && interruptAt === "create") {
            interrupted = true;
            throw new Error("synthetic PR response lost");
          }
        }
        return await remote(argv, options);
      }
      if (argv.includes("fetch")) {
        return commandResult();
      }
      if (argv.includes("push")) {
        effects.push("push");
        remoteHead = await git("rev-parse", "HEAD");
        remoteCommits.add(remoteHead);
        if (!interrupted && interruptAt === "push") {
          interrupted = true;
          throw new Error("synthetic push response lost");
        }
        return commandResult();
      }
      if (argv.includes("ls-remote")) {
        if (!interrupted && interruptAt === "observe" && remoteHead) {
          interrupted = true;
          throw new Error("synthetic remote observation unavailable");
        }
        return commandResult(remoteHead ? `${remoteHead}\trefs/heads/${branch}\n` : "");
      }
      const result = await local(argv, options);
      if (!interrupted && interruptAt === "index" && argv.includes("update-ref")) {
        interrupted = true;
        throw new Error("synthetic ref update response lost");
      }
      return result;
    },
  );
  return { cwd, git, effects };
}
