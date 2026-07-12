import { randomUUID } from "node:crypto";
import fsSync, { type Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { loadSqliteVecExtension } from "../../packages/memory-host-sdk/src/engine-storage.js";
import { sameFileIdentity } from "../infra/fs-safe-advanced.js";
import {
  canonicalPathFromExistingAncestor,
  ensureAbsoluteDirectory,
  isPathInside,
} from "../infra/fs-safe.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  createVerifiedSqliteSnapshot,
  publishVerifiedSqliteFile,
  syncDirectoryBestEffort,
  type SqliteSnapshotValidator,
} from "../infra/sqlite-snapshot.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "../state/openclaw-agent-db.js";
import { assertOpenClawStateDatabaseForMaintenance } from "../state/openclaw-state-db.js";
import {
  containsAsciiControlCharacter,
  copySnapshotArtifact,
  hashSnapshotArtifact,
  readSnapshotManifest,
  type SnapshotArtifactDigest,
  writeSnapshotManifest,
} from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotDatabaseIdentity,
  type SnapshotDatabaseManifest,
  type SnapshotDatabaseRef,
  type SnapshotManifest,
  type SnapshotRef,
  type SnapshotResult,
  type SnapshotSummary,
  type SnapshotVerificationResult,
  type SqliteSnapshotProvider,
} from "./snapshot-provider.js";

const SNAPSHOT_DIRECTORY_MODE = 0o700;
const SNAPSHOT_FILE_MODE = 0o600;
const SNAPSHOT_ID_BASENAME_MAX_LENGTH = 80;
const SNAPSHOT_PENDING_FILENAME = ".pending";
const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;
const SNAPSHOT_ARTIFACT_ENTRIES = new Set([
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_PENDING_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
]);
const RESTORE_STAGING_ENTRIES = new Set([SNAPSHOT_SQLITE_FILENAME]);

export type LocalSqliteSnapshotProviderOptions = {
  readonly repositoryPath: string;
  readonly now?: () => Date;
};

export function createLocalSqliteSnapshotProvider(
  options: LocalSqliteSnapshotProviderOptions,
): SqliteSnapshotProvider {
  return new LocalSqliteSnapshotProvider(options);
}

class LocalSqliteSnapshotProvider implements SqliteSnapshotProvider {
  readonly #repositoryPath: string;
  readonly #now: () => Date;

  constructor(options: LocalSqliteSnapshotProviderOptions) {
    this.#repositoryPath = path.resolve(options.repositoryPath);
    this.#now = options.now ?? (() => new Date());
  }

  async create(database: SnapshotDatabaseRef): Promise<SnapshotResult> {
    await ensurePrivateDirectory(this.#repositoryPath, "SQLite snapshot repository");
    const sourcePath = path.resolve(database.path);
    const identity = normalizeSnapshotIdentity(database.identity);
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("SQLite snapshot timestamp is invalid.");
    }
    const snapshotId = buildSnapshotId(now, sourcePath);
    const snapshotDir = path.join(this.#repositoryPath, snapshotId);
    const stagingDir = path.join(this.#repositoryPath, `.tmp-${snapshotId}-${randomUUID()}`);
    const artifactPath = path.join(stagingDir, SNAPSHOT_SQLITE_FILENAME);
    await fs.mkdir(stagingDir, { mode: SNAPSHOT_DIRECTORY_MODE });

    let stagingIdentity: Stats | undefined;
    let publishedDirectory: FileHandle | undefined;
    let publishedIdentity: Stats | undefined;
    const publishedEntries = new Map<string, Stats>();
    let snapshotDirectoryCreated = false;
    try {
      stagingIdentity = await fs.lstat(stagingDir);
      applyPrivateModeSync(stagingDir, SNAPSHOT_DIRECTORY_MODE);
      const result = await createVerifiedSqliteSnapshot({
        sourcePath,
        targetPath: artifactPath,
        transform: identity.role === "global" ? sanitizeGlobalStateSnapshot : undefined,
        validate: buildDatabaseValidator(identity),
      });
      applyPrivateModeSync(artifactPath, SNAPSHOT_FILE_MODE);
      const artifact = await hashSnapshotArtifact(stagingDir);
      const manifest: SnapshotManifest = {
        schemaVersion: 1,
        snapshotId,
        createdAt: now.toISOString(),
        database: buildDatabaseManifest(identity, sourcePath, result.userVersion),
        artifact: {
          path: SNAPSHOT_SQLITE_FILENAME,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
        },
      };
      await writeSnapshotManifest(stagingDir, manifest);
      applyPrivateModeSync(path.join(stagingDir, SNAPSHOT_MANIFEST_FILENAME), SNAPSHOT_FILE_MODE);
      await readSnapshotManifest(stagingDir, snapshotId);
      await syncDirectoryBestEffort(stagingDir);

      try {
        await fs.mkdir(snapshotDir, { mode: SNAPSHOT_DIRECTORY_MODE });
        snapshotDirectoryCreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`SQLite snapshot directory already exists: ${snapshotDir}`, {
            cause: error,
          });
        }
        throw error;
      }
      publishedIdentity = await fs.lstat(snapshotDir);
      applyPrivateModeSync(snapshotDir, SNAPSHOT_DIRECTORY_MODE);
      publishedDirectory = await fs.open(snapshotDir, "r");
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      const pendingPath = path.join(snapshotDir, SNAPSHOT_PENDING_FILENAME);
      await fs.writeFile(pendingPath, "", {
        flag: "wx",
        mode: SNAPSHOT_FILE_MODE,
      });
      publishedEntries.set(SNAPSHOT_PENDING_FILENAME, await fs.lstat(pendingPath));
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      await publishSnapshotEntryNoOverwrite(
        path.join(stagingDir, SNAPSHOT_SQLITE_FILENAME),
        path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME),
        SNAPSHOT_SQLITE_FILENAME,
        publishedEntries,
      );
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      await publishSnapshotEntryNoOverwrite(
        path.join(stagingDir, SNAPSHOT_MANIFEST_FILENAME),
        path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME),
        SNAPSHOT_MANIFEST_FILENAME,
        publishedEntries,
      );
      await assertOpenDirectoryIdentity(publishedDirectory, snapshotDir, publishedIdentity);
      await syncDirectoryBestEffort(snapshotDir);
      await assertPendingSnapshotContents(snapshotDir);
      const publishedManifest = await readSnapshotManifest(snapshotDir, snapshotId);
      if (!isDeepStrictEqual(publishedManifest, manifest)) {
        throw new Error(`SQLite snapshot manifest changed during publication: ${snapshotDir}`);
      }
      const publishedArtifact = await hashSnapshotArtifact(snapshotDir);
      const publishedArtifactPath = path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME);
      assertArtifactMatchesManifest(publishedArtifactPath, publishedArtifact, publishedManifest);
      await verifySnapshotDatabaseFile(
        publishedArtifactPath,
        publishedArtifact.stat,
        publishedManifest,
      );
      const expectedPendingIdentity = publishedEntries.get(SNAPSHOT_PENDING_FILENAME);
      const currentPendingIdentity = fsSync.lstatSync(pendingPath);
      if (
        !expectedPendingIdentity ||
        !sameFileIdentity(expectedPendingIdentity, currentPendingIdentity)
      ) {
        throw new Error(`SQLite snapshot pending marker changed: ${pendingPath}`);
      }
      fsSync.unlinkSync(pendingPath);
      publishedEntries.delete(SNAPSHOT_PENDING_FILENAME);
      await syncDirectoryBestEffort(snapshotDir);
      await publishedDirectory.close();
      publishedDirectory = undefined;
      const committedManifest = await readSnapshotManifest(snapshotDir, snapshotId);
      if (!isDeepStrictEqual(committedManifest, manifest)) {
        throw new Error(`SQLite snapshot manifest changed after commit: ${snapshotDir}`);
      }
      const committedArtifact = await hashSnapshotArtifact(snapshotDir);
      assertArtifactMatchesManifest(
        path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME),
        committedArtifact,
        committedManifest,
      );
      const currentIdentity = await fs.lstat(snapshotDir);
      if (!sameFileIdentity(publishedIdentity, currentIdentity)) {
        throw new Error(`SQLite snapshot directory changed during publication: ${snapshotDir}`);
      }
      await assertExactSnapshotContents(snapshotDir);
      await syncDirectoryBestEffort(this.#repositoryPath);
      return { ref: { path: snapshotDir }, manifest };
    } catch (error) {
      await publishedDirectory?.close().catch(() => undefined);
      publishedDirectory = undefined;
      if (snapshotDirectoryCreated) {
        publishedIdentity ??= await fs.lstat(snapshotDir).catch(() => undefined);
      }
      if (publishedIdentity) {
        const removed = await removePublishedSnapshotDirectoryIfOwned(
          snapshotDir,
          publishedIdentity,
          publishedEntries,
        );
        if (removed) {
          await syncDirectoryBestEffort(this.#repositoryPath);
        }
      }
      throw error;
    } finally {
      const removed = stagingIdentity
        ? await removePrivateDirectoryIfOwned(
            stagingDir,
            stagingIdentity,
            SNAPSHOT_ARTIFACT_ENTRIES,
          ).catch(() => false)
        : await fs
            .rmdir(stagingDir)
            .then(() => true)
            .catch(() => false);
      if (removed) {
        await syncDirectoryBestEffort(this.#repositoryPath).catch(() => undefined);
      }
    }
  }

  async verify(snapshot: SnapshotRef): Promise<SnapshotVerificationResult> {
    const snapshotDir = await this.#resolveSnapshotDirectory(snapshot);
    const manifest = await readVerifiedSnapshotManifest(snapshotDir);
    const artifact = await hashSnapshotArtifact(snapshotDir);
    const artifactPath = path.join(snapshotDir, SNAPSHOT_SQLITE_FILENAME);
    assertArtifactMatchesManifest(artifactPath, artifact, manifest);
    await verifySnapshotDatabaseFile(artifactPath, artifact.stat, manifest);
    await assertExactSnapshotContents(snapshotDir);
    return { ok: true, manifest };
  }

  async restoreFresh(
    snapshot: SnapshotRef,
    targetPath: string,
  ): Promise<SnapshotVerificationResult> {
    const snapshotDir = await this.#resolveSnapshotDirectory(snapshot);
    const manifest = await readVerifiedSnapshotManifest(snapshotDir);
    const resolvedTargetPath = path.resolve(targetPath);
    const canonicalRepositoryPath = await fs.realpath(this.#repositoryPath);
    const canonicalTargetPath = await canonicalPathFromExistingAncestor(resolvedTargetPath);
    if (isPathInside(canonicalRepositoryPath, canonicalTargetPath)) {
      throw new Error(
        `SQLite restore target must be outside snapshot repository ${this.#repositoryPath}: ${resolvedTargetPath}`,
      );
    }
    const restoreParentPath = path.dirname(resolvedTargetPath);
    await ensureRestoreParentDirectory(restoreParentPath);
    const restoreParentIdentity = await fs.lstat(restoreParentPath);
    applyPrivateModeSync(this.#repositoryPath, SNAPSHOT_DIRECTORY_MODE);
    // Existing databases need a crash-recoverable main/WAL/SHM swap protocol.
    // This path is deliberately fresh-only and refuses every preexisting sidecar.
    await assertFreshRestorePathsAbsent(resolvedTargetPath);

    const stagingDir = await fs.mkdtemp(path.join(this.#repositoryPath, ".tmp-restore-"));
    const stagedSourcePath = path.join(stagingDir, SNAPSHOT_SQLITE_FILENAME);
    let stagingIdentity: Stats | undefined;
    try {
      stagingIdentity = await fs.lstat(stagingDir);
      applyPrivateModeSync(stagingDir, SNAPSHOT_DIRECTORY_MODE);
      const stagedArtifact = await copySnapshotArtifact(snapshotDir, stagedSourcePath);
      await assertDirectoryIdentity(stagingDir, stagingIdentity);
      assertArtifactMatchesManifest(stagedSourcePath, stagedArtifact, manifest);
      await assertExactSnapshotContents(snapshotDir);
      await verifySnapshotDatabaseFile(stagedSourcePath, stagedArtifact.stat, manifest);
      await publishVerifiedSqliteFile({
        sourceIdentity: stagedArtifact.stat,
        sourcePath: stagedSourcePath,
        targetPath: resolvedTargetPath,
        expectedContent: manifest.artifact,
        requireAtomicPublication: true,
        beforePublish: async () => {
          await assertDirectoryIdentity(restoreParentPath, restoreParentIdentity);
          await assertFreshRestorePathsAbsent(resolvedTargetPath);
        },
        afterPublish: (guard) => {
          guard.assertTargetMatchesExpectedContent(() => {
            assertDirectoryIdentitySync(restoreParentPath, restoreParentIdentity);
            assertNoSqliteSidecarsSync(resolvedTargetPath);
          });
        },
      });
      return { ok: true, manifest };
    } finally {
      const removed = stagingIdentity
        ? await removePrivateDirectoryIfOwned(
            stagingDir,
            stagingIdentity,
            RESTORE_STAGING_ENTRIES,
          ).catch(() => false)
        : await fs
            .rmdir(stagingDir)
            .then(() => true)
            .catch(() => false);
      if (removed) {
        await syncDirectoryBestEffort(this.#repositoryPath).catch(() => undefined);
      }
    }
  }

  async list(): Promise<SnapshotSummary[]> {
    const repositoryStat = await lstatIfExists(this.#repositoryPath);
    if (!repositoryStat) {
      return [];
    }
    assertDirectory(repositoryStat, this.#repositoryPath, "SQLite snapshot repository");
    applyPrivateModeSync(this.#repositoryPath, SNAPSHOT_DIRECTORY_MODE);

    const entries = await fs.readdir(this.#repositoryPath, { withFileTypes: true });
    const snapshots: SnapshotSummary[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".tmp-")) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          throw new Error(
            `SQLite snapshot repository contains unsafe staging entry: ${path.join(this.#repositoryPath, entry.name)}`,
          );
        }
        continue;
      }
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `SQLite snapshot repository contains unexpected entry: ${path.join(this.#repositoryPath, entry.name)}`,
        );
      }
      const snapshotPath = path.join(this.#repositoryPath, entry.name);
      if (await isIncompleteSnapshotDirectory(snapshotPath)) {
        continue;
      }
      await assertExactSnapshotContents(snapshotPath);
      snapshots.push({
        ref: { path: snapshotPath },
        manifest: await readSnapshotManifest(snapshotPath),
      });
    }
    return snapshots.toSorted(
      (left, right) =>
        right.manifest.createdAt.localeCompare(left.manifest.createdAt) ||
        right.manifest.snapshotId.localeCompare(left.manifest.snapshotId),
    );
  }

  async #resolveSnapshotDirectory(snapshot: SnapshotRef): Promise<string> {
    const snapshotDir = path.resolve(snapshot.path);
    if (path.dirname(snapshotDir) !== this.#repositoryPath) {
      throw new Error(
        `SQLite snapshot must be an immediate child of repository ${this.#repositoryPath}: ${snapshotDir}`,
      );
    }
    const repositoryStat = await fs.lstat(this.#repositoryPath);
    assertDirectory(repositoryStat, this.#repositoryPath, "SQLite snapshot repository");
    const snapshotStat = await fs.lstat(snapshotDir);
    assertDirectory(snapshotStat, snapshotDir, "SQLite snapshot");
    return snapshotDir;
  }
}

async function readVerifiedSnapshotManifest(snapshotDir: string): Promise<SnapshotManifest> {
  await assertExactSnapshotContents(snapshotDir);
  return await readSnapshotManifest(snapshotDir);
}

function assertArtifactMatchesManifest(
  artifactPath: string,
  artifact: SnapshotArtifactDigest,
  manifest: SnapshotManifest,
): void {
  if (artifact.sizeBytes !== manifest.artifact.sizeBytes) {
    throw new Error(
      `Snapshot artifact size mismatch for ${artifactPath}: expected ${manifest.artifact.sizeBytes}, got ${artifact.sizeBytes}`,
    );
  }
  if (artifact.sha256 !== manifest.artifact.sha256) {
    throw new Error(
      `Snapshot artifact hash mismatch for ${artifactPath}: expected ${manifest.artifact.sha256}, got ${artifact.sha256}`,
    );
  }
}

async function verifySnapshotDatabaseFile(
  artifactPath: string,
  expectedIdentity: Stats,
  manifest: SnapshotManifest,
): Promise<void> {
  const beforeOpen = await fs.lstat(artifactPath);
  if (
    beforeOpen.isSymbolicLink() ||
    !beforeOpen.isFile() ||
    beforeOpen.nlink > 1 ||
    !sameFileIdentity(expectedIdentity, beforeOpen)
  ) {
    throw new Error(`Snapshot artifact changed before SQLite verification: ${artifactPath}`);
  }

  const validationDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-verify-"));
  const validationPath = path.join(validationDir, SNAPSHOT_SQLITE_FILENAME);
  try {
    await fs.chmod(validationDir, SNAPSHOT_DIRECTORY_MODE);
    const validationArtifact = await copySnapshotArtifact(
      path.dirname(artifactPath),
      validationPath,
    );
    assertArtifactMatchesManifest(validationPath, validationArtifact, manifest);
    const sqlite = requireNodeSqlite();
    const database = new sqlite.DatabaseSync(validationPath, {
      allowExtension: true,
      readOnly: true,
    });
    try {
      database.exec("PRAGMA busy_timeout = 30000; PRAGMA trusted_schema = OFF;");
      await loadSqliteVecExtension({ db: database });
      assertSqliteIntegrity(database, artifactPath);
      buildManifestDatabaseValidator(manifest.database)(database, artifactPath);
    } finally {
      database.close();
    }
    const validatedArtifact = await hashSnapshotArtifact(validationDir);
    if (!sameFileIdentity(validationArtifact.stat, validatedArtifact.stat)) {
      throw new Error(`Snapshot validation copy changed: ${validationPath}`);
    }
    assertArtifactMatchesManifest(validationPath, validatedArtifact, manifest);
  } finally {
    await fs.unlink(validationPath).catch(() => undefined);
    await fs.rmdir(validationDir).catch(() => undefined);
  }
  const afterOpen = await fs.lstat(artifactPath);
  if (
    afterOpen.isSymbolicLink() ||
    !afterOpen.isFile() ||
    afterOpen.nlink > 1 ||
    !sameFileIdentity(expectedIdentity, afterOpen)
  ) {
    throw new Error(`Snapshot artifact changed during SQLite verification: ${artifactPath}`);
  }
  const verifiedArtifact = await hashSnapshotArtifact(path.dirname(artifactPath));
  if (!sameFileIdentity(expectedIdentity, verifiedArtifact.stat)) {
    throw new Error(`Snapshot artifact changed after SQLite verification: ${artifactPath}`);
  }
  assertArtifactMatchesManifest(artifactPath, verifiedArtifact, manifest);
}

function normalizeSnapshotIdentity(identity: SnapshotDatabaseIdentity): SnapshotDatabaseIdentity {
  if (identity.role === "global") {
    return identity;
  }
  if (identity.role === "agent") {
    const agentId = normalizeAgentId(identity.agentId);
    if (!isValidAgentId(identity.agentId) || agentId !== identity.agentId) {
      throw new Error(`SQLite snapshot agent id must be canonical: ${identity.agentId}`);
    }
    return { role: "agent", agentId };
  }
  const id = identity.id.trim();
  if (!id || id !== identity.id || id.length > 256 || containsAsciiControlCharacter(id)) {
    throw new Error("SQLite snapshot generic database id is invalid.");
  }
  return { role: "generic", id };
}

function buildDatabaseManifest(
  identity: SnapshotDatabaseIdentity,
  sourcePath: string,
  userVersion: number,
): SnapshotDatabaseManifest {
  const basename = path.basename(sourcePath);
  if (identity.role === "global") {
    return { role: "global", basename, userVersion };
  }
  if (identity.role === "agent") {
    return { role: "agent", agentId: identity.agentId, basename, userVersion };
  }
  return { role: "generic", id: identity.id, basename, userVersion };
}

function buildDatabaseValidator(
  identity: SnapshotDatabaseIdentity | SnapshotDatabaseManifest,
): SqliteSnapshotValidator {
  if (identity.role === "global") {
    return (database, pathname) =>
      assertOpenClawStateDatabaseForMaintenance(database, { pathname });
  }
  if (identity.role === "agent") {
    return (database, pathname) =>
      assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId: identity.agentId,
        pathname,
      });
  }
  return () => undefined;
}

function buildManifestDatabaseValidator(
  manifest: SnapshotDatabaseManifest,
): SqliteSnapshotValidator {
  const validateOwner = buildDatabaseValidator(manifest);
  return (database, pathname) => {
    validateOwner(database, pathname);
    const userVersion = readSqliteUserVersion(database);
    if (userVersion !== manifest.userVersion) {
      throw new Error(
        `Snapshot database user_version mismatch for ${pathname}: expected ${manifest.userVersion}, got ${userVersion}`,
      );
    }
  };
}

function sanitizeGlobalStateSnapshot(database: DatabaseSync): void {
  database.prepare("DELETE FROM delivery_queue_entries").run();
}

function buildSnapshotId(now: Date, sourcePath: string): string {
  const timestamp = now.toISOString().replaceAll(/[:.]/g, "-");
  const basename =
    path
      .basename(sourcePath)
      .replaceAll(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, SNAPSHOT_ID_BASENAME_MAX_LENGTH) || "database.sqlite";
  return `${timestamp}-${basename}-${randomUUID()}`;
}

async function ensurePrivateDirectory(directoryPath: string, scopeLabel: string): Promise<void> {
  const result = await ensureAbsoluteDirectory(directoryPath, {
    mode: SNAPSHOT_DIRECTORY_MODE,
    scopeLabel,
  });
  if (!result.ok) {
    throw result.error;
  }
  applyPrivateModeSync(result.path, SNAPSHOT_DIRECTORY_MODE);
}

async function ensureRestoreParentDirectory(directoryPath: string): Promise<void> {
  const result = await ensureAbsoluteDirectory(directoryPath, {
    mode: SNAPSHOT_DIRECTORY_MODE,
    scopeLabel: "SQLite restore target",
  });
  if (!result.ok) {
    throw result.error;
  }
}

function assertDirectory(stat: Stats, pathname: string, label: string): void {
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${pathname}`);
  }
}

async function assertDirectoryIdentity(
  directoryPath: string,
  expectedIdentity: Stats,
): Promise<void> {
  const currentIdentity = await fs.lstat(directoryPath);
  assertDirectory(currentIdentity, directoryPath, "SQLite restore target directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`SQLite restore target directory changed during restore: ${directoryPath}`);
  }
}

async function assertOpenDirectoryIdentity(
  handle: FileHandle,
  directoryPath: string,
  expectedIdentity: Stats,
): Promise<void> {
  const openedIdentity = await handle.stat();
  const currentIdentity = await fs.lstat(directoryPath);
  assertDirectory(openedIdentity, directoryPath, "SQLite snapshot directory");
  assertDirectory(currentIdentity, directoryPath, "SQLite snapshot directory");
  if (
    !sameFileIdentity(openedIdentity, expectedIdentity) ||
    !sameFileIdentity(currentIdentity, expectedIdentity)
  ) {
    throw new Error(`SQLite snapshot directory changed during publication: ${directoryPath}`);
  }
}

function assertDirectoryIdentitySync(directoryPath: string, expectedIdentity: Stats): void {
  const currentIdentity = fsSync.lstatSync(directoryPath);
  assertDirectory(currentIdentity, directoryPath, "SQLite restore target directory");
  if (!sameFileIdentity(currentIdentity, expectedIdentity)) {
    throw new Error(`SQLite restore target directory changed during restore: ${directoryPath}`);
  }
}

function isSnapshotEntryLinkFallbackError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "EPERM" ||
    code === "EXDEV" ||
    code === "ENOTSUP" ||
    code === "EOPNOTSUPP" ||
    code === "ENOSYS"
  );
}

async function publishSnapshotEntryNoOverwrite(
  sourcePath: string,
  targetPath: string,
  entryName: string,
  publishedEntries: Map<string, Stats>,
): Promise<void> {
  let linked = false;
  let linkedSourceIdentity: Stats | undefined;
  try {
    linkedSourceIdentity = await fs.lstat(sourcePath);
    await fs.link(sourcePath, targetPath);
    publishedEntries.set(entryName, linkedSourceIdentity);
    linked = true;
  } catch (error) {
    if (!isSnapshotEntryLinkFallbackError(error)) {
      throw error;
    }
    const copiedIdentity = await copySnapshotEntryExclusive(sourcePath, targetPath);
    publishedEntries.set(entryName, copiedIdentity);
  }
  const expectedTargetIdentity = publishedEntries.get(entryName);
  const initialTargetIdentity = await fs.lstat(targetPath);
  if (!expectedTargetIdentity || !sameFileIdentity(expectedTargetIdentity, initialTargetIdentity)) {
    throw new Error(`SQLite snapshot entry changed during publication: ${targetPath}`);
  }
  if (linked) {
    if (!linkedSourceIdentity || !sameFileIdentity(linkedSourceIdentity, initialTargetIdentity)) {
      throw new Error(`SQLite snapshot entry changed during publication: ${targetPath}`);
    }
    const sourceIdentity = await fs.lstat(sourcePath);
    if (!sameFileIdentity(sourceIdentity, initialTargetIdentity)) {
      throw new Error(`SQLite snapshot entry changed during publication: ${targetPath}`);
    }
  }
  await fs.unlink(sourcePath);
  const finalTargetIdentity = await fs.lstat(targetPath);
  if (!sameFileIdentity(initialTargetIdentity, finalTargetIdentity)) {
    throw new Error(`SQLite snapshot entry changed after publication: ${targetPath}`);
  }
  publishedEntries.set(entryName, finalTargetIdentity);
}

async function copySnapshotEntryExclusive(sourcePath: string, targetPath: string): Promise<Stats> {
  const source = await fs.open(sourcePath, "r");
  let target: FileHandle | undefined;
  let targetIdentity: Stats | undefined;
  try {
    target = await fs.open(targetPath, "wx+", SNAPSHOT_FILE_MODE);
    targetIdentity = await target.stat();
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) {
        break;
      }
      let bytesWritten = 0;
      while (bytesWritten < bytesRead) {
        const result = await target.write(
          buffer,
          bytesWritten,
          bytesRead - bytesWritten,
          offset + bytesWritten,
        );
        if (result.bytesWritten === 0) {
          throw new Error(`SQLite snapshot entry copy made no progress: ${targetPath}`);
        }
        bytesWritten += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await target.sync();
    const finalIdentity = await target.stat();
    const currentIdentity = await fs.lstat(targetPath);
    if (
      !sameFileIdentity(targetIdentity, finalIdentity) ||
      !sameFileIdentity(targetIdentity, currentIdentity)
    ) {
      throw new Error(`SQLite snapshot entry changed during copy: ${targetPath}`);
    }
    return finalIdentity;
  } catch (error) {
    if (targetIdentity) {
      const currentIdentity = await fs.lstat(targetPath).catch(() => undefined);
      if (currentIdentity && sameFileIdentity(currentIdentity, targetIdentity)) {
        await fs.unlink(targetPath).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await target?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

async function assertExactSnapshotContents(snapshotDir: string): Promise<void> {
  await assertSnapshotContents(
    snapshotDir,
    new Set([SNAPSHOT_MANIFEST_FILENAME, SNAPSHOT_SQLITE_FILENAME]),
  );
}

async function assertPendingSnapshotContents(snapshotDir: string): Promise<void> {
  await assertSnapshotContents(
    snapshotDir,
    new Set([SNAPSHOT_MANIFEST_FILENAME, SNAPSHOT_PENDING_FILENAME, SNAPSHOT_SQLITE_FILENAME]),
  );
}

async function assertSnapshotContents(snapshotDir: string, expected: Set<string>): Promise<void> {
  const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!expected.delete(entry.name)) {
      throw new Error(
        `SQLite snapshot contains unexpected entry: ${path.join(snapshotDir, entry.name)}`,
      );
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(
        `SQLite snapshot entry must be a regular file: ${path.join(snapshotDir, entry.name)}`,
      );
    }
    const stat = await fs.lstat(path.join(snapshotDir, entry.name));
    if (stat.nlink > 1) {
      throw new Error(
        `SQLite snapshot entry must not be hardlinked: ${path.join(snapshotDir, entry.name)}`,
      );
    }
  }
  if (expected.size > 0) {
    throw new Error(`SQLite snapshot is missing ${[...expected].join(", ")}: ${snapshotDir}`);
  }
}

async function isIncompleteSnapshotDirectory(snapshotDir: string): Promise<boolean> {
  const entries = await fs.readdir(snapshotDir, { withFileTypes: true });
  const names = new Set(entries.map((entry) => entry.name));
  if (names.has(SNAPSHOT_PENDING_FILENAME)) {
    return true;
  }
  if (names.has(SNAPSHOT_MANIFEST_FILENAME)) {
    return false;
  }
  return entries.length === 0;
}

async function assertFreshRestorePathsAbsent(databasePath: string): Promise<void> {
  for (const candidate of [
    databasePath,
    ...SQLITE_SIDECAR_SUFFIXES.map((suffix) => `${databasePath}${suffix}`),
  ]) {
    if (await lstatIfExists(candidate)) {
      throw new Error(`Fresh SQLite restore path already exists: ${candidate}`);
    }
  }
}

function assertNoSqliteSidecarsSync(databasePath: string): void {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      fsSync.lstatSync(sidecarPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    throw new Error(`Restored SQLite database has unexpected sidecar: ${sidecarPath}`);
  }
}

async function lstatIfExists(pathname: string): Promise<Stats | undefined> {
  try {
    return await fs.lstat(pathname);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removePrivateDirectoryIfOwned(
  directoryPath: string,
  expectedIdentity: Stats,
  allowedEntries: ReadonlySet<string>,
): Promise<boolean> {
  const currentIdentity = await lstatIfExists(directoryPath);
  if (!currentIdentity) {
    return false;
  }
  if (
    currentIdentity.isSymbolicLink() ||
    !currentIdentity.isDirectory() ||
    !sameFileIdentity(currentIdentity, expectedIdentity)
  ) {
    throw new Error(`Private SQLite staging directory changed before cleanup: ${directoryPath}`);
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const verifiedPaths: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (!allowedEntries.has(entry.name) || entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`Private SQLite staging directory has unexpected entry: ${entryPath}`);
    }
    const stat = await fs.lstat(entryPath);
    if (stat.nlink > 1) {
      throw new Error(`Private SQLite staging file must not be hardlinked: ${entryPath}`);
    }
    verifiedPaths.push(entryPath);
  }
  await Promise.all(verifiedPaths.map(async (entryPath) => await fs.unlink(entryPath)));
  await fs.rmdir(directoryPath);
  return true;
}

async function removePublishedSnapshotDirectoryIfOwned(
  directoryPath: string,
  expectedIdentity: Stats,
  publishedEntries: ReadonlyMap<string, Stats>,
): Promise<boolean> {
  const currentIdentity = await lstatIfExists(directoryPath);
  if (
    !currentIdentity ||
    currentIdentity.isSymbolicLink() ||
    !currentIdentity.isDirectory() ||
    !sameFileIdentity(currentIdentity, expectedIdentity)
  ) {
    return false;
  }
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  for (const entry of entries) {
    const expectedEntryIdentity = publishedEntries.get(entry.name);
    if (!expectedEntryIdentity || entry.isSymbolicLink() || !entry.isFile()) {
      continue;
    }
    const entryPath = path.join(directoryPath, entry.name);
    const currentEntryIdentity = await fs.lstat(entryPath);
    if (sameFileIdentity(currentEntryIdentity, expectedEntryIdentity)) {
      await fs.unlink(entryPath);
    }
  }
  if ((await fs.readdir(directoryPath)).length > 0) {
    return false;
  }
  await fs.rmdir(directoryPath);
  return true;
}
