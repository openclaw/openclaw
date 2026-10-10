import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { tempWorkspace } from "@openclaw/fs-safe/temp";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";
import { canonicalPathFromExistingAncestor, isPathInside } from "../infra/fs-safe.js";
import {
  GIT_TIMEOUT_MS,
  executeGitCommand as runGit,
  normalizeGitPathForFilesystem,
  requireGitCommand as requireGit,
  requireGitCommandOutput,
} from "../infra/git-exec.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { assertNotUpdateCapturePath } from "../infra/update-capture-paths.js";
import { formatCommandOutput, formatCommandResult } from "../process/command-error.js";
import { spawnCommand } from "../process/exec-spawn.js";
import { BACKUP_RUN_ERROR_MAX_LENGTH } from "../state/backup-run-records.contract.js";
import {
  GIT_BACKUP_MANIFEST,
  GIT_BACKUP_SCHEMA,
  GIT_BACKUP_TABLES,
  dumpGitBackupDatabase,
  gitBackupScopePath,
  parseGitBackupManifest,
  restoreGitBackupDirectory,
  type GitBackupIdentity,
  type GitBackupManifest,
  type GitBackupRestoreResult,
} from "./git-backup-codec.js";
import {
  hasNonFinderNamesake,
  isFinderMetadataBlob,
  isFinderMetadataFile,
} from "./git-backup-finder.js";
import { ensurePrivateSnapshotRepositoryRoot } from "./local-repository.js";
import { createOpenClawSnapshotCopy } from "./openclaw-snapshot-copy.js";
import type { SnapshotDatabaseRef } from "./snapshot-provider.js";

const GIT_BACKUP_DIAGNOSTIC_MAX_LENGTH = 500;
const GIT_BACKUP_NON_BACKUP_HISTORY_WARNING =
  "repository history contains non-backup commits; use a dedicated backup repository";
const GIT_BACKUP_SCOPES = ["global", "agents"];
const GIT_BACKUP_METADATA_EXCLUSIONS = [":(exclude,glob)**/.DS_Store"];

type GitBackupCreateResult = {
  repositoryPath: string;
  commit?: string;
  noChanges: boolean;
  pushed: boolean;
  pushWarning?: string;
  manifests: GitBackupManifest[];
  warnings: string[];
};

function redactGitBackupText(value: string): string {
  return value
    .split("\n")
    .map((line) => redactSensitiveUrlLikeString(line))
    .join("\n");
}

function sanitizeGitBackupDiagnostic(value: string): string {
  return truncateUtf16Safe(redactGitBackupText(value), GIT_BACKUP_DIAGNOSTIC_MAX_LENGTH);
}

function formatGitBackupCommandResult(
  command: string,
  result: Awaited<ReturnType<typeof runGit>>,
): string {
  const redacted = {
    ...result,
    stderr: redactGitBackupText(result.stderr),
    stdout: redactGitBackupText(result.stdout),
  };
  const header = formatCommandResult(command, { ...redacted, stderr: "", stdout: "" });
  const streams = (["stderr", "stdout"] as const).flatMap((stream) => {
    const output = formatCommandOutput(redacted[stream]);
    return output ? [{ stream, output }] : [];
  });
  const fixedLength =
    header.length + streams.reduce((total, { stream }) => total + 1 + `${stream}: `.length, 0);
  if (streams.length === 0 || fixedLength >= BACKUP_RUN_ERROR_MAX_LENGTH) {
    return truncateUtf16Safe(header, BACKUP_RUN_ERROR_MAX_LENGTH);
  }
  const outputBudget = BACKUP_RUN_ERROR_MAX_LENGTH - fixedLength;
  const lengths = streams.map(({ output }) => output.length);
  const first = Math.min(
    lengths[0] ?? 0,
    Math.max(Math.ceil(outputBudget / 2), outputBudget - (lengths[1] ?? 0)),
  );
  const allocations = [first, Math.min(lengths[1] ?? 0, outputBudget - first)];
  const fit = (output: string, maxLength: number): string => {
    if (output.length <= maxLength) {
      return output;
    }
    if (maxLength <= 1) {
      return truncateUtf16Safe("…", maxLength);
    }
    const source = output.startsWith("…\n") ? output.slice(2) : output;
    return `…\n${sliceUtf16Safe(source, Math.max(0, source.length - (maxLength - 2)))}`;
  };
  return [
    header,
    ...streams.map(
      ({ stream, output }, index) => `${stream}: ${fit(output, allocations[index] ?? 0)}`,
    ),
  ].join("\n");
}

function gitBackupRepositoryPrivacyRemediation(repositoryPath: string, cause: unknown): string {
  if (process.platform === "win32") {
    const detail =
      cause instanceof Error && cause.message
        ? ` ${sanitizeGitBackupDiagnostic(cause.message)}`
        : "";
    return (
      `${detail} Remove non-user ACL grants from ${repositoryPath} or choose a private local directory. ` +
      "Do not use a shared or synced folder for SQLite backups."
    );
  }
  return `Fix its ownership and run chmod 700 ${repositoryPath}.`;
}

async function assertGitRepository(repositoryPath: string, env?: NodeJS.ProcessEnv): Promise<void> {
  const topLevel = await requireGit(repositoryPath, ["rev-parse", "--show-toplevel"], { env });
  const [canonicalTopLevel, canonicalRepository] = await Promise.all([
    fs.realpath(normalizeGitPathForFilesystem(topLevel)),
    fs.realpath(repositoryPath),
  ]);
  if (canonicalTopLevel !== canonicalRepository) {
    throw new Error(`Backup repository must be the Git worktree root: ${repositoryPath}`);
  }
}

/** Initialize or adopt an operator-owned Git backup repository. */
export async function initializeGitBackupRepository(params: {
  repositoryPath: string;
  stateDir: string;
  remote?: string;
  gitEnv?: NodeJS.ProcessEnv;
}): Promise<{ repositoryPath: string }> {
  const repositoryPath = path.resolve(params.repositoryPath);
  const stateDir = path.resolve(params.stateDir);
  const [canonicalRepositoryPath, canonicalStateDir] = await Promise.all([
    canonicalPathFromExistingAncestor(repositoryPath),
    canonicalPathFromExistingAncestor(stateDir),
  ]);
  if (
    isPathInside(canonicalStateDir, canonicalRepositoryPath) ||
    isPathInside(canonicalRepositoryPath, canonicalStateDir)
  ) {
    throw new Error(
      `Git backup repository must be outside the OpenClaw state directory: ${stateDir}`,
    );
  }
  try {
    await ensurePrivateSnapshotRepositoryRoot(repositoryPath);
  } catch (error) {
    throw new Error(
      `Git backup repository must be owned by the current user and not writable by other users: ${repositoryPath}. ${gitBackupRepositoryPrivacyRemediation(repositoryPath, error)}`,
      { cause: error },
    );
  }
  const probe = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"], {
    env: params.gitEnv,
  });
  if (probe.code !== 0) {
    await requireGit(repositoryPath, ["init"], { env: params.gitEnv });
  }
  await assertGitRepository(repositoryPath, params.gitEnv);
  const remote = params.remote?.trim();
  if (remote) {
    const existing = await runGit(repositoryPath, ["remote", "get-url", "origin"], {
      env: params.gitEnv,
    });
    if (existing.code === 0 && existing.stdout.trim() !== remote) {
      throw new Error(
        `Git backup repository already has a different origin: ${sanitizeGitBackupDiagnostic(existing.stdout.trim())}`,
      );
    }
    if (existing.code !== 0) {
      await requireGit(repositoryPath, ["remote", "add", "origin", remote], {
        env: params.gitEnv,
      });
    }
  }
  return { repositoryPath };
}

async function isBackupOwnedScope(scopePath: string): Promise<boolean> {
  const identity = await fs
    .lstat(scopePath)
    .catch((error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null,
    );
  if (identity === undefined) {
    return true;
  }
  // Only regular Finder metadata is ignored; a namesake directory or symlink
  // must never be adopted as an empty backup scope and removed.
  if (!identity?.isDirectory() || path.basename(scopePath) === ".DS_Store") {
    return false;
  }
  try {
    const entries = await fs.readdir(scopePath);
    if (entries.length === 0) {
      return true;
    }
    parseGitBackupManifest(
      await fs.readFile(path.join(scopePath, GIT_BACKUP_MANIFEST), "utf8"),
      scopePath,
    );
    return !(await hasNonFinderNamesake(scopePath));
  } catch {
    return false;
  }
}

async function assertBackupOwnedScope(scopePath: string): Promise<void> {
  if (!(await isBackupOwnedScope(scopePath))) {
    throw new Error(
      `Refusing to replace non-backup-owned path ${scopePath}; the repository must be dedicated to OpenClaw backups.`,
    );
  }
}

async function removeStaleAgentScopes(
  repositoryPath: string,
  retainedScopes: Set<string>,
): Promise<void> {
  const agentsPath = path.join(repositoryPath, "agents");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(agentsPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const scopes: string[] = [];
  for (const entry of entries) {
    const scope = path.join(agentsPath, entry.name);
    if (entry.name === ".DS_Store" && entry.isFile() && (await isFinderMetadataFile(scope))) {
      continue;
    }
    scopes.push(scope);
  }
  await Promise.all(scopes.map(async (scope) => await assertBackupOwnedScope(scope)));
  await Promise.all(
    scopes
      .filter((scope) => !retainedScopes.has(path.relative(repositoryPath, scope)))
      .map(async (scope) => await fs.rm(scope, { recursive: true })),
  );
}

async function copyStagedScope(
  stagingRoot: string,
  repositoryPath: string,
  identity: GitBackupIdentity,
): Promise<void> {
  const relative = gitBackupScopePath(identity);
  const source = path.join(stagingRoot, relative);
  const target = path.join(repositoryPath, relative);
  await assertBackupOwnedScope(target);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await fs.cp(source, target, { recursive: true, force: false });
}

async function commitGitBackup(params: {
  repositoryPath: string;
  message: string;
  paths: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const email = await runGit(params.repositoryPath, ["config", "--get", "user.email"], {
    env: params.env,
  });
  const identityArgs =
    email.code === 0 && email.stdout.trim()
      ? []
      : ["-c", "user.name=OpenClaw", "-c", "user.email=backup@openclaw.local"];
  const indexWorkspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-git-backup-index-",
  });
  try {
    // A path-scoped commit re-reads working files, re-adding metadata we only
    // untracked. Build a private index from HEAD plus the selected staged paths
    // so preserved files and unrelated operator staging cannot enter the commit.
    const env = { ...process.env, ...params.env, GIT_INDEX_FILE: indexWorkspace.path("index") };
    const head = await runGit(params.repositoryPath, ["rev-parse", "--verify", "--quiet", "HEAD"], {
      env,
    });
    if (head.code !== 0 && head.code !== 1) {
      requireGitCommandOutput("git rev-parse HEAD", head);
    }
    await requireGit(params.repositoryPath, ["read-tree", head.code === 0 ? "HEAD" : "--empty"], {
      env,
    });
    const selectedPaths = new Set(params.paths);
    const entries = (
      await requireGit(
        params.repositoryPath,
        ["ls-files", "--stage", "-z", "--", ...GIT_BACKUP_SCOPES],
        { env: params.env },
      )
    )
      .split("\0")
      .filter((entry) => selectedPaths.has(entry.slice(entry.indexOf("\t") + 1)));
    if (entries.length > 0) {
      await requireGit(params.repositoryPath, ["update-index", "-z", "--index-info"], {
        env,
        input: entries.join("\0") + "\0",
      });
    }
    const presentPaths = new Set(entries.map((entry) => entry.slice(entry.indexOf("\t") + 1)));
    const deletedPaths = params.paths.filter((file) => !presentPaths.has(file));
    if (deletedPaths.length > 0) {
      await requireGit(params.repositoryPath, ["update-index", "--force-remove", "-z", "--stdin"], {
        env,
        input: deletedPaths.join("\0") + "\0",
      });
    }
    await requireGit(params.repositoryPath, [...identityArgs, "commit", "-m", params.message], {
      env,
    });
  } finally {
    await indexWorkspace.cleanup();
  }
  return await requireGit(params.repositoryPath, ["rev-parse", "HEAD"], { env: params.env });
}

/** Snapshot selected databases, update the deterministic tree, and commit one Git revision. */
export async function createGitBackup(params: {
  repositoryPath: string;
  stateDir: string;
  databases: Array<SnapshotDatabaseRef & { identity: GitBackupIdentity }>;
  all?: boolean;
  excludeSecrets?: boolean;
  push?: boolean;
  now?: Date;
  gitEnv?: NodeJS.ProcessEnv;
}): Promise<GitBackupCreateResult> {
  for (const database of params.databases) {
    assertNotUpdateCapturePath(database.path, params.stateDir);
  }
  const repositoryPath = path.resolve(params.repositoryPath);
  await initializeGitBackupRepository({
    repositoryPath,
    stateDir: params.stateDir,
    gitEnv: params.gitEnv,
  });
  const head = await runGit(repositoryPath, ["rev-parse", "--verify", "--quiet", "HEAD"], {
    env: params.gitEnv,
  });
  if (head.code !== 0 && head.code !== 1) {
    requireGitCommandOutput("git rev-parse HEAD", head);
  }
  const previousMetadata = new Set<string>();
  if (head.code === 0) {
    const entries = (
      await requireGit(
        repositoryPath,
        ["ls-tree", "-r", "-z", head.stdout.trim(), "--", ...GIT_BACKUP_SCOPES],
        {
          env: params.gitEnv,
        },
      )
    )
      .split("\0")
      .filter(Boolean);
    for (const entry of entries) {
      const [attributes = "", file = ""] = entry.split("\t");
      if (!file.endsWith("/.DS_Store")) {
        continue;
      }
      const [mode, type, object = ""] = attributes.split(" ");
      const metadata =
        type === "blob" &&
        (mode === "100644" || mode === "100755") &&
        (await isFinderMetadataBlob(repositoryPath, object, params.gitEnv));
      if (metadata) {
        previousMetadata.add(file);
      } else if (
        params.all ||
        params.databases.some(({ identity }) =>
          file.startsWith(`${gitBackupScopePath(identity).split(path.sep).join("/")}/`),
        )
      ) {
        throw new Error(
          `Refusing to replace non-Finder file in backup history: ${file}; preserve or move it explicitly before refreshing this scope.`,
        );
      }
    }
  }
  const staging = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-git-backup-",
  });
  const manifests: GitBackupManifest[] = [];
  const warnings: string[] = [];
  try {
    for (const [index, database] of params.databases.entries()) {
      const outputPath = path.join(staging.dir, gitBackupScopePath(database.identity));
      await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const copyPath = staging.path(`${database.identity.role}-${index}.sqlite`);
      try {
        await createOpenClawSnapshotCopy({
          database: { ...database, path: await fs.realpath(database.path) },
          targetPath: copyPath,
        });
      } catch (error) {
        if (!params.all || database.identity.role !== "agent") {
          throw error;
        }
        warnings.push(
          `Agent ${database.identity.agentId} degraded; keeping previous backup scope if present: ${sanitizeGitBackupDiagnostic(formatErrorMessage(error))}`,
        );
        continue;
      }
      manifests.push(
        await dumpGitBackupDatabase({
          snapshotPath: copyPath,
          outputPath,
          identity: database.identity,
          excludeSecrets: params.excludeSecrets,
        }),
      );
      await fs.rm(copyPath, { force: true });
    }
    if (manifests.length === 0) {
      throw new Error("No Git backup databases were found for the selected scope.");
    }
    await Promise.all(
      manifests.map(
        async ({ identity }) =>
          await assertBackupOwnedScope(path.join(repositoryPath, gitBackupScopePath(identity))),
      ),
    );
    if (params.all) {
      // Selection is the configured roster, including agents whose snapshot failed.
      await removeStaleAgentScopes(
        repositoryPath,
        new Set(params.databases.map(({ identity }) => gitBackupScopePath(identity))),
      );
    }
    for (const { identity } of manifests) {
      await copyStagedScope(staging.dir, repositoryPath, identity);
    }
  } finally {
    await staging.cleanup().catch(() => undefined);
  }
  // Keep both owned roots present so Git accepts both scoped pathspecs even on a first global-only
  // or agent-only backup. Empty directories remain untracked.
  await Promise.all(
    GIT_BACKUP_SCOPES.map(async (scope) =>
      fs.mkdir(path.join(repositoryPath, scope), { recursive: true, mode: 0o700 }),
    ),
  );
  const backupPaths = [...GIT_BACKUP_SCOPES, ...GIT_BACKUP_METADATA_EXCLUSIONS];
  await requireGit(repositoryPath, ["add", "-A", "--", ...backupPaths], {
    env: params.gitEnv,
  });
  // Untrack regular Finder files from older commits, including at the agents
  // root. Preserve files on disk and metadata staged as a new operator addition.
  const addedPaths = new Set(
    (
      await requireGit(
        repositoryPath,
        ["diff", "--cached", "--diff-filter=A", "--name-only", "-z", "--", ...GIT_BACKUP_SCOPES],
        {
          env: params.gitEnv,
        },
      )
    ).split("\0"),
  );
  const trackedMetadata: string[] = [];
  const metadataEntries = (
    await requireGit(repositoryPath, ["ls-files", "--stage", "-z", "--", ...GIT_BACKUP_SCOPES], {
      env: params.gitEnv,
    })
  )
    .split("\0")
    .filter(
      (entry) =>
        (entry.startsWith("100644 ") || entry.startsWith("100755 ")) && entry.includes(" 0\t"),
    )
    .filter((entry) => {
      const file = entry.slice(entry.indexOf("\t") + 1);
      return previousMetadata.has(file) && !addedPaths.has(file);
    });
  for (const entry of metadataEntries) {
    const file = entry.slice(entry.indexOf("\t") + 1);
    const object = entry.split(" ")[1] ?? "";
    if (await isFinderMetadataBlob(repositoryPath, object, params.gitEnv)) {
      trackedMetadata.push(file);
    }
  }
  if (trackedMetadata.length > 0) {
    await requireGit(
      repositoryPath,
      ["rm", "--cached", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"],
      {
        env: params.gitEnv,
        input: trackedMetadata.map((file) => `:(literal)${file}\0`).join(""),
      },
    );
  }
  const stagedBackupPaths = await requireGit(
    repositoryPath,
    ["diff", "--cached", "--name-only", "-z", "--", ...backupPaths],
    { env: params.gitEnv },
  );
  const deletedMetadata = (
    await requireGit(
      repositoryPath,
      ["diff", "--cached", "--diff-filter=D", "--name-only", "-z", "--", ...GIT_BACKUP_SCOPES],
      {
        env: params.gitEnv,
      },
    )
  )
    .split("\0")
    .filter((file) => previousMetadata.has(file));
  const commitPaths = [...stagedBackupPaths.split("\0").filter(Boolean), ...deletedMetadata];
  let commit: string | undefined;
  if (commitPaths.length > 0) {
    const now = params.now ?? new Date();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Git backup timestamp is invalid.");
    }
    commit = await commitGitBackup({
      repositoryPath,
      message: `openclaw backup ${now.toISOString()}`,
      paths: commitPaths,
      env: params.gitEnv,
    });
  }
  let pushed = false;
  let pushWarning: string | undefined;
  if (params.push) {
    // Staging is path-scoped, but push ships HEAD's full ancestry. A dedicated
    // repository is the supported remote shape.
    const nonBackupCommitCount = await requireGit(
      repositoryPath,
      ["rev-list", "HEAD", "--invert-grep", "--grep=^openclaw backup ", "--count"],
      { env: params.gitEnv },
    );
    if (nonBackupCommitCount !== "0") {
      pushWarning = GIT_BACKUP_NON_BACKUP_HISTORY_WARNING;
    } else {
      const pushedResult = await runGit(repositoryPath, ["push", "-u", "origin", "HEAD"], {
        env: params.gitEnv,
      });
      if (pushedResult.code === 0) {
        pushed = true;
      } else {
        pushWarning = formatGitBackupCommandResult("git push", pushedResult);
      }
    }
  }
  return {
    repositoryPath,
    ...(commit ? { commit } : {}),
    noChanges: commitPaths.length === 0,
    pushed,
    ...(pushWarning ? { pushWarning } : {}),
    manifests,
    warnings,
  };
}

/** Materialize one database scope from a Git ref into a private temporary directory. */
async function materializeGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
}): Promise<{ commit: string; path: string } & AsyncDisposable> {
  const repositoryPath = path.resolve(params.repositoryPath);
  await assertGitRepository(repositoryPath);
  const commit = await requireGit(repositoryPath, [
    "rev-parse",
    "--verify",
    `${params.ref?.trim() || "HEAD"}^{commit}`,
  ]);
  const scope = gitBackupScopePath(params.identity).split(path.sep).join("/");
  const entries = (await requireGit(repositoryPath, ["ls-tree", "-r", "-z", commit, "--", scope]))
    .split("\0")
    .filter(Boolean);
  const files = new Set(entries.map((entry) => entry.slice(entry.indexOf("\t") + 1)));
  const required = new Set([`${scope}/${GIT_BACKUP_MANIFEST}`, `${scope}/${GIT_BACKUP_SCHEMA}`]);
  if ([...required].some((entry) => !files.has(entry))) {
    throw new Error(`Git backup ref ${commit} does not contain ${scope}.`);
  }
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-git-restore-",
  });
  const outputPath = path.join(workspace.dir, scope);
  try {
    for (const entry of entries) {
      const separator = entry.indexOf("\t");
      const file = entry.slice(separator + 1);
      const [mode, type, object = ""] = entry.slice(0, separator).split(" ");
      // Only regular, signature-confirmed metadata at the two directory
      // boundaries is a legacy exception. Never materialize it as table data.
      if (file === `${scope}/.DS_Store` || file === `${scope}/${GIT_BACKUP_TABLES}/.DS_Store`) {
        if (
          type === "blob" &&
          (mode === "100644" || mode === "100755") &&
          (await isFinderMetadataBlob(repositoryPath, object))
        ) {
          continue;
        }
        throw new Error(`Git backup ref contains an unexpected file: ${file}`);
      }
      if (
        file !== `${scope}/${GIT_BACKUP_MANIFEST}` &&
        file !== `${scope}/${GIT_BACKUP_SCHEMA}` &&
        !file.startsWith(`${scope}/${GIT_BACKUP_TABLES}/`)
      ) {
        throw new Error(`Git backup ref contains an unexpected file: ${file}`);
      }
      const relative = file.slice(scope.length + 1);
      const destination = path.join(outputPath, relative);
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fs.writeFile(destination, "", { flag: "wx", mode: 0o600 });
      // Git owns decoding the blob; pipe its bytes into private staging rather
      // than collecting another complete table in the parent process.
      await spawnCommand(["git", "-C", repositoryPath, "show", `${commit}:${file}`], {
        stdin: "ignore",
        stdout: { file: destination },
        buffer: { stdout: false },
        maxBuffer: { stderr: 1024 * 1024 },
        timeout: GIT_TIMEOUT_MS,
      });
    }
    return {
      commit,
      path: outputPath,
      [Symbol.asyncDispose]: workspace[Symbol.asyncDispose],
    };
  } catch (error) {
    await workspace.cleanup().catch(() => undefined);
    throw error;
  }
}

/** Restore one database from a Git ref to a caller-selected fresh path. */
export async function restoreGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
  targetPath: string;
}): Promise<GitBackupRestoreResult & { commit: string }> {
  await using materialized = await materializeGitBackupRef(params);
  return {
    ...(await restoreGitBackupDirectory({
      sourcePath: materialized.path,
      targetPath: params.targetPath,
      expectedIdentity: params.identity,
    })),
    commit: materialized.commit,
  };
}

/** Verify a Git snapshot by restoring it privately and comparing every table digest. */
export async function verifyGitBackupRef(params: {
  repositoryPath: string;
  identity: GitBackupIdentity;
  ref?: string;
}): Promise<GitBackupRestoreResult & { commit: string }> {
  const scratch = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-git-verify-",
  });
  try {
    return await restoreGitBackupRef({
      ...params,
      targetPath: scratch.path("database.sqlite"),
    });
  } finally {
    await scratch.cleanup().catch(() => undefined);
  }
}

/** Return bounded Git backup log entries for CLI rendering. */
export async function readGitBackupLog(params: {
  repositoryPath: string;
  limit: number;
}): Promise<Array<{ commit: string; date: string; message: string }>> {
  await assertGitRepository(params.repositoryPath);
  const symbolicHead = await runGit(params.repositoryPath, ["symbolic-ref", "--quiet", "HEAD"]);
  if (symbolicHead.code === 0) {
    const headRef = symbolicHead.stdout.trim();
    const headExists = await runGit(params.repositoryPath, [
      "show-ref",
      "--verify",
      "--quiet",
      headRef,
    ]);
    if (headExists.code === 1 && headRef.startsWith("refs/heads/")) {
      return [];
    }
    if (headExists.code !== 0) {
      throw new Error(formatGitBackupCommandResult("git show-ref HEAD", headExists));
    }
  } else if (symbolicHead.code !== 1) {
    throw new Error(formatGitBackupCommandResult("git symbolic-ref HEAD", symbolicHead));
  }
  const result = await runGit(params.repositoryPath, [
    "log",
    `--max-count=${params.limit}`,
    "--pretty=format:%H%x09%cI%x09%s",
  ]);
  return requireGitCommandOutput(
    "git log",
    result,
    (command, failure) => new Error(formatGitBackupCommandResult(command, failure)),
  )
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [commit = "", date = "", ...message] = line.split("\t");
      return { commit, date, message: message.join("\t") };
    });
}
