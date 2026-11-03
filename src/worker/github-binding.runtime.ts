import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectPathPermissions } from "@openclaw/fs-safe/permissions";
import type { WorkerHeartbeatResult } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { CLEARED_GITHUB_CREDENTIALS } from "../agents/github-host-runtime.js";
import { managedGitHubIdentityEnvironment } from "../agents/github-tool-identity-env.js";
import {
  removeManagedGitHubProfile,
  writeManagedGitHubProfileFiles,
} from "../agents/github-tool-identity.js";
import type { PreparedGitHubToolEnvironment } from "../agents/github-tool-identity.types.js";
import { sha256HexPrefixCore } from "../infra/crypto-digest.js";
import { isMissingPathError } from "../infra/errno.js";
import { executeGitCommand } from "../infra/git-exec.js";
import { AGENT_GIT_CONFIG_PARAMETERS } from "../infra/git-maintenance-env.js";
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
  const git = (args: string[], timeoutMs = 5_000) =>
    executeGitCommand(cwd, args, {
      baseEnv,
      timeoutMs,
      maxOutputBytes: { stdout: 1_048_576, stderr: 2_048 },
      ...(signal ? { signal } : {}),
    });
  const requireGit = async (args: string[]) => {
    const result = await git(args);
    if (result.code !== 0 || result.stdoutTruncatedBytes) {
      throw new Error(`git ${args[0]} failed or output was truncated (exit ${result.code})`);
    }
    return result.stdout;
  };
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
      if (fetched.stderr.includes("couldn't find remote ref")) {
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
    const added = (
      await requireGit([
        "diff",
        "--name-only",
        "--diff-filter=A",
        "--no-renames",
        "-z",
        "HEAD",
        "FETCH_HEAD",
        "--",
      ])
    )
      .split("\0")
      .filter(Boolean);
    let hasPathPrefixCollision = false;
    // Native path lookup also recognizes the filesystem's case and Unicode aliases.
    // Inspect only incoming components, not unrelated or ignored workspace files.
    for (const addedPath of added) {
      const segments = addedPath.split("/");
      let localPath = cwd;
      for (const [index, segment] of segments.entries()) {
        localPath = path.join(localPath, segment);
        try {
          const stats = await fs.lstat(localPath);
          const isExactPath = index === segments.length - 1;
          if (isExactPath ? stats.isDirectory() : !stats.isDirectory()) {
            hasPathPrefixCollision = true;
            break;
          }
        } catch (error) {
          if (!isMissingPathError(error)) {
            throw error;
          }
          break;
        }
      }
      if (hasPathPrefixCollision) {
        break;
      }
    }
    if (hasPathPrefixCollision) {
      log.warn(`GitHub checkout fast-forward skipped: local path conflicts with ${binding.branch}`);
      return;
    }
    // Paths already missing before the move are the session's own deletions and stay
    // deleted; only files the incoming commits introduce are materialized.
    const listDeleted = async () =>
      (await requireGit(["ls-files", "--deleted", "-z"])).split("\0").filter(Boolean);
    const deletedBefore = new Set(await listDeleted());
    await requireGit(["reset", "--mixed", "FETCH_HEAD"]);
    const missing = (await listDeleted()).filter((file) => !deletedBefore.has(file));
    if (missing.length > 0) {
      await requireGit(["--literal-pathspecs", "checkout", "--", ...missing]);
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
