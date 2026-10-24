import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectCloneFailureCause } from "../../packages/gateway-protocol/src/index.js";
import { hasErrnoCode } from "../infra/errno.js";
import {
  executeGitCommand,
  gitNullConfigPath,
  requireGitCommandOutput,
  type GitCommandOptions,
} from "../infra/git-exec.js";
import { withGitNetworkRetry, type GitOperationStarter } from "../infra/git-network-retry.js";
import { withGitRepositoryRepair } from "../infra/git-repository-repair.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
  readCommandProcessFailure,
  type SpawnResult,
} from "../process/exec-result.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { withGitProcessOperation } from "../process/spawn-diagnostics.js";

const PROJECT_CLONE_TIMEOUT_MS = 10 * 60_000;
type ProjectCloneOptions = {
  assertCurrent?: () => void;
  startRun?: GitOperationStarter;
  env?: NodeJS.ProcessEnv;
  objectDirectory?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  token?: string;
};
const PROJECT_FETCH_TIMEOUT_MS = 60_000;
const PROJECT_REF_INVENTORY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PROJECT_MAINTENANCE_CONFIG = [
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["pack.threads", "1"],
  ["pack.windowMemory", "64m"],
] as const;

/** The checkout lifecycle owner adopts existing managed clones before reuse. */
export async function configureProjectCheckoutMaintenance(
  target: string,
  options: ProjectCloneOptions,
): Promise<void> {
  for (const [key, value] of PROJECT_MAINTENANCE_CONFIG) {
    requireGitCommandOutput(
      "git config managed maintenance",
      await runProjectCheckoutGit({ target }, options, [
        "config",
        "--local",
        "--replace-all",
        key,
        value,
      ]),
    );
  }
}

export class ProjectCloneError extends Error {
  constructor(
    readonly failure: ProjectCloneFailureCause,
    message: string,
  ) {
    super(message);
    this.name = "ProjectCloneError";
  }
}

function cloneCommandEnv(
  repositoryUrl: string | undefined,
  token: string | undefined,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_TEMPLATE_DIR: "",
    GIT_EDITOR: "",
    GIT_SEQUENCE_EDITOR: "",
    GIT_EXTERNAL_DIFF: "",
    GIT_ASKPASS: undefined,
    SSH_ASKPASS: undefined,
    GIT_DIR: undefined,
    GIT_WORK_TREE: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_NAMESPACE: undefined,
    GIT_EXEC_PATH: undefined,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSL_NO_VERIFY: undefined,
  };
  if (token && repositoryUrl) {
    const origin = new URL(repositoryUrl).origin;
    gitEnv.GIT_CONFIG_COUNT = "1";
    gitEnv.GIT_CONFIG_KEY_0 = `http.${origin}/.extraHeader`;
    gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  }
  return gitEnv;
}

function classifyProjectGitFailure(
  result: Awaited<ReturnType<typeof runCommandWithTimeout>>,
  operation: "clone" | "fetch",
  tokenConfigured: boolean,
): ProjectCloneError {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    result.termination === "timeout" ||
    result.termination === "no-output-timeout" ||
    /could not resolve host|connection timed out|failed to connect/u.test(detail)
  ) {
    return new ProjectCloneError(
      "network",
      `Git ${operation} could not reach GitHub. Check the Gateway network connection and retry.`,
    );
  }
  if (
    /authentication failed|permission denied|could not read username|access denied/u.test(detail)
  ) {
    return new ProjectCloneError(
      "auth_required",
      tokenConfigured
        ? "GitHub rejected the active Control UI credential. Update gateway.controlUi.github.token when set; otherwise update the shared Gateway process environment, then retry."
        : "GitHub authentication is required. Configure gateway.controlUi.github.token or set GH_TOKEN/GITHUB_TOKEN in the shared Gateway process environment to clone private repositories.",
    );
  }
  if (/repository not found|not found/u.test(detail)) {
    return tokenConfigured
      ? new ProjectCloneError(
          "not_found",
          "GitHub could not find that repository. Check the URL and repository access.",
        )
      : new ProjectCloneError(
          "auth_required",
          "The repository was not found or is private. Check the URL, or configure gateway.controlUi.github.token (or the shared Gateway process environment) for private repositories.",
        );
  }
  return new ProjectCloneError(
    "clone_failed",
    `Git could not ${operation === "clone" ? "clone" : "refresh"} that repository. Check the URL and Gateway Git configuration, then retry.`,
  );
}

async function runProjectGitCommand<T extends SpawnResult>(run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    if (result.cleanup === "uncertain") {
      throw new CommandProcessCleanupError();
    }
    return result;
  } catch (error) {
    if (
      !hasCommandProcessCleanupError(error) &&
      readCommandProcessFailure(error)?.cleanup === "uncertain"
    ) {
      throw new CommandProcessCleanupError({ cause: error });
    }
    throw error;
  }
}

/** Clones one already-validated source into an unoccupied managed target. */
export async function cloneProjectCheckout(
  input: { url: string; target: string; requiredCommit?: string },
  options: ProjectCloneOptions = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const existed = await fs.lstat(input.target).then(
    () => true,
    (error: unknown) => {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw new ProjectCloneError(
        "clone_failed",
        "The managed checkout target could not be inspected. Check Gateway filesystem access and retry.",
      );
    },
  );
  if (existed) {
    throw new ProjectCloneError(
      "target_exists",
      "A managed checkout already exists for this repository. Register or remove it before retrying.",
    );
  }
  await fs.mkdir(path.dirname(input.target), { recursive: true });
  const commandEnv = cloneCommandEnv(input.url, options.token, env);
  const result = await withGitNetworkRetry(
    "clone",
    {
      timeoutMs: options.timeoutMs ?? PROJECT_CLONE_TIMEOUT_MS,
      signal: options.signal,
      beforeRun: options.assertCurrent,
      startRun: options.startRun,
    },
    async (timeoutMs) => {
      const attempt = await runProjectGitCommand(() =>
        withGitProcessOperation("project.clone", () =>
          runCommandWithTimeout(
            [
              "git",
              "clone",
              ...PROJECT_MAINTENANCE_CONFIG.flatMap(([key, value]) => [
                "--config",
                `${key}=${value}`,
              ]),
              "--no-recurse-submodules",
              "--",
              input.url,
              input.target,
            ],
            {
              env: commandEnv,
              timeoutMs,
              signal: options.signal,
              killProcessTree: true,
              maxOutputBytes: 256 * 1024,
            },
          ),
        ),
      );
      if (attempt.code !== 0 || attempt.termination !== "exit") {
        await fs.rm(input.target, { recursive: true, force: true }).catch(() => {
          throw new ProjectCloneError(
            "clone_failed",
            "Git could not remove the incomplete checkout. Check Gateway filesystem access and remove the partial checkout before retrying.",
          );
        });
      }
      return attempt;
    },
  );
  if (result.code === 0 && result.termination === "exit") {
    if (input.requiredCommit) {
      try {
        await ensureProjectCheckoutCommit({ ...input, commit: input.requiredCommit }, options);
      } catch (error) {
        if (hasCommandProcessCleanupError(error)) {
          throw error;
        }
        await fs.rm(input.target, { recursive: true, force: true });
        throw error;
      }
    }
    return;
  }
  throw classifyProjectGitFailure(result, "clone", Boolean(options.token));
}

/** Refreshes refs in an existing Gateway-managed project checkout. */
export async function refreshProjectCheckout(
  input: { target: string; url: string },
  options: ProjectCloneOptions = {},
): Promise<void> {
  const [objectPath, objectFormatResult, initialRefs, filterResult] = await Promise.all([
    runProjectCheckoutGit(input, options, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]),
    runProjectCheckoutGit(input, options, ["rev-parse", "--show-object-format"]),
    readProjectRemoteRefs(input, options),
    runProjectCheckoutGit(input, options, ["config", "--get", "remote.origin.partialclonefilter"]),
  ]);
  // The temporary repository does not inherit the managed clone's origin filter.
  const filter =
    filterResult.code === 1 && filterResult.termination === "exit"
      ? ""
      : requireGitCommandOutput("git config remote.origin.partialclonefilter", filterResult).trim();
  let currentRefs = initialRefs;
  if (objectPath.code !== 0 || objectPath.termination !== "exit") {
    throw new ProjectCloneError(
      "clone_failed",
      "The managed repository object store could not be verified. Remove the repository and retry.",
    );
  }
  const objectFormat = objectFormatResult.stdout.trim();
  if (
    objectFormatResult.code !== 0 ||
    objectFormatResult.termination !== "exit" ||
    (objectFormat !== "sha1" && objectFormat !== "sha256")
  ) {
    throw new ProjectCloneError(
      "clone_failed",
      "The managed repository object format could not be verified. Remove the repository and retry.",
    );
  }
  const objects = await fs.realpath(objectPath.stdout.trim());
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-project-fetch-"));
  let retainStaging = false;
  try {
    const initialized = await runProjectCheckoutGit({ target: staging }, options, [
      "init",
      "--bare",
      `--object-format=${objectFormat}`,
    ]);
    if (initialized.code !== 0 || initialized.termination !== "exit") {
      throw new ProjectCloneError(
        "clone_failed",
        "Git could not prepare a safe repository refresh. Retry the session.",
      );
    }
    const stagingOptions = { ...options, objectDirectory: objects };
    let protectedRefs: ReadonlySet<string> | undefined;
    if (currentRefs.size > 0) {
      // Seed only refs already owned by the managed checkout. Besides enabling
      // incremental negotiation, this keeps transport isolated from local branches.
      const seed = () =>
        runProjectCheckoutGit({ target: staging }, stagingOptions, ["update-ref", "--stdin"], {
          input: Array.from(currentRefs, ([ref, commit]) => `update ${ref} ${commit}\n`).join(""),
        });
      const seeded = await withGitRepositoryRepair({
        cwd: input.target,
        result: await seed(),
        remote: input.url,
        canonicalTracking: true,
        onRepaired: (refs) => {
          protectedRefs = refs;
        },
        signal: options.signal,
        assertCurrent: options.assertCurrent,
        run: (args, commandOptions) =>
          args.includes("fetch") || args.includes("ls-remote")
            ? runProjectCheckoutGit(
                { target: staging, url: input.url },
                stagingOptions,
                args,
                commandOptions,
              )
            : runProjectCheckoutGit(input, options, args, commandOptions),
        retry: async () => {
          currentRefs = await readProjectRemoteRefs(input, options);
          return seed();
        },
      });
      if (seeded.code !== 0 || seeded.termination !== "exit") {
        throw new ProjectCloneError(
          "clone_failed",
          "Git could not prepare the managed repository refs for refresh. Retry the session.",
        );
      }
    }
    // The isolated repository owns transport, but it borrows the managed object store.
    // It must not run maintenance using its incomplete temporary ref inventory.
    const result = await runProjectCheckoutGit(
      { target: staging, url: input.url },
      {
        ...stagingOptions,
        timeoutMs: options.timeoutMs ?? PROJECT_FETCH_TIMEOUT_MS,
      },
      [
        "fetch",
        "--no-auto-maintenance",
        "--no-recurse-submodules",
        "--prune",
        ...(filter ? [`--filter=${filter}`] : []),
        "--",
        input.url,
        "+refs/heads/*:refs/remotes/origin/*",
      ],
    );
    if (result.code !== 0 || result.termination !== "exit") {
      throw classifyProjectGitFailure(result, "fetch", Boolean(options.token));
    }
    const fetchedRefs = await readProjectRemoteRefs({ target: staging }, stagingOptions);
    const updates = [
      ...Array.from(fetchedRefs, ([ref, commit]) => `update ${ref} ${commit}`),
      ...Array.from(currentRefs.keys())
        .filter((ref) => !fetchedRefs.has(ref) && !protectedRefs?.has(ref))
        .map((ref) => `delete ${ref}`),
    ];
    if (updates.length > 0) {
      const updated = await runProjectCheckoutGit(
        input,
        options,
        ["update-ref", "--no-deref", "--stdin"],
        {
          input: `${updates.join("\n")}\n`,
        },
      );
      if (updated.code !== 0 || updated.termination !== "exit") {
        throw new ProjectCloneError(
          "clone_failed",
          "The managed repository changed while its branches were refreshed. Retry the session.",
        );
      }
    }
  } catch (error) {
    retainStaging = hasCommandProcessCleanupError(error);
    throw error;
  } finally {
    if (!retainStaging) {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}

async function readProjectRemoteRefs(
  input: { target: string },
  options: ProjectCloneOptions,
): Promise<Map<string, string>> {
  const result = await runProjectCheckoutGit(
    input,
    options,
    ["for-each-ref", "--format=%(refname) %(objectname) %(symref)", "refs/remotes/origin"],
    {
      // Refresh needs the complete inventory; diagnostic output keeps its smaller budget.
      maxOutputBytes: { stdout: PROJECT_REF_INVENTORY_MAX_OUTPUT_BYTES, stderr: 256 * 1024 },
    },
  );
  const stdout = requireGitCommandOutput("git for-each-ref", result, (_command, failed) =>
    failed.outputLimitExceeded
      ? new ProjectCloneError(
          "clone_failed",
          `The managed repository ref inventory exceeded the ${PROJECT_REF_INVENTORY_MAX_OUTPUT_BYTES / (1024 * 1024)} MiB refresh limit. Choose a base already available in the checkout or ask the Gateway administrator for help.`,
        )
      : new ProjectCloneError("clone_failed", "Git could not read the managed repository refs."),
  );
  const refs = new Map<string, string>();
  for (const line of stdout.trim().split("\n").filter(Boolean)) {
    const match = /^(refs\/remotes\/origin\/\S+) ([a-f0-9]{40}|[a-f0-9]{64})(?: (\S+))?$/u.exec(
      line.trimEnd(),
    );
    if (!match) {
      throw new ProjectCloneError(
        "clone_failed",
        "Git returned an invalid managed repository ref.",
      );
    }
    const [, ref, commit, symbolicTarget] = match;
    if (!ref || !commit) {
      throw new ProjectCloneError(
        "clone_failed",
        "Git returned an incomplete managed repository ref.",
      );
    }
    if (symbolicTarget) {
      continue;
    }
    refs.set(ref, commit);
  }
  return refs;
}

function runProjectCheckoutGit(
  input: { target: string; url?: string },
  options: ProjectCloneOptions,
  args: string[],
  commandOptions: GitCommandOptions = {},
) {
  return runProjectGitCommand(() =>
    executeGitCommand(
      input.target,
      ["-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args],
      {
        operation: "project.clone",
        timeoutMs: options.timeoutMs ?? PROJECT_CLONE_TIMEOUT_MS,
        signal: options.signal,
        killProcessTree: true,
        maxOutputBytes: 256 * 1024,
        beforeRun: options.assertCurrent,
        startRun: options.startRun,
        ...commandOptions,
        env: {
          ...cloneCommandEnv(input.url, options.token, options.env ?? process.env),
          ...commandOptions.env,
          ...(options.objectDirectory ? { GIT_OBJECT_DIRECTORY: options.objectDirectory } : {}),
        },
      },
    ),
  );
}

/** Fetch the pinned source when a reused project clone predates the remote session. */
export async function ensureProjectCheckoutCommit(
  input: { url: string; target: string; commit: string },
  options: ProjectCloneOptions = {},
): Promise<void> {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(input.commit)) {
    throw new ProjectCloneError("clone_failed", "The repository commit is invalid.");
  }
  const command = (args: string[]) => runProjectCheckoutGit(input, options, args);
  // --missing disables lazy fetching before revision lookup, including on older
  // Git. The commit graph cannot stand in for a physically present commit.
  const present = await command([
    "-c",
    "core.commitGraph=false",
    "rev-list",
    "--missing=allow-any",
    "--no-walk",
    `${input.commit}^{commit}`,
  ]);
  if (present.code === 0 && present.termination === "exit" && present.stdout.trim()) {
    return;
  }
  const fetch = () =>
    command([
      "fetch",
      "--no-auto-maintenance",
      "--no-tags",
      "--no-recurse-submodules",
      "--",
      input.url,
      input.commit,
    ]);
  const fetched = await withGitRepositoryRepair({
    cwd: input.target,
    result: await fetch(),
    remote: input.url,
    signal: options.signal,
    assertCurrent: options.assertCurrent,
    run: (args, commandOptions) => runProjectCheckoutGit(input, options, args, commandOptions),
    retry: fetch,
  });
  if (fetched.code !== 0 || fetched.termination !== "exit") {
    throw classifyProjectGitFailure(fetched, "fetch", Boolean(options.token));
  }
}

/** Observe only the named source branch using the same shared fetch identity as cloning. */
export async function readProjectCheckoutRemoteHead(
  input: { url: string; target: string; branch: string },
  options: ProjectCloneOptions = {},
): Promise<string | undefined> {
  const ref = `refs/heads/${input.branch}`;
  const result = await runProjectCheckoutGit(input, options, [
    "ls-remote",
    "--refs",
    "--",
    input.url,
    ref,
  ]);
  if (result.code !== 0 || result.termination !== "exit") {
    throw new ProjectCloneError(
      "network",
      "The repository branch could not be verified; retry the Gateway move.",
    );
  }
  const raw = result.stdout.trim();
  if (!raw) {
    return undefined;
  }
  const [sha, observedRef, ...extra] = raw.split(/\s+/u);
  if (
    !sha ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(sha) ||
    observedRef !== ref ||
    extra.length
  ) {
    throw new ProjectCloneError("clone_failed", "The repository branch observation is invalid.");
  }
  return sha;
}
