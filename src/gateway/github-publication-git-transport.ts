import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import type { WorktreeGitPolicy } from "../agents/worktrees/checkout-git-config.js";
import { hasErrnoCode } from "../infra/errno.js";
import { gitNullConfigPath, gitReadOnlyEnvironment } from "../infra/git-exec.js";
import { appendGitConfig, gitMaintenanceEnvironment } from "../infra/git-maintenance-env.js";
import { retryableGitNetworkOperation, withGitNetworkRetry } from "../infra/git-network-retry.js";
import { createCommandError } from "../process/command-error.js";
import { runCommandBuffered } from "../process/exec.js";
import { withGitProcessOperation } from "../process/spawn-diagnostics.js";
import type { GitProcessOperation } from "../process/spawn-diagnostics.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { githubPublicationUnsafeConfigArgs } from "./github-publication-base.js";
import { createGitHubPublicationGitError } from "./github-publication-git-error.js";
import type { RepositoryPublicationPublisher } from "./repository-publication-contract.js";
import { createRepositoryPublicationGitTransfer } from "./repository-publication-git-transfer.js";

type GitCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer | (() => string | Buffer);
  maxOutputBytes?: number;
  beforeRun?: () => void;
  operation?: GitProcessOperation;
  httpAuthorization?: { url: string; value: string };
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  discardOutput?: { stdout?: boolean };
};
type GitCommandResult = { code: number | null; stdout: Buffer };
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export async function runPublicationCommand(argv: string[], options: GitCommandOptions = {}) {
  if (
    options.httpAuthorization &&
    (argv[0] !== "git" ||
      !URL.canParse(options.httpAuthorization.url) ||
      new URL(options.httpAuthorization.url).protocol !== "https:" ||
      /[\r\n\0]/u.test(options.httpAuthorization.value))
  ) {
    throw new Error("Publication Git authorization is invalid.");
  }
  return await withGitProcessOperation(options.operation ?? "publication", () =>
    withGitNetworkRetry(
      argv[0] === "git" ? retryableGitNetworkOperation(argv.slice(1)) : undefined,
      { timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, beforeRun: options.beforeRun },
      (timeoutMs) =>
        runCommandBuffered(argv, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env: {
            ...(argv[0] === "git"
              ? gitReadOnlyEnvironment(argv.slice(1), options.env ?? {})
              : (options.env ?? {})),
            GIT_NO_REPLACE_OBJECTS: "1",
            // Pin every command against repository hooks; explicit hook-disabling -c flags stay stronger.
            ...appendGitConfig(gitMaintenanceEnvironment(), [
              ["core.hooksPath", os.devNull],
              ...(options.httpAuthorization
                ? [
                    ["credential.helper", ""] as [string, string],
                    [
                      `http.${options.httpAuthorization.url}.extraHeader`,
                      `Authorization: ${options.httpAuthorization.value}`,
                    ] as [string, string],
                  ]
                : []),
            ]),
            ...(options.httpAuthorization ? { GIT_TERMINAL_PROMPT: "0" } : {}),
          },
          // Resolve optional disclosure after beforeRun, directly at the transport boundary.
          ...(options.input !== undefined
            ? { input: typeof options.input === "function" ? options.input() : options.input }
            : {}),
          timeoutMs,
          noOutputTimeoutMs: options.noOutputTimeoutMs,
          discardOutput: options.discardOutput,
          maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
        }),
    ),
  );
}

export async function requirePublicationCommand(
  argv: string[],
  options: GitCommandOptions = {},
): Promise<string> {
  const result = await runPublicationCommand(argv, options);
  if (result.code !== 0 || result.error) {
    throw createCommandError(
      argv[0] ?? "command",
      { ...result, stdout: Buffer.alloc(0) },
      { timeoutMs: options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS },
    );
  }
  return result.stdout.toString("utf8").trim();
}

// Guard ordinary steps on both sides of the await. Effects whose observations
// must survive revocation use the raw transport and record before rechecking.
export function createGitHubPublicationCommandRunner(
  assertCurrent?: () => void,
  gitOperation: GitProcessOperation = "publication",
) {
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent?.();
    const result = await operation();
    assertCurrent?.();
    return result;
  };
  const guarded =
    <T>(command: (argv: string[], options: GitCommandOptions) => Promise<T>) =>
    async (argv: string[], options: GitCommandOptions = {}): Promise<T> => {
      const result = await command(argv, {
        ...options,
        operation: gitOperation,
        beforeRun: assertCurrent,
      });
      assertCurrent?.();
      return result;
    };
  return {
    step,
    run: guarded(runPublicationCommand),
    require: guarded(requirePublicationCommand),
  };
}

// Recursive inventories scale with repository size, far past the default
// per-command cap. Keep an explicit bound for tree and missing-object listings.
const TREE_LISTING_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function assertSafeGitPublicationWorkspace(
  cwd: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<void> {
  const isolatedConfig = {
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
  };
  const [localUnsafe, worktreeConfig] = await Promise.all([
    run(githubPublicationUnsafeConfigArgs("--local"), { cwd, env: isolatedConfig }),
    run(
      ["git", "config", "--local", "--includes", "--bool", "--get", "extensions.worktreeConfig"],
      { cwd, env: isolatedConfig },
    ),
  ]);
  const worktreeConfigValue = worktreeConfig.stdout.toString("utf8").trim();
  const worktreeConfigKnown =
    (worktreeConfig.code === 0 &&
      (worktreeConfigValue === "true" || worktreeConfigValue === "false")) ||
    (worktreeConfig.code === 1 && worktreeConfig.stdout.length === 0);
  if (localUnsafe.code !== 1 || localUnsafe.stdout.length > 0 || !worktreeConfigKnown) {
    throw new Error(
      "Repository publication workspace has unsupported Git transport configuration.",
    );
  }
  const worktreeUnsafe =
    worktreeConfigValue === "true"
      ? await run(githubPublicationUnsafeConfigArgs("--worktree"), {
          cwd,
          env: isolatedConfig,
        })
      : undefined;
  if (worktreeUnsafe && (worktreeUnsafe.code !== 1 || worktreeUnsafe.stdout.length > 0)) {
    throw new Error(
      "Repository publication workspace has unsupported Git transport configuration.",
    );
  }
  const [replacements, graftPath] = await Promise.all([
    run(["git", "for-each-ref", "--count=1", "--format=%(refname)", "refs/replace"], { cwd }),
    run(["git", "rev-parse", "--git-path", "info/grafts"], { cwd }),
  ]);
  if (replacements.code !== 0 || replacements.stdout.length > 0 || graftPath.code !== 0) {
    throw new Error("Repository publication workspace has unsupported Git replacement metadata.");
  }
  const grafts = await readOptionalAttributeFile(
    path.resolve(cwd, graftPath.stdout.toString("utf8").trim()),
  );
  if (grafts && grafts.length > 0) {
    throw new Error("Repository publication workspace has unsupported Git replacement metadata.");
  }
}

function assertNoGitFilterAttributes(contents: Buffer): void {
  for (const line of contents.toString("latin1").split(/\r?\n/u)) {
    const fields = line.trimStart().split(/[\t ]+/u);
    if (!fields[0] || fields[0].startsWith("#")) {
      continue;
    }
    if (fields.slice(1).some((field) => /^(?:-|!)?filter(?:=|$)/u.test(field))) {
      throw new Error("Repository publication workspace uses an unsupported Git clean filter.");
    }
  }
}

async function readOptionalAttributeFile(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function readGitHubPublicationTree(
  cwd: string,
  workspaceTree: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<Buffer> {
  const listing = await run(["git", "ls-tree", "-r", "-z", "--full-tree", workspaceTree], {
    cwd,
    maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
  });
  if (listing.code !== 0) {
    throw new Error("Repository publication workspace tree could not be verified.");
  }
  return listing.stdout;
}

async function assertGitHubPublicationIndexHasNoFilters(
  cwd: string,
  indexFile: string,
): Promise<void> {
  // This private index just produced the accepted tree, including admission pruning.
  // Select attributes in Git instead of buffering every path in that tree.
  const listing = await runPublicationCommand(
    [
      "git",
      "-c",
      "core.fsmonitor=false",
      "ls-files",
      "--cached",
      "--format=%(objectname)",
      "--",
      ":(top,icase,glob)**/.gitattributes",
    ],
    {
      cwd,
      env: { GIT_INDEX_FILE: indexFile, GIT_LITERAL_PATHSPECS: "0" },
      maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
    },
  );
  if (listing.code !== 0) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const attributeObjects = new Set(
    listing.stdout.toString("utf8").trim().split("\n").filter(Boolean),
  );
  if (attributeObjects.size > 1024) {
    throw new Error("Repository publication workspace has too many Git attribute files.");
  }
  for (const objectId of attributeObjects) {
    const blob = await runPublicationCommand(["git", "cat-file", "blob", objectId], { cwd });
    if (blob.code !== 0) {
      throw new Error("Repository publication workspace attributes could not be verified.");
    }
    assertNoGitFilterAttributes(blob.stdout);
  }

  const infoPath = await runPublicationCommand(
    ["git", "rev-parse", "--git-path", "info/attributes"],
    {
      cwd,
    },
  );
  if (infoPath.code !== 0) {
    throw new Error("Repository publication workspace attributes could not be verified.");
  }
  const attributeFiles = await Promise.all(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map(
      async (name) => await runPublicationCommand(["git", "var", name], { cwd }),
    ),
  );
  if (attributeFiles.some((result) => result.code !== 0)) {
    throw new Error("Repository publication workspace attributes could not be verified.");
  }
  const paths = [
    path.resolve(cwd, infoPath.stdout.toString("utf8").trim()),
    ...attributeFiles.flatMap((result) =>
      result.stdout.length > 0 ? [result.stdout.toString("utf8").trim()] : [],
    ),
  ];
  for (const file of paths) {
    const contents = await readOptionalAttributeFile(file);
    if (contents) {
      assertNoGitFilterAttributes(contents);
    }
  }
}

export async function captureGitHubPublicationWorkspaceSnapshot(params: {
  cwd: string;
  assertCurrent?: () => void;
}): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const pendingMerge = await runPublicationCommand(
    ["git", "rev-parse", "--verify", "--quiet", "MERGE_HEAD"],
    { cwd: params.cwd, beforeRun: params.assertCurrent },
  );
  params.assertCurrent?.();
  if (pendingMerge.code === 0) {
    throw new Error(
      "Workspace base integration is pending. Use github_publish refresh_base, resolve its reported conflicts, then repeat refresh_base with conflictsResolved and the returned baseCommit before tests, Auto Review, and publication.",
    );
  }
  if (pendingMerge.code !== 1) {
    throw new Error("Workspace base integration state could not be verified; retry refresh_base.");
  }
  const context = captureOpenClawStateWorkerContext();
  const [
    { withSettledLocalWorkspacePath },
    { readLiveRegistryWorktreeByPath },
    { withManagedWorktreeGit },
    { readRuntimeConfig },
  ] = await Promise.all([
    import("./worker-environments/local-workspace-projection.js"),
    import("../agents/worktrees/registry-read.js"),
    import("../agents/worktrees/checkout-policy.js"),
    import("../config/runtime-snapshot.js"),
  ]);
  return await withSettledLocalWorkspacePath(params, async (custody) => {
    const admittedPaths = await custody?.canonicalPaths?.();
    const bound = {
      ...params,
      assertCurrent: () => {
        context.admission.assertCurrent();
        params.assertCurrent?.();
        custody?.assertCurrent();
      },
    };
    const record = await readLiveRegistryWorktreeByPath(context, params.cwd);
    bound.assertCurrent();
    return record
      ? await withManagedWorktreeGit(
          {
            record,
            env: process.env,
            getConfig: readRuntimeConfig,
            beforeRun: bound.assertCurrent,
          },
          (git) =>
            captureSettledGitHubPublicationWorkspaceSnapshot(
              bound,
              git.sourceOnly ? git : undefined,
              admittedPaths,
            ),
        )
      : await captureSettledGitHubPublicationWorkspaceSnapshot(bound, undefined, admittedPaths);
  });
}

export async function captureSettledGitHubPublicationWorkspaceSnapshot(
  params: {
    cwd: string;
    assertCurrent?: () => void;
  },
  policy?: WorktreeGitPolicy,
  admittedPaths?: ReadonlySet<string>,
): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const { step, require: command } = createGitHubPublicationCommandRunner(params.assertCurrent);
  const git = (args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer) =>
    policy
      ? step(() =>
          policy.require(params.cwd, args, { env, input, beforeRun: params.assertCurrent }),
        )
      : command(
          ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args],
          {
            cwd: params.cwd,
            env,
            input,
          },
        );
  await step(() => assertSafeGitPublicationWorkspace(params.cwd, runPublicationCommand));
  const sourceHeadCommit = await command(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: params.cwd,
  });
  const index = path.resolve(params.cwd, await git(["rev-parse", "--git-path", "index"]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-publication-snapshot-"));
  try {
    const env = {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      GIT_INDEX_FILE: path.join(tempDir, "index"),
    };
    // Preserve staged path inventory, and keep write-tree cache updates off the real index.
    const indexStat = await step(() => fs.stat(index, { bigint: true }));
    await step(() => fs.copyFile(index, env.GIT_INDEX_FILE));
    // A newer copy timestamp hides racy-clean edits. Round down so lost precision only adds reads.
    const indexTimestamp = Number(indexStat.mtimeNs / 1_000_000_000n);
    await step(() => fs.utimes(env.GIT_INDEX_FILE, indexTimestamp, indexTimestamp));
    const sourceIndexTree = await git(["write-tree"], env);
    // Ordinary staging preserves unchanged blobs; renormalization would rewrite unrelated CRLF files.
    try {
      // Allow quiet scans and buffered file progress; a hard bound stops endless progress.
      const args = ["-c", `core.attributesFile=${os.devNull}`, "add", "-A", "--verbose"];
      const options = {
        cwd: params.cwd,
        env,
        timeoutMs: 600_000,
        noOutputTimeoutMs: 180_000,
        discardOutput: { stdout: true },
        beforeRun: params.assertCurrent,
      };
      const result = await step(() =>
        policy
          ? policy.worker.buffered(params.cwd, args, options)
          : runPublicationCommand(["git", "-c", "core.fsmonitor=false", ...args], options),
      );
      if (result.code !== 0 || result.error) {
        throw createCommandError("git add", result, options);
      }
    } catch (cause) {
      throw new Error(
        `GitHub publication snapshot staging failed before submission: ${formatErrorMessage(cause, { includeCode: true })}. The source index is unchanged; inspect Git locks, disk space and host load, then retry publication.`,
        { cause },
      );
    }
    let workspaceTree = await git(["write-tree"], env);
    if (admittedPaths) {
      // Staging must not turn guest-edited ignore rules into host admission.
      // Prune only the private publication index; canonical archive and host
      // index custody are unchanged. This also handles directory replacements
      // without recursive pathspecs enrolling unowned descendants.
      const staged = await step(() =>
        readGitHubPublicationTree(params.cwd, workspaceTree, runPublicationCommand),
      );
      const excluded: Buffer[] = [];
      let start = 0;
      for (let end = staged.indexOf(0); end !== -1; end = staged.indexOf(0, start)) {
        const pathStart = staged.indexOf(9, start) + 1;
        const entry = staged.toString("utf8", pathStart, end);
        // Invalid UTF-8 must not alias an admitted literal replacement character.
        if (
          !admittedPaths.has(entry) ||
          (entry.includes("\uFFFD") && !Buffer.from(entry).equals(staged.subarray(pathStart, end)))
        ) {
          excluded.push(staged.subarray(pathStart, end + 1));
        }
        start = end + 1;
      }
      if (excluded.length) {
        await git(
          ["update-index", "--force-remove", "-z", "--stdin"],
          env,
          Buffer.concat(excluded),
        );
        workspaceTree = await git(["write-tree"], env);
      }
    }
    await step(() => assertGitHubPublicationIndexHasNoFilters(params.cwd, env.GIT_INDEX_FILE));
    return { sourceHeadCommit, sourceIndexTree, workspaceTree };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function readGitHubPublicationCoauthorTrailers(params: {
  cwd: string;
  headCommit: string;
  command: typeof requirePublicationCommand;
}): Promise<string[]> {
  const output = await params.command(
    [
      "git",
      "-c",
      "trailer.separators=:",
      "-c",
      "trailer.co-authored-by.key=Co-authored-by",
      "show",
      "-s",
      "--format=%(trailers:key=Co-authored-by,only,unfold)",
      params.headCommit,
    ],
    { cwd: params.cwd },
  );
  return output.split(/\r?\n/u);
}

export async function assertGitHubPublicationBranchRef(
  branch: string,
  run: (argv: string[]) => Promise<number>,
): Promise<void> {
  const code = await run(["git", "symbolic-ref", "--quiet", `refs/heads/${branch}`]);
  if (code === 0) {
    throw new Error("Repository publication workspace branch ref became symbolic.");
  }
  if (code !== 1) {
    throw new Error("Repository publication workspace branch ref could not be verified.");
  }
}

export function githubPublicationUpdateRefArgs(
  branch: string,
  commit: string,
  previousHead: string,
): string[] {
  return [
    "git",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "update-ref",
    `refs/heads/${branch}`,
    commit,
    previousHead,
  ];
}

export function githubPublicationPushArgs(
  remote: string,
  headCommit: string,
  branch: string,
  expectedRemoteHead: string,
): string[] {
  return [
    "git",
    "-c",
    "http.followRedirects=false",
    "push",
    "--porcelain",
    `--force-with-lease=refs/heads/${branch}:${expectedRemoteHead}`,
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    remote,
    `${headCommit}:refs/heads/${branch}`,
  ];
}

export async function runAuthorizedPublicationGit(
  publisher: RepositoryPublicationPublisher,
  remoteUrl: string,
  argv: string[],
  options: Parameters<typeof runPublicationCommand>[1],
  assertCurrent: () => void,
) {
  const operation = createRepositoryPublicationGitTransfer(
    (authorization, assertCredential) =>
      runPublicationCommand(argv, {
        ...options,
        httpAuthorization: { url: remoteUrl, value: authorization },
        beforeRun: () => {
          assertCurrent();
          assertCredential();
        },
      }),
    assertCurrent,
  );
  await publisher.authorizeGit(operation.transfer);
  return operation.result();
}
export async function requireGitHubPublicationCommit(params: {
  publisher: RepositoryPublicationPublisher;
  remoteUrl: string;
  sha: string;
  cwd: string;
  assertCurrent: () => void;
  failure: string;
  contents?: boolean;
  commitPresent?: boolean;
}) {
  const { publisher, remoteUrl, sha, cwd, assertCurrent, failure } = params;
  const fetch = async (missing?: string[]) => {
    const result = await runAuthorizedPublicationGit(
      publisher,
      remoteUrl,
      [
        "git",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "http.followRedirects=false",
        "-c",
        "maintenance.auto=false",
        "-c",
        "gc.auto=0",
        "fetch",
        "--no-auto-maintenance",
        "--no-tags",
        "--no-write-fetch-head",
        "--recurse-submodules=no",
        ...(missing ? ["--refetch", "--stdin"] : ["--filter=blob:none"]),
        "--",
        remoteUrl,
        ...(missing ? [] : [sha]),
      ],
      { cwd, ...(missing ? { input: missing.join("\n") + "\n" } : {}) },
      assertCurrent,
    );
    assertCurrent();
    if (result.code !== 0 || result.error) {
      throw createGitHubPublicationGitError(
        failure,
        missing ? "content fetch" : "commit fetch",
        result,
        DEFAULT_COMMAND_TIMEOUT_MS,
      );
    }
  };
  if (!params.commitPresent) {
    // Probe physical commit metadata without lazy fetching or trusting commit graphs.
    // A local commit can already be complete while unrelated promisor objects are absent.
    const present = await runPublicationCommand(
      [
        "git",
        "-c",
        "core.commitGraph=false",
        "rev-list",
        "--missing=allow-any",
        "--no-walk",
        `${sha}^{commit}`,
      ],
      { cwd, beforeRun: assertCurrent },
    );
    assertCurrent();
    if (present.code !== 0 || !present.stdout.toString("utf8").trim()) {
      await fetch();
    }
  }
  if (!params.contents) {
    return;
  }
  const readMissing = async (stage = "content inventory") => {
    const result = await runPublicationCommand(
      [
        "git",
        "rev-list",
        "--objects",
        "--missing=print",
        "--no-object-names",
        "--max-count=1",
        sha,
      ],
      {
        cwd,
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        beforeRun: assertCurrent,
        maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
      },
    );
    assertCurrent();
    if (result.code !== 0) {
      throw createGitHubPublicationGitError(failure, stage, result, DEFAULT_COMMAND_TIMEOUT_MS);
    }
    return result.stdout
      .toString("utf8")
      .split("\n")
      .filter((line) => line.startsWith("?"))
      .map((line) => line.slice(1));
  };
  const missing = await readMissing();
  if (missing.length) {
    await fetch(missing);
    if ((await readMissing("content verification")).length) {
      throw new Error(
        `${failure} Git content verification failed: required objects are still missing after fetching.`,
      );
    }
  }
}

export {
  appendGitHubPublicationMessage,
  hasGitHubPublicationMessageFooter,
} from "./repository-publication-message.js";
export function githubPublicationRemoteHeadArgs(remote: string, branch: string) {
  return ["git", "ls-remote", "--exit-code", "--heads", remote, `refs/heads/${branch}`];
}
