import fs from "node:fs/promises";
import path from "node:path";
import { tempWorkspace, type TempWorkspace } from "@openclaw/fs-safe/temp";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { preparePostgresBackupDiscovery } from "../infra/backup-database-discovery.js";
import { discoverBackupDatabasePaths } from "../infra/backup-sqlite-snapshot.js";
import {
  listDatabaseEngineStores,
  selectDatabaseEngine,
} from "../infra/database-engine/registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { canonicalPathFromExistingAncestor, isPathInside } from "../infra/fs-safe.js";
import {
  GIT_TIMEOUT_MS,
  executeGitCommand as runGit,
  normalizeGitPathForFilesystem,
  requireGitCommand as requireGit,
  requireGitCommandOutput,
} from "../infra/git-exec.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { assertNotUpdateCapturePath } from "../infra/update-capture-paths.js";
import { formatCommandOutput, formatCommandResult } from "../process/command-error.js";
import { spawnCommand } from "../process/exec-spawn.js";
import { defaultRuntime } from "../runtime.js";
import { BACKUP_RUN_ERROR_MAX_LENGTH } from "../state/backup-run-records.contract.js";
import { readBackupEngine, readPostgresBackupFamily } from "./database-backup.js";
import {
  applyScopeUpdate,
  gitBackupArtifactFiles,
  prepareScopeUpdate,
  prepareStaleScopeUpdates,
  readGitBackupRepositoryState,
  type GitBackupScopeUpdate,
} from "./git-backup-artifacts.js";
import {
  GIT_BACKUP_MANIFEST,
  dumpGitBackupDatabase,
  gitBackupScopePath,
  parseGitBackupManifest,
  restoreGitBackupDirectory,
  type GitBackupIdentity,
  type GitBackupManifest,
  type GitBackupRestoreResult,
} from "./git-backup-codec.js";
import {
  createLocalSnapshotProvider,
  ensurePrivateSnapshotRepositoryRoot,
} from "./local-repository.js";
import { createOpenClawSnapshotCopy } from "./openclaw-snapshot-copy.js";
import type { SnapshotDatabaseRef } from "./snapshot-provider.js";

const GIT_BACKUP_DIAGNOSTIC_MAX_LENGTH = 500;
const GIT_BACKUP_NON_BACKUP_HISTORY_WARNING =
  "repository history contains non-backup commits; use a dedicated backup repository";

function gitBackupContentTimeout(bytes: number): number {
  // Allow 1 MiB/s for local content work, bounded to stop wedged Git processes.
  return Math.min(
    24 * 60 * 60 * 1000,
    Math.max(GIT_TIMEOUT_MS, Math.ceil(bytes / 1024 ** 2) * 1000),
  );
}

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

async function cleanupGitBackupWorkspace(workspace: TempWorkspace): Promise<void> {
  let issue: string;
  try {
    const result = await workspace.cleanup();
    if (result === "removed" || result === "missing") {
      return;
    }
    issue = result;
  } catch (error) {
    issue = formatErrorMessage(error);
  }
  defaultRuntime.error(
    `Warning: Git backup temporary files may remain under ${path.dirname(workspace.dir)}; cleanup failed: ${sanitizeGitBackupDiagnostic(issue)}`,
  );
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

async function assertGitRepository(repositoryPath: string): Promise<void> {
  const topLevel = await requireGit(repositoryPath, ["rev-parse", "--show-toplevel"]);
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
  const probe = await runGit(repositoryPath, ["rev-parse", "--show-toplevel"]);
  if (probe.code !== 0) {
    await requireGit(repositoryPath, ["init"]);
  }
  await assertGitRepository(repositoryPath);
  const remote = params.remote?.trim();
  if (remote) {
    const existing = await runGit(repositoryPath, ["remote", "get-url", "origin"]);
    if (existing.code === 0 && existing.stdout.trim() !== remote) {
      throw new Error(
        `Git backup repository already has a different origin: ${sanitizeGitBackupDiagnostic(existing.stdout.trim())}`,
      );
    }
    if (existing.code !== 0) {
      await requireGit(repositoryPath, ["remote", "add", "origin", remote]);
    }
  }
  return { repositoryPath };
}

async function commitGitBackup(params: {
  repositoryPath: string;
  head?: string;
  paths: string[];
}): Promise<string | undefined> {
  let bytes = 0;
  for (const file of params.paths) {
    bytes += (await lstatIfExists(path.join(params.repositoryPath, file)))?.size ?? 0;
  }
  const indexWorkspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-git-backup-index-",
  });
  try {
    // Overlay only owned artifacts on HEAD. Never read unrelated operator staging
    // into a backup commit, including extras nested inside a selected scope.
    const env = { ...process.env, GIT_INDEX_FILE: indexWorkspace.path("index") };
    const head = await runGit(params.repositoryPath, ["rev-parse", "--verify", "--quiet", "HEAD"], {
      env,
    });
    if (head.code !== 0 && head.code !== 1) {
      requireGitCommandOutput("git rev-parse HEAD", head);
    }
    if ((head.code === 0 ? head.stdout.trim() : undefined) !== params.head) {
      throw new Error("Git backup repository HEAD changed during the snapshot; retry the backup.");
    }
    await requireGit(params.repositoryPath, ["read-tree", params.head ?? "--empty"], {
      env,
    });
    await requireGit(
      params.repositoryPath,
      ["update-index", "--add", "--remove", "-z", "--stdin"],
      {
        env,
        input: params.paths.join("\0") + "\0",
        timeoutMs: gitBackupContentTimeout(bytes),
      },
    );
    const changed = await runGit(params.repositoryPath, ["diff", "--cached", "--quiet"], { env });
    if (changed.code === 0) {
      return undefined;
    }
    if (changed.code !== 1) {
      requireGitCommandOutput("git diff --cached", changed);
    }
    const email = await runGit(params.repositoryPath, ["config", "--get", "user.email"]);
    const identityArgs =
      email.code === 0 && email.stdout.trim()
        ? []
        : ["-c", "user.name=OpenClaw", "-c", "user.email=backup@openclaw.local"];
    await requireGit(
      params.repositoryPath,
      [...identityArgs, "commit", "-m", `openclaw backup ${new Date().toISOString()}`],
      { env },
    );
    // Converge only the managed entries in the ordinary index; preserved extras
    // retain their exact staged blobs and modes across the private-index commit.
    await requireGit(
      params.repositoryPath,
      ["reset", "--quiet", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { input: params.paths.map((file) => `:(literal)${file}\0`).join("") },
    );
    return await requireGit(params.repositoryPath, ["rev-parse", "HEAD"]);
  } finally {
    await cleanupGitBackupWorkspace(indexWorkspace);
  }
}

/** Snapshot selected databases, update the deterministic tree, and commit one Git revision. */
export async function createGitBackup(params: {
  repositoryPath: string;
  stateDir: string;
  databases: Array<SnapshotDatabaseRef & { identity: GitBackupIdentity }>;
  all?: boolean;
  excludeSecrets?: boolean;
  push?: boolean;
}): Promise<GitBackupCreateResult> {
  const databases = [...params.databases];
  if (params.all) {
    const { captureRuntimeConfigAsyncReader } = await import("../config/io.js");
    const config = await captureRuntimeConfigAsyncReader({ skipPluginValidation: true })();
    const postgres = listDatabaseEngineStores().some(
      (store) => selectDatabaseEngine(store, config) === "postgres",
    );
    const discovery = postgres
      ? await preparePostgresBackupDiscovery({ stateDir: params.stateDir, config })
      : {
          paths: await discoverBackupDatabasePaths({ stateDir: params.stateDir, config }),
          resources: [],
        };
    for (const file of discovery.paths) {
      if (
        !databases.some((database) => database.path === file) &&
        readBackupEngine(file).engine === "postgres"
      ) {
        const family = await readPostgresBackupFamily(file, config);
        const resource = discovery.resources
          .filter((entry) => entry.family === family && isPathInside(entry.path, file))
          .toSorted((left, right) => right.path.length - left.path.length)[0];
        const primary =
          resource?.path === file &&
          resource.pluginId === family &&
          discovery.resources.filter(
            (entry) => entry.family === family && entry.path.endsWith(".sqlite"),
          ).length === 1;
        // Resource-relative identity survives moving the state directory, including
        // multiple Matrix account/token roots backed by the shared-state family.
        const resourcePath = path.relative(params.stateDir, file).split(path.sep).join("/");
        const resourceId = resource?.pluginId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
        const id = primary
          ? family
          : `${family}${resourceId ? `__${resourceId}` : ""}__${sha256Hex(resourcePath)}`;
        databases.push({ path: file, identity: { role: "generic", id } });
      }
    }
  }
  const scopes = new Set<string>();
  for (const database of databases) {
    assertNotUpdateCapturePath(database.path, params.stateDir);
    const scope = gitBackupScopePath(database.identity);
    if (scopes.has(scope)) {
      throw new Error(`Multiple backup databases use the same Git scope: ${scope}`);
    }
    scopes.add(scope);
  }
  const repositoryPath = path.resolve(params.repositoryPath);
  await initializeGitBackupRepository({
    repositoryPath,
    stateDir: params.stateDir,
  });
  const repositoryState = await readGitBackupRepositoryState(repositoryPath);
  const staging = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-git-backup-",
  });
  const manifests: GitBackupManifest[] = [];
  const warnings: string[] = [];
  const updates: GitBackupScopeUpdate[] = [];
  try {
    for (const [index, database] of databases.entries()) {
      const outputPath = path.join(staging.dir, gitBackupScopePath(database.identity));
      await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
      const copyPath = staging.path(`${database.identity.role}-${index}.sqlite`);
      try {
        const postgres = readBackupEngine(database.path).engine === "postgres";
        if (!postgres) {
          await createOpenClawSnapshotCopy({
            database: { ...database, path: await fs.realpath(database.path) },
            targetPath: copyPath,
          });
        }
        manifests.push(
          await dumpGitBackupDatabase({
            snapshotPath: postgres ? database.path : copyPath,
            outputPath,
            identity: database.identity,
            physicalEngine: postgres ? "postgres" : "sqlite",
            excludeSecrets: params.excludeSecrets,
          }),
        );
      } catch (error) {
        if (!params.all || database.identity.role !== "agent") {
          throw error;
        }
        warnings.push(
          `Agent ${database.identity.agentId} degraded; keeping previous backup scope if present: ${sanitizeGitBackupDiagnostic(formatErrorMessage(error))}`,
        );
        continue;
      }
      await fs.rm(copyPath, { force: true });
    }
    if (manifests.length === 0) {
      throw new Error("No Git backup databases were found for the selected scope.");
    }
    for (const manifest of manifests) {
      const update = await prepareScopeUpdate(
        repositoryPath,
        gitBackupScopePath(manifest.identity),
        repositoryState,
        manifest,
      );
      if (update) {
        updates.push(update);
      }
    }
    if (params.all) {
      // Retain every selected store, including configured agents whose snapshot failed.
      updates.push(...(await prepareStaleScopeUpdates(repositoryPath, scopes, repositoryState)));
    }
    for (const update of updates) {
      await applyScopeUpdate(staging.dir, repositoryPath, update);
    }
  } finally {
    await cleanupGitBackupWorkspace(staging);
  }
  const commit = await commitGitBackup({
    repositoryPath,
    head: repositoryState.head,
    paths: [
      ...new Set(
        updates.flatMap(({ relative, previousFiles, files }) =>
          [...previousFiles, ...files].map((file) =>
            path.join(relative, file).split(path.sep).join("/"),
          ),
        ),
      ),
    ],
  });
  let pushed = false;
  let pushWarning: string | undefined;
  if (params.push) {
    // Staging is path-scoped, but push ships HEAD's full ancestry. A dedicated
    // repository is the supported remote shape.
    const nonBackupCommitCount = await requireGit(repositoryPath, [
      "rev-list",
      "HEAD",
      "--invert-grep",
      "--grep=^openclaw backup ",
      "--count",
    ]);
    if (nonBackupCommitCount !== "0") {
      pushWarning = GIT_BACKUP_NON_BACKUP_HISTORY_WARNING;
    } else {
      const pushedResult = await runGit(repositoryPath, ["push", "-u", "origin", "HEAD"]);
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
    noChanges: !commit,
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
}): Promise<{ commit: string; path: string; manifest: GitBackupManifest } & AsyncDisposable> {
  const repositoryPath = path.resolve(params.repositoryPath);
  await assertGitRepository(repositoryPath);
  const commit = await requireGit(repositoryPath, [
    "rev-parse",
    "--verify",
    `${params.ref?.trim() || "HEAD"}^{commit}`,
  ]);
  const scope = gitBackupScopePath(params.identity).split(path.sep).join("/");
  const entries = (
    await requireGit(repositoryPath, ["ls-tree", "-r", "-l", "-z", commit, "--", scope])
  )
    .split("\0")
    .filter(Boolean);
  const files = new Map(entries.map((entry) => [entry.slice(entry.indexOf("\t") + 1), entry]));
  const assertRegularArtifact = (file: string) => {
    const entry = files.get(file);
    if (!entry) {
      throw new Error(`Git backup ref ${commit} does not contain ${file}.`);
    }
    if (!entry.startsWith("100644 blob ") && !entry.startsWith("100755 blob ")) {
      throw new Error(`Git backup ref contains a non-regular artifact: ${file}`);
    }
    return Number(entry.slice(0, entry.indexOf("\t")).trim().split(/\s+/).at(-1));
  };
  const manifestPath = `${scope}/${GIT_BACKUP_MANIFEST}`;
  assertRegularArtifact(manifestPath);
  const manifest = parseGitBackupManifest(
    await requireGit(repositoryPath, ["show", `${commit}:${manifestPath}`]),
    manifestPath,
  );
  const artifacts = gitBackupArtifactFiles(manifest).map((file) => {
    const gitPath = `${scope}/${file.split(path.sep).join("/")}`;
    return { file: gitPath, timeout: gitBackupContentTimeout(assertRegularArtifact(gitPath)) };
  });
  const workspace = await tempWorkspace({
    rootDir: resolvePreferredOpenClawTmpDir(),
    prefix: "openclaw-git-restore-",
  });
  const outputPath = path.join(workspace.dir, scope);
  try {
    // A ref may contain unrelated documents or filesystem metadata. Only the
    // manifest's artifacts enter restore staging and database verification.
    for (const { file, timeout } of artifacts) {
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
        timeout,
      });
    }
    return {
      commit,
      path: outputPath,
      manifest,
      [Symbol.asyncDispose]: async () => await cleanupGitBackupWorkspace(workspace),
    };
  } catch (error) {
    await cleanupGitBackupWorkspace(workspace);
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

/** Verify PostgreSQL's matched artifacts or SQLite's private round-trip table digests. */
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
    await using materialized = await materializeGitBackupRef(params);
    const { manifest } = materialized;
    if (gitBackupScopePath(manifest.identity) !== gitBackupScopePath(params.identity)) {
      throw new Error("Git backup manifest database identity does not match the requested scope.");
    }
    const targetPath = scratch.path("database.sqlite");
    if (manifest.schemaVersion === 2) {
      await createLocalSnapshotProvider({
        repositoryPath: materialized.path,
        expectedPostgresSource: manifest.postgresSource,
      }).verify({ path: path.join(materialized.path, "postgres") });
      return {
        manifest,
        targetPath,
        tables: [],
        excludedTables: manifest.excludedTables,
        excludedConfigStateKeyPrefixes: manifest.excludedConfigStateKeyPrefixes,
        commit: materialized.commit,
      };
    }
    return {
      ...(await restoreGitBackupDirectory({
        sourcePath: materialized.path,
        targetPath,
        expectedIdentity: params.identity,
      })),
      commit: materialized.commit,
    };
  } finally {
    await cleanupGitBackupWorkspace(scratch);
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
