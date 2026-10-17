import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectPathPermissions } from "@openclaw/fs-safe/permissions";
import type { WorkerHeartbeatResult } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { CLEARED_GITHUB_CREDENTIALS } from "../agents/github-host-runtime.js";
import {
  AGENT_GIT_CONFIG_PARAMETERS,
  managedGitHubIdentityEnvironment,
} from "../agents/github-tool-identity-env.js";
import {
  removeManagedGitHubProfile,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { isMissingPathError } from "../infra/errno.js";
import { executeGitCommand } from "../infra/git-exec.js";
import { isPathCaseInsensitive } from "../infra/path-case.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  parseWorkerGitHubLaunchBinding,
  type WorkerGitHubLaunchBinding,
} from "./launch-descriptor.js";

const log = createSubsystemLogger("worker/github");

export function disposeWorkerGitHubEnvironment(stateDir: string, turnId: string) {
  return removeManagedGitHubProfile(
    path.join(stateDir, "github-profiles", sha256HexPrefixCore(turnId, 16)),
  );
}

async function bindWorkerGitHubCheckout(
  cwd: string,
  binding: WorkerGitHubLaunchBinding,
  baseEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  const runGit = (args: string[], timeoutMs: number, honorSignal: boolean) =>
    executeGitCommand(cwd, args, {
      baseEnv,
      timeoutMs,
      maxOutputBytes: { stdout: 1_048_576, stderr: 2_048 },
      ...(honorSignal && signal ? { signal } : {}),
    });
  const git = (args: string[], timeoutMs = 5_000) => runGit(args, timeoutMs, true);
  const requireGitWith = async (args: string[], honorSignal: boolean) => {
    const result = await runGit(args, 5_000, honorSignal);
    if (result.code !== 0 || result.stdoutTruncatedBytes) {
      throw new Error(`git ${args[0]} failed or output was truncated (exit ${result.code})`);
    }
    return result.stdout;
  };
  const requireGit = (args: string[]) => requireGitWith(args, true);
  // The move below advances HEAD before it materializes the replacements, so a turn fenced
  // partway through would leave the workspace half applied and the next turn returns early
  // because the local head already equals the remote head. Once the move starts, this bounded
  // local work completes instead of honoring the abort.
  const requireMoveGit = (args: string[]) => requireGitWith(args, false);
  try {
    if ((await git(["rev-parse", "--git-dir"])).code !== 0) {
      return;
    }
    if (binding.remoteUrl) {
      const origin = await git(["remote", "get-url", "origin"]);
      if (origin.code !== 0) {
        await requireGit(["remote", "add", "origin", binding.remoteUrl]);
      } else if (origin.stdout.trim() !== binding.remoteUrl) {
        await requireGit(["remote", "set-url", "origin", binding.remoteUrl]);
      }
    }
    const head = await git(["symbolic-ref", "--quiet", "HEAD"]);
    const branch = `refs/heads/${binding.branch}`;
    if (head.code !== 0 || head.stdout.trim() !== branch) {
      await requireGit(["update-ref", branch, "HEAD"]);
      await requireGit(["symbolic-ref", "HEAD", branch]);
    }
    // Reconciliation returns files, not commits. Fetch only the admitted origin;
    // fast-forward session commits without overwriting reconciled working bytes.
    if (!binding.remoteUrl || signal?.aborted) {
      return;
    }
    const fetched = await git(["fetch", "--quiet", "origin", binding.branch], 60_000);
    if (fetched.code !== 0) {
      const remoteBranch = await git(["ls-remote", "--exit-code", "--heads", "origin", branch]);
      if (remoteBranch.code === 2) {
        return;
      }
      throw new Error(`git fetch failed (exit ${fetched.code})`);
    }
    await requireGit(["update-ref", `refs/remotes/origin/${binding.branch}`, "FETCH_HEAD"]);
    // A tracked upstream lets a bare `git push` and `git status -sb` work on a fresh checkout.
    await requireGit(["branch", `--set-upstream-to=origin/${binding.branch}`, binding.branch]);
    const local = (await requireGit(["rev-parse", "HEAD"])).trim();
    const remote = (await requireGit(["rev-parse", "FETCH_HEAD"])).trim();
    if (local === remote) {
      return;
    }
    if ((await git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"])).code !== 0) {
      log.warn(
        `GitHub checkout fast-forward skipped: ${binding.branch} HEAD=${local.slice(0, 7)} origin=${remote.slice(0, 7)}`,
      );
      return;
    }
    if (signal?.aborted) {
      return;
    }
    const splitPaths = (stdout: string) => stdout.split("\0").filter(Boolean);
    const listPaths = async (args: string[]) => splitPaths(await requireGit(args));
    const listMovePaths = async (args: string[]) => splitPaths(await requireMoveGit(args));
    const added = await listPaths([
      "diff",
      "--name-only",
      "--diff-filter=A",
      "--no-renames",
      "-z",
      "HEAD",
      "FETCH_HEAD",
      "--",
    ]);
    const caseInsensitive = isPathCaseInsensitive(cwd);
    const localEntriesByDirectory = new Map<
      string,
      Promise<Map<string, { name: string; isDirectory: boolean }>>
    >();
    const findLocalEntry = async (directory: string, name: string) => {
      try {
        const stats = await fs.lstat(path.join(directory, name));
        return { name, isDirectory: stats.isDirectory() };
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
        if (!caseInsensitive) {
          return undefined;
        }
      }
      let entries = localEntriesByDirectory.get(directory);
      if (!entries) {
        entries = fs
          .readdir(directory, { withFileTypes: true })
          .then(
            (items) =>
              new Map(
                items.map((item) => [
                  item.name.toLowerCase(),
                  { name: item.name, isDirectory: item.isDirectory() },
                ]),
              ),
          );
        localEntriesByDirectory.set(directory, entries);
      }
      return (await entries).get(name.toLowerCase());
    };
    const removableTrackedCollisions = new Set<string>();
    let hasPathPrefixCollision = false;
    // Inspect only incoming path components; unrelated workspace inventories can exceed output caps.
    for (const addedPath of added) {
      const segments = addedPath.split("/");
      let directory = cwd;
      let collisionPath: string | undefined;
      for (const [index, segment] of segments.entries()) {
        const entry = await findLocalEntry(directory, segment);
        if (!entry) {
          break;
        }
        const isExactPath = index === segments.length - 1;
        if (!entry.isDirectory) {
          if (!isExactPath) {
            collisionPath = path.relative(cwd, path.join(directory, entry.name));
          }
          break;
        }
        if (isExactPath) {
          collisionPath = path.relative(cwd, path.join(directory, entry.name));
          break;
        }
        directory = path.join(directory, entry.name);
      }
      if (!collisionPath) {
        continue;
      }
      const gitPath = collisionPath.split(path.sep).join("/");
      const status = await requireGit([
        "--literal-pathspecs",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignored=matching",
        "--ignore-submodules=none",
        "--",
        gitPath,
      ]);
      // `-v` tags assume-unchanged (`h`) and skip-worktree (`S`, or `s` when both are set)
      // entries, whose worktree edits status deliberately hides; only a plain cached entry
      // proves the local bytes are reproducible from the index.
      const tracked = await listPaths([
        "--literal-pathspecs",
        "ls-files",
        "-v",
        "--stage",
        "-z",
        "--",
        gitPath,
      ]);
      const isCleanTracked =
        status.length === 0 &&
        tracked.length > 0 &&
        tracked.every((entry) => entry.startsWith("H ") && !entry.startsWith("H 160000 "));
      if (!isCleanTracked) {
        hasPathPrefixCollision = true;
        break;
      }
      // Git never reports `.git` entries, so an empty status cannot prove that a tracked
      // directory holds no nested repository; deleting one would discard its own history.
      const trackedDirectories = new Set([gitPath]);
      for (const entry of tracked) {
        const trackedPath = entry.slice(entry.indexOf("\t") + 1);
        let separator = trackedPath.lastIndexOf("/");
        while (separator > 0) {
          trackedDirectories.add(trackedPath.slice(0, separator));
          separator = trackedPath.lastIndexOf("/", separator - 1);
        }
      }
      let holdsNestedRepository = false;
      for (const trackedDirectory of trackedDirectories) {
        try {
          await fs.lstat(path.join(cwd, trackedDirectory, ".git"));
          holdsNestedRepository = true;
          break;
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
        }
      }
      if (holdsNestedRepository) {
        hasPathPrefixCollision = true;
        break;
      }
      removableTrackedCollisions.add(collisionPath);
    }
    if (hasPathPrefixCollision) {
      log.warn(`GitHub checkout fast-forward skipped: local path conflicts with ${binding.branch}`);
      return;
    }
    // Paths already missing before the move are the session's own deletions and stay
    // deleted; only files the incoming commits introduce are materialized.
    const deletedBefore = new Set(await listPaths(["ls-files", "--deleted", "-z"]));
    await requireMoveGit(["reset", "--mixed", "FETCH_HEAD"]);
    for (const collisionPath of removableTrackedCollisions) {
      await fs.rm(path.join(cwd, collisionPath), { recursive: true });
    }
    const missing = (await listMovePaths(["ls-files", "--deleted", "-z"])).filter(
      (file) => !deletedBefore.has(file),
    );
    if (missing.length > 0) {
      await requireMoveGit(["--literal-pathspecs", "checkout", "--", ...missing]);
    }
  } catch (error) {
    // Checkout metadata helps direct publication; a failure must not discard the coding turn.
    log.warn(`GitHub checkout binding failed: ${String(error).slice(0, 2_048)}`);
  }
}

export async function prepareWorkerGitHubEnvironment(params: {
  binding: WorkerGitHubLaunchBinding;
  stateDir: string;
  turnId: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<
  | (PreparedGitHubToolEnvironment & {
      refresh: (
        snapshot: NonNullable<WorkerHeartbeatResult["github"]>,
        assertCurrent: () => void,
      ) => Promise<void>;
    })
  | undefined
> {
  const { binding, stateDir, turnId, cwd, signal } = params;
  signal?.throwIfAborted();
  registerSecretValueForRedaction(binding.token);
  const profileDir = path.join(stateDir, "github-profiles", sha256HexPrefixCore(turnId, 16));
  try {
    // Each turn owns its path; retained commands keep their existing credentials.
    await removeManagedGitHubProfile(profileDir);
    await writeManagedGitHubProfileFiles(profileDir, binding, {
      assertCurrent: () => signal?.throwIfAborted(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Worker GitHub identity profile could not be written: ${message}`, {
      cause: error,
    });
  }
  const localIdentityEnv = managedGitHubIdentityEnvironment({
    profileDir,
    gitAuthor: binding.gitAuthor,
    // Reset inherited helpers so paired-device credentials cannot override the turn identity.
    gitConfig: [
      ["credential.helper", ""],
      ["credential.helper", "!gh auth git-credential"],
    ],
  });
  if (os.platform() === "win32") {
    const permissions = await inspectPathPermissions(profileDir);
    if (
      !permissions.ok ||
      permissions.source !== "windows-acl" ||
      permissions.ownerTrusted !== true ||
      permissions.groupReadable ||
      permissions.worldReadable ||
      permissions.groupWritable ||
      permissions.worldWritable
    ) {
      log.warn(`GitHub binding skipped: profile is not owner-only: ${profileDir}`);
      return undefined;
    }
  }
  await bindWorkerGitHubCheckout(
    cwd,
    binding,
    {
      ...process.env,
      ...localIdentityEnv,
      ...CLEARED_GITHUB_CREDENTIALS,
    },
    signal,
  );
  return {
    refresh: async (snapshot, assertCurrent) => {
      const assertActive = () => {
        assertCurrent();
        signal?.throwIfAborted();
      };
      assertActive();
      const replacement = parseWorkerGitHubLaunchBinding({ ...binding, token: snapshot.token });
      if (
        !replacement ||
        (snapshot.expiresAtMs !== undefined && snapshot.expiresAtMs <= Date.now())
      ) {
        throw new Error("Worker GitHub refresh is invalid or expired");
      }
      registerSecretValueForRedaction(replacement.token);
      await writeManagedGitHubProfileFiles(profileDir, replacement, {
        assertCurrent: assertActive,
      });
      assertActive();
    },
    managedLocalIdentity: true,
    excludedStoreNames: [],
    credentialScrubEnv: { ...CLEARED_GITHUB_CREDENTIALS },
    localIdentityEnv,
    localGitConfigParameters: AGENT_GIT_CONFIG_PARAMETERS,
  };
}
