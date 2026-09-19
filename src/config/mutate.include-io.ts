// Owns include-file reads, publication, and compensation for config mutations.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  withDeferredPluginMigrationsCurrent,
  type DeferredPluginMigration,
} from "../infra/deferred-plugin-migrations.js";
import { formatErrorMessage, isMissingPathError } from "../infra/errors.js";
import { root as createFsRoot, type Root as FsSafeRoot } from "../infra/fs-safe.js";
import { isPathInside } from "../security/scan-paths.js";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import {
  ConfigIncludeError,
  hashConfigIncludeRaw,
  resolveConfigIncludeWritePath,
} from "./includes.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import type { ConfigWriteOptions } from "./io.types.js";
import { ConfigWritePostCommitError, type ConfigWriteRollbackStatus } from "./io.write-errors.js";
import {
  captureConfigFileWritePathProof,
  createGuardedConfigFileSystem,
  createConfigWriteAuthorityGuard,
  rollbackConfigFileWriteIfUnchanged,
  type ConfigFileWriteRollbackProof,
} from "./io.write-safety.js";
import { warnIfJSON5CommentsWillBeStripped } from "./json5-comments.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import type { ConfigFileSnapshot } from "./types.js";
import { rejectConfigNonFiniteNumbers } from "./value-tree.js";

export function formatJsonFileValue(value: unknown): string {
  rejectConfigNonFiniteNumbers(value);
  return `${JSON.stringify(value, null, 2)}\n`;
}

type RootBoundIncludeFile = {
  absolutePath: string;
  relativePath: string;
  root: FsSafeRoot;
};

async function resolveRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
}): Promise<RootBoundIncludeFile> {
  const absolutePath = resolveConfigIncludeWritePath(params);
  const candidateRoots = [path.dirname(params.configPath), ...params.allowedRoots];
  for (const candidateRoot of candidateRoots) {
    const rootReal = await fs.realpath(candidateRoot).catch(() => null);
    if (!rootReal || !isPathInside(rootReal, absolutePath)) {
      continue;
    }
    const relativePath = path.relative(rootReal, absolutePath);
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath.split(path.sep)[0] === ".."
    ) {
      continue;
    }
    return {
      absolutePath,
      relativePath,
      root: await createFsRoot(rootReal, {
        hardlinks: "reject",
        mkdir: true,
        mode: 0o600,
        symlinks: "reject",
      }),
    };
  }
  throw new Error(`Config include write path has no approved existing root: ${absolutePath}`);
}

export async function resolveExpectedRootBoundIncludeFile(params: {
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
  expectedAbsolutePath: string;
}): Promise<RootBoundIncludeFile> {
  let target: RootBoundIncludeFile;
  try {
    target = await resolveRootBoundIncludeFile(params);
  } catch (error) {
    if (
      error instanceof ConfigIncludeError ||
      (error instanceof Error &&
        error.message.startsWith("Config include write path has no approved existing root:"))
    ) {
      throw new ConfigMutationConflictError("included config target changed since last load");
    }
    throw error;
  }
  if (path.normalize(target.absolutePath) !== path.normalize(params.expectedAbsolutePath)) {
    throw new ConfigMutationConflictError("included config target changed since last load");
  }
  return target;
}

export async function readRootBoundFileRawIfExists(
  target: RootBoundIncludeFile,
): Promise<string | null> {
  try {
    return await target.root.readText(target.relativePath);
  } catch (error) {
    if (isMissingPathError(error)) {
      return null;
    }
    throw error;
  }
}

async function assertRootConfigStillMatchesSnapshot(snapshot: ConfigFileSnapshot): Promise<void> {
  let currentRaw: string | null = null;
  try {
    currentRaw = await fs.readFile(snapshot.path, "utf-8");
  } catch (error) {
    if (!isMissingPathError(error)) {
      throw error;
    }
  }
  const currentHash = hashConfigIncludeRaw(currentRaw);
  const expectedHash = hashConfigIncludeRaw(snapshot.exists ? (snapshot.raw ?? null) : null);
  if (currentHash !== expectedHash) {
    throw new ConfigMutationConflictError("config changed while preparing include write");
  }
}

export async function assertIncludeGraphStillMatchesSnapshot(params: {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions | undefined;
  includePath: string;
  includeHash: string;
}): Promise<void> {
  await assertRootConfigStillMatchesSnapshot(params.snapshot);
  for (const [includePath, capturedHash] of Object.entries(
    params.writeOptions?.includeFileHashesForWrite ?? {},
  )) {
    const expectedTarget = params.writeOptions?.includeFileTargetsForWrite?.[includePath];
    if (!expectedTarget) {
      throw new ConfigMutationConflictError("included config target changed since last load");
    }
    const target = await resolveExpectedRootBoundIncludeFile({
      configPath: params.snapshot.path,
      includePath,
      // Dependencies may be read-only external includes. Pin each read to its
      // captured target; the selected write still requires the config directory.
      allowedRoots: [path.dirname(expectedTarget)],
      expectedAbsolutePath: expectedTarget,
    });
    const expectedHash = includePath === params.includePath ? params.includeHash : capturedHash;
    if (hashConfigIncludeRaw(await readRootBoundFileRawIfExists(target)) !== expectedHash) {
      throw new ConfigMutationConflictError("included config changed while preparing write");
    }
  }
}

type IncludePublicationProof = ReturnType<typeof captureConfigFileWritePathProof> & {
  captureRollbackProof: () => ConfigFileWriteRollbackProof;
};

export async function rollbackJsonFileWriteIfUnchanged(params: {
  target: RootBoundIncludeFile;
  previousRaw: string | null;
  committedRaw: string | null;
  pathProof: IncludePublicationProof;
}): Promise<boolean> {
  return await rollbackConfigFileWriteIfUnchanged({
    configPath: params.target.absolutePath,
    previousSnapshot: {
      path: params.target.absolutePath,
      exists: params.previousRaw !== null,
      raw: params.previousRaw,
    },
    committedHash: hashConfigRaw(params.committedRaw),
    fsModule: fsNode,
    ...params.pathProof.captureRollbackProof(),
    preserveDirectoryMode: true,
    durable: true,
    destinationHardlinks: "reject",
  });
}

export async function writeRootBoundJsonFile(params: {
  env: NodeJS.ProcessEnv;
  deferredPluginMigrations: readonly DeferredPluginMigration[];
  configPath: string;
  includePath: string;
  allowedRoots: readonly string[];
  expectedTargetPath: string;
  value: unknown;
  expectedRaw: string | null;
  includeGraph: { hashes: Record<string, string>; targets: Record<string, string> };
  assertIncludeGraphForWrite: (committedHash?: string) => Promise<void>;
  assertConfigPathForWrite: () => void;
  assertOwnerForRollback: () => void;
  preCommitRuntimePreflight?: () => Promise<unknown>;
  beforeCommit?: () => void | Promise<void>;
  skipOutputLogs?: boolean;
}): Promise<IncludePublicationProof> {
  params.assertConfigPathForWrite();
  await params.preCommitRuntimePreflight?.();
  params.assertConfigPathForWrite();
  const targetAtCommit = await resolveExpectedRootBoundIncludeFile({
    configPath: params.configPath,
    includePath: params.includePath,
    allowedRoots: params.allowedRoots,
    expectedAbsolutePath: params.expectedTargetPath,
  });
  params.assertConfigPathForWrite();
  await params.assertIncludeGraphForWrite();
  params.assertConfigPathForWrite();
  const currentRaw = await readRootBoundFileRawIfExists(targetAtCommit);
  params.assertConfigPathForWrite();
  const currentHash = hashConfigIncludeRaw(currentRaw);
  if (currentHash !== hashConfigIncludeRaw(params.expectedRaw)) {
    throw new ConfigMutationConflictError("included config changed while preparing write");
  }
  const pathProof = captureConfigFileWritePathProof(
    params.includePath,
    targetAtCommit.absolutePath,
    fsNode,
  );
  const assertCurrent = createConfigWriteAuthorityGuard(() => {
    params.assertConfigPathForWrite();
    pathProof.assertCurrent();
  });
  const content = formatJsonFileValue(params.value);
  // The include fast path bypasses writeConfigFile(); preserve config-path
  // ownership and the comment warning on the conflict-checked target.
  params.assertConfigPathForWrite();
  warnIfJSON5CommentsWillBeStripped({
    raw: currentRaw,
    filePath: targetAtCommit.absolutePath,
    skipOutputLogs: params.skipOutputLogs,
  });
  const publication: { phase: "unpublished" | "removed" | "published" } = { phase: "unpublished" };
  const guardedFs = createGuardedConfigFileSystem(
    targetAtCommit.absolutePath,
    fsNode,
    assertCurrent,
    {
      snapshot: { path: targetAtCommit.absolutePath, exists: currentRaw !== null, raw: currentRaw },
      includeGraph: params.includeGraph,
      targetPathProof: pathProof,
      preserveDirectoryMode: true,
      onRootRemoved: () => {
        publication.phase = "removed";
      },
      onRootPublished: () => {
        publication.phase = "published";
      },
    },
  );
  const publicationProof: IncludePublicationProof = {
    ...pathProof,
    assertCurrent: () => {
      params.assertOwnerForRollback();
      pathProof.assertCurrent();
      guardedFs.assertPublishedIdentity();
    },
    captureRollbackProof: () => guardedFs.captureRollbackProof(params.assertOwnerForRollback),
  };
  try {
    await using preparedFile = await prepareConfigFileWrite({
      configPath: targetAtCommit.absolutePath,
      previousRaw: currentRaw,
      content,
      fsModule: guardedFs.fileSystem,
      assertCurrent: guardedFs.assertCurrent,
      destinationHardlinks: "reject",
      durable: true,
    });
    await params.beforeCommit?.();
    guardedFs.assertCurrent();
    withDeferredPluginMigrationsCurrent(
      { env: params.env, expectedPending: params.deferredPluginMigrations },
      () => {
        preparedFile.publish();
        publication.phase = "published";
      },
    );
    await params.assertIncludeGraphForWrite(hashConfigIncludeRaw(content));
    guardedFs.assertCurrent();
    guardedFs.assertPublishedIdentity();
  } catch (error) {
    if (publication.phase === "unpublished") {
      throw error;
    }
    let rollbackStatus: ConfigWriteRollbackStatus = "unknown";
    try {
      const rolledBack = await rollbackJsonFileWriteIfUnchanged({
        target: targetAtCommit,
        previousRaw: currentRaw,
        committedRaw: publication.phase === "published" ? content : null,
        pathProof: publicationProof,
      });
      rollbackStatus = rolledBack ? "restored" : "not-restored";
    } catch (rollbackError) {
      throw new ConfigWritePostCommitError({
        configPath: targetAtCommit.absolutePath,
        rollbackStatus,
        publication: publication.phase === "removed" ? "partial" : "complete",
        cause: new AggregateError(
          [error, rollbackError],
          `${formatErrorMessage(error)} Recovery failed: ${formatErrorMessage(rollbackError)}`,
          { cause: rollbackError },
        ),
      });
    }
    throw new ConfigWritePostCommitError({
      configPath: targetAtCommit.absolutePath,
      rollbackStatus,
      publication: publication.phase === "removed" ? "partial" : "complete",
      cause: error,
    });
  }
  return publicationProof;
}
