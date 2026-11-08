import path from "node:path";
import { gitEnvironment } from "../agents/worktrees/git.js";
import { executeGitCommand, requireGitCommandOutput } from "../infra/git-exec.js";
import { statIfExists } from "../infra/path-existence.js";
import type { ProjectRegistryIdentity } from "./project-registry.types.js";

type CloneHistoryOptions = {
  env?: NodeJS.ProcessEnv;
  signal: AbortSignal;
  assertCurrent: () => void;
};

export async function hasShallowProjectHistory(gitDir: string): Promise<boolean> {
  return (await statIfExists(path.join(gitDir, "shallow"))) !== undefined;
}

/** Caller holds the project checkout lifecycle lease; Doctor and preparation share this repair. */
export async function repairProjectCloneHistory(
  repoRoot: string,
  options: CloneHistoryOptions,
): Promise<boolean> {
  requireGitCommandOutput(
    "git fetch --unshallow",
    await executeGitCommand(
      repoRoot,
      [
        "fetch",
        "--unshallow",
        "--filter=blob:none",
        "--no-auto-maintenance",
        "--no-prune",
        "--no-prune-tags",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "origin",
      ],
      {
        env: gitEnvironment({
          ...(options.env ?? process.env),
          GIT_NO_LAZY_FETCH: "1",
          GIT_TERMINAL_PROMPT: "0",
        }),
        timeoutMs: 30 * 60_000,
        maxOutputBytes: 64 * 1024,
        lowerPriority: true,
        killProcessTree: true,
        signal: options.signal,
        beforeRun: options.assertCurrent,
      },
    ),
  );
  options.assertCurrent();
  // A shallow origin can make --unshallow exit zero with incomplete history.
  return !(await hasShallowProjectHistory(path.join(repoRoot, ".git")));
}

export async function ensureProjectCloneHistory(
  project: ProjectRegistryIdentity,
  options: CloneHistoryOptions,
): Promise<void> {
  if (
    project.source !== "cloned" ||
    !(await hasShallowProjectHistory(path.join(project.repoRoot, ".git")))
  ) {
    return;
  }
  try {
    if (await repairProjectCloneHistory(project.repoRoot, options)) {
      return;
    }
  } catch (cause) {
    options.signal.throwIfAborted();
    throw new Error(
      "Managed project history repair failed. Check origin access, network, and disk space, then run openclaw doctor --fix before retrying preparation.",
      { cause },
    );
  }
  throw new Error(
    "Managed project is still shallow. Restore access to a full-history origin and run openclaw doctor --fix before retrying preparation.",
  );
}
