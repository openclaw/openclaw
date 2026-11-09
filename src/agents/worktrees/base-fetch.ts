import { gitNullConfigPath, requireGitCommandOutput } from "../../infra/git-exec.js";
import { appendGitConfig } from "../../infra/git-maintenance-env.js";
import { withGitObjectStoreTransport } from "../../infra/git-object-store-transport.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { CommandProcessCleanupError } from "../../process/exec-result.js";
import type { ResolvedWorktreeBase } from "./base-ref.types.js";
import { commandError, requireGit, runGit } from "./git.js";

// `ls-remote --symref` names HEAD's branch, then the object id it advertises for that tip.
const ADVERTISED_HEAD = /^ref: refs\/heads\/(.+)\tHEAD\r?$(?:\n([a-f0-9]{40,64})\tHEAD\r?$)?/mu;

export async function fetchRemoteDefault(
  repoRoot: string,
  options: NonNullable<Parameters<typeof runGit>[2]>,
): Promise<ResolvedWorktreeBase & { branch: string }> {
  const cached = await runGit(
    repoRoot,
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    options,
  );
  if (cached.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  const advertised = await runGit(repoRoot, ["ls-remote", "--symref", "origin", "HEAD"], {
    ...options,
    timeoutMs: 30_000,
  });
  if (advertised.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  if (options.signal?.aborted) {
    requireGitCommandOutput("git ls-remote origin HEAD", advertised);
    options.signal.throwIfAborted();
  }
  const advertisedOk = advertised.termination === "exit" && advertised.code === 0;
  const [, advertisedBranch, advertisedCommit] =
    (advertisedOk && ADVERTISED_HEAD.exec(advertised.stdout)) || [];
  const cachedBranch =
    cached.termination === "exit" && cached.code === 0
      ? /^refs\/remotes\/origin\/(.+)$/u.exec(cached.stdout.trim())?.[1]
      : undefined;
  let branch = advertisedBranch ?? cachedBranch;
  const warnings: string[] = [];
  if (!advertisedOk) {
    warnings.push(commandError("git ls-remote origin HEAD", advertised).message);
  } else if (!advertisedBranch) {
    warnings.push("origin did not advertise a default branch; using its cached default.");
  }
  if (!branch || branch === "HEAD") {
    throw new Error(
      `Remote default branch is unavailable. Repair origin or choose an explicit worktree base ref. ${redactSensitiveText(warnings.join("\n"))}`,
    );
  }
  let remoteRef = `refs/remotes/origin/${branch}`;
  const cachedObject =
    advertisedCommit &&
    (await requireGit(
      repoRoot,
      ["-c", "core.commitGraph=false", "cat-file", "--batch-check=%(objectname) %(objecttype)"],
      { ...options, input: `${remoteRef}\n` },
    ));
  const cachedCommit = cachedObject && /^([a-f0-9]{40,64}) commit$/u.exec(cachedObject)?.[1];
  // A matching advertised tip skips fetch; hydration still checks the captured commit.
  let fetchSucceeded = advertisedCommit !== undefined && advertisedCommit === cachedCommit;
  if (!fetchSucceeded) {
    const args = [
      "fetch",
      "--no-auto-maintenance",
      "--no-recurse-submodules",
      "--no-tags",
      ...(cachedCommit ? [`--negotiation-tip=${cachedCommit}`] : []),
      "origin",
      `+refs/heads/${branch}:${remoteRef}`,
    ];
    const fetchOptions = { ...options, timeoutMs: 60_000 };
    const fetched = cachedCommit
      ? await fetchDefaultWithIsolatedRefs(repoRoot, remoteRef, cachedCommit, args, fetchOptions)
      : await runGit(repoRoot, args, fetchOptions);
    if (fetched.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    if (options.signal?.aborted) {
      requireGitCommandOutput("git fetch origin default branch", fetched);
      options.signal.throwIfAborted();
    }
    fetchSucceeded = fetched.termination === "exit" && fetched.code === 0;
    if (!fetchSucceeded) {
      warnings.push(commandError("git fetch origin default branch", fetched).message);
      branch = cachedBranch ?? branch;
      remoteRef = `refs/remotes/origin/${branch}`;
    }
  }
  const verified = await runGit(
    repoRoot,
    ["rev-parse", "--verify", `${remoteRef}^{commit}`],
    options,
  );
  if (verified.cleanup === "uncertain") {
    throw new CommandProcessCleanupError();
  }
  if (options.signal?.aborted) {
    requireGitCommandOutput("git rev-parse remote default", verified);
    options.signal.throwIfAborted();
  }
  if (verified.termination !== "exit" || verified.code !== 0) {
    throw new Error(
      `Remote default ${remoteRef} is unavailable. Repair origin or choose an explicit worktree base ref. ${redactSensitiveText(warnings.join("\n"))}`,
    );
  }
  if (fetchSucceeded && advertisedBranch && cachedBranch !== branch) {
    await requireGit(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", remoteRef], options);
  }
  return {
    branch,
    commit: requireGitCommandOutput("git rev-parse remote default", verified).trim(),
    gitOperand: remoteRef,
    recordRef: `origin/${branch}`,
    fetchSucceeded,
    ...(warnings.length ? { warning: redactSensitiveText(warnings.join("\n")) } : {}),
  };
}

/** Keep origin's effective transport policy, without enumerating unrelated source refs. */
async function fetchDefaultWithIsolatedRefs(
  repoRoot: string,
  remoteRef: string,
  previous: string,
  args: string[],
  options: NonNullable<Parameters<typeof runGit>[2]>,
) {
  // Resolve conditional includes against the source worktree before changing Git metadata.
  const config = await requireGit(repoRoot, ["config", "--null", "--list", "--includes"], options);
  const entries: [string, string][] = [];
  for (const field of config.split("\0").filter(Boolean)) {
    const separator = field.indexOf("\n");
    const key = separator < 0 ? field : field.slice(0, separator);
    if (/^(?:include(?:if)?\.|core\.(?:bare|worktree)$|extensions\.refstorage$)/iu.test(key)) {
      continue;
    }
    entries.push([key, separator < 0 ? "true" : field.slice(separator + 1)]);
  }
  const mappings = entries.filter(([key]) => key === "remote.origin.fetch");
  if (mappings.length !== 1 || mappings[0]?.[1] !== "+refs/heads/*:refs/remotes/origin/*") {
    // Custom mappings may publish additional destinations; let Git own those writes.
    return await runGit(repoRoot, args, options);
  }
  return await withGitObjectStoreTransport(
    repoRoot,
    (cwd, command) => requireGit(cwd, command, options),
    async (staging, objects) => {
      const transport = {
        ...options,
        refMutationDirectory: staging,
        env: appendGitConfig(
          {
            ...options.env,
            GIT_DIR: staging,
            GIT_COMMON_DIR: staging,
            GIT_WORK_TREE: repoRoot,
            GIT_OBJECT_DIRECTORY: objects,
            GIT_CONFIG_GLOBAL: gitNullConfigPath(),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_PARAMETERS: undefined,
            GIT_CONFIG_COUNT: "0",
          },
          [...entries, ["core.bare", "true"], ["core.alternateRefsCommand", "true"]],
        ),
      };
      const fetched = await runGit(repoRoot, args, transport);
      if (fetched.cleanup === "uncertain") {
        throw new CommandProcessCleanupError();
      }
      if (fetched.termination !== "exit" || fetched.code !== 0) {
        return fetched;
      }
      const commit = await requireGit(repoRoot, ["rev-parse", "--verify", remoteRef], transport);
      // Fetch may observe a newer tip than ls-remote. Publish its actual result, with CAS.
      return await runGit(repoRoot, ["update-ref", remoteRef, commit, previous], options);
    },
  );
}
