import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import * as tar from "tar";
import { readConfigFileSnapshot, resolveStateDir } from "../config/config.js";
import { prepareRestoredClientCredentials } from "../infra/client-credential-restore.js";
import { formatDiskSpaceBytes, tryReadDiskSpace } from "../infra/disk-space.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import {
  BACKUP_MAX_DECOMPRESSION_RATIO,
  buildBackupArchivePath,
  canonicalizePathForContainment,
  resolveBackupAgentRoots,
  resolveRequiredBackupPath,
} from "./backup-shared.js";
import { prepareBackupArchive } from "./backup-verify.js";
import { resolveLegacyConfigSnapshotForBackup } from "./doctor/shared/automatic-config-repair.js";

const BACKUP_RESTORE_WARNINGS = [
  "Restoring an archive is time travel: every restored state surface rolls back to the archive timestamp.",
  "Messaging-channel credentials with ratchet state, especially WhatsApp, may desynchronize after rollback and require relinking.",
  "Approvals and delivery/dedupe state also roll back; review pending approvals before resuming the Gateway.",
  "Plugin node_modules are not archived; after activation, run `openclaw plugins update <id>` or reinstall with `openclaw plugins install <spec> --force`.",
  "Generated plugin-skills links are not archived; after activation, run `openclaw skills list` or start an agent session to rebuild them.",
] as const;

const BACKUP_RESTORE_FREE_SPACE_RESERVE_BYTES = 256 * 1024 * 1024;

type BackupRestoreResult = Awaited<ReturnType<typeof backupRestoreCommand>>;

async function assertTargetOutsideLiveState(targetPath: string): Promise<void> {
  const [canonicalTarget, canonicalStateDir] = await Promise.all([
    canonicalizePathForContainment(targetPath),
    canonicalizePathForContainment(resolveStateDir()),
  ]);
  if (isPathInside(canonicalStateDir, canonicalTarget)) {
    throw new Error(
      `Backup restore target must be outside the live OpenClaw state directory: ${targetPath}`,
    );
  }
  const configSnapshot = await readConfigFileSnapshot({ observe: false });
  const discoverySnapshot = await resolveLegacyConfigSnapshotForBackup(configSnapshot);
  if (!discoverySnapshot) {
    return;
  }
  const agentRoots = await resolveBackupAgentRoots(discoverySnapshot.config);
  for (const { sourcePath } of agentRoots) {
    if (isPathInside(sourcePath, canonicalTarget)) {
      throw new Error(
        `Backup restore target must be outside the live OpenClaw agent directory: ${targetPath}`,
      );
    }
  }
}

async function prepareRestoreTarget(targetPath: string): Promise<{ created: boolean }> {
  try {
    const stat = await fs.lstat(targetPath);
    if (!stat.isDirectory()) {
      throw new Error(`Backup restore target must be a directory: ${targetPath}`);
    }
    if ((await fs.readdir(targetPath)).length > 0) {
      throw new Error(`Backup restore target directory must be empty: ${targetPath}`);
    }
    return { created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
  return { created: true };
}

function assertRestoreCapacity(targetPath: string, extractionBytes: number): void {
  const diskSpace = tryReadDiskSpace(targetPath);
  if (!diskSpace) {
    return;
  }
  const requiredBytes = extractionBytes + BACKUP_RESTORE_FREE_SPACE_RESERVE_BYTES;
  if (requiredBytes <= diskSpace.availableBytes) {
    return;
  }
  const location =
    path.resolve(targetPath) === path.resolve(diskSpace.checkedPath)
      ? targetPath
      : `${targetPath} (volume checked at ${diskSpace.checkedPath})`;
  throw new Error(
    `Backup restore requires ${formatDiskSpaceBytes(requiredBytes)} of free space at ${location} (${formatDiskSpaceBytes(extractionBytes)} archive data plus ${formatDiskSpaceBytes(BACKUP_RESTORE_FREE_SPACE_RESERVE_BYTES)} reserve), but only ${formatDiskSpaceBytes(diskSpace.availableBytes)} is available. Choose a target on a volume with enough free space.`,
  );
}

async function cleanupFailedRestore(targetPath: string, created: boolean): Promise<void> {
  if (created) {
    await fs.rm(targetPath, { recursive: true, force: true });
    return;
  }
  for (const entry of await fs.readdir(targetPath)) {
    await fs.rm(path.join(targetPath, entry), { recursive: true, force: true });
  }
}

async function extractBackupArchive(
  archivePath: string,
  targetPath: string,
  hardlinkTargets: ReadonlyMap<string, string>,
  symbolicLinkPaths: ReadonlySet<string>,
): Promise<void> {
  let extractionError: Error | undefined;
  await tar.x({
    file: archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    cwd: targetPath,
    // node-tar strict mode rejects on the first warning before queued writes drain.
    // Verification catches fatal archive errors; rethrow recoverable warnings after close.
    strict: false,
    preserveOwner: false,
    // Create links only after file writes finish; never extract through a link.
    filter: (entryPath) => !symbolicLinkPaths.has(entryPath),
    // node-tar calls this before its path checks and filesystem reservations.
    onReadEntry: (entry) => {
      const target = hardlinkTargets.get(entry.path);
      if (target !== undefined) {
        entry.linkpath = target;
      }
    },
    onwarn: (code, message, data) => {
      extractionError ??=
        data instanceof Error ? data : Object.assign(new Error(`${code}: ${message}`), data);
    },
  });
  if (extractionError) {
    throw extractionError;
  }
}

async function restorePostgresExports(
  targetPath: string,
  candidates: Array<{ directoryPath: string; anchorPath: string }>,
  recoveryConfigPath: string | undefined,
  recoveryConfigContextPath: string | undefined,
  archiveRoot: string,
  publishCompanions?: () => void,
): Promise<void> {
  if (candidates.length === 0) {
    publishCompanions?.();
    return;
  }
  if (!recoveryConfigPath) {
    throw new Error("PostgreSQL archive restore requires its captured configuration.");
  }
  const configPath = path.join(targetPath, recoveryConfigPath);
  if (!isPathInside(targetPath, await fs.realpath(configPath))) {
    throw new Error("PostgreSQL recovery configuration must be inside the restored archive.");
  }
  const {
    discardPostgresRestores,
    preparePostgresRestore,
    readBackupEngineImage,
    runOfflineDatabaseBackup,
  } = await import("../snapshot/database-backup.js");
  const { publishVerifiedSqliteFile } = await import("../infra/sqlite-snapshot.js");
  const postgres: Array<{
    directoryPath: string;
    anchorPath: string;
    source: { storeId: string; namespace: string };
  }> = [];
  for (const entry of candidates) {
    const anchorPath = path.join(targetPath, entry.anchorPath);
    const source = readBackupEngineImage(anchorPath, anchorPath);
    if (source.engine !== "postgres") {
      throw new Error(`PostgreSQL backup artifact has no matched anchor: ${entry.anchorPath}`);
    }
    postgres.push({ ...entry, source });
  }
  await runOfflineDatabaseBackup(
    targetPath,
    async ({ config, assertCurrent }) => {
      const staging = await fs.mkdtemp(path.join(targetPath, ".postgres-restore-"));
      const prepared: Array<{
        sourcePath: string;
        targetPath: string;
        content: Awaited<ReturnType<typeof preparePostgresRestore>>;
      }> = [];
      try {
        const pendingConfig = path.join(staging, "openclaw.json");
        await fs.rename(configPath, pendingConfig);
        for (const [index, entry] of postgres.entries()) {
          const anchorPath = path.join(targetPath, entry.anchorPath);
          const sourcePath = path.join(staging, `${index}.sqlite`);
          const content = await preparePostgresRestore({
            directory: path.join(targetPath, entry.directoryPath),
            anchorPath: sourcePath,
            config,
            profile: "user-backup",
            expectedSource: entry.source,
            assertCurrent,
          });
          prepared.push({ sourcePath, targetPath: anchorPath, content });
        }
        // Every store has passed provider verification before any captured anchor is replaced.
        for (const entry of prepared) {
          assertCurrent();
          await fs.unlink(entry.targetPath);
          await publishVerifiedSqliteFile({
            sourcePath: entry.sourcePath,
            sourceIdentity: await fs.lstat(entry.sourcePath, { bigint: true }),
            targetPath: entry.targetPath,
            expectedContent: entry.content,
            requireAtomicPublication: true,
            beforePublish: async () => assertCurrent(),
            afterPublish: (guard) => guard.assertTargetMatchesExpectedContent(assertCurrent),
          });
        }
        assertCurrent();
        publishCompanions?.();
        for (const { directoryPath } of postgres) {
          for (const name of ["manifest.json", "anchor.sqlite", "database.sqlite"]) {
            await fs.unlink(path.join(targetPath, directoryPath, name));
          }
        }
        // The recovered family selection becomes visible only with verified matching anchors.
        assertCurrent();
        await fs.rename(pendingConfig, configPath);
        await fs.rm(staging, { recursive: true, force: true });
      } catch (error) {
        try {
          await discardPostgresRestores(
            config,
            prepared.map(({ content }) => content.namespace),
          );
        } catch (cleanupError) {
          // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors retains the cleanup failure.
          throw new AggregateError(
            [error, cleanupError],
            `PostgreSQL restore failed and its scratch namespaces could not be cleaned: ${formatErrorMessage(cleanupError)}`,
            { cause: error },
          );
        }
        throw error;
      }
    },
    {
      configPath: path.join(targetPath, recoveryConfigContextPath ?? recoveryConfigPath),
      configSourcePath: configPath,
      env: {
        ...process.env,
        OPENCLAW_INCLUDE_ROOTS: path.join(targetPath, archiveRoot, "payload"),
      },
      mapIncludePath: (includePath) =>
        isPathInside(targetPath, includePath)
          ? includePath
          : path.join(targetPath, buildBackupArchivePath(archiveRoot, includePath)),
    },
  );
}

function formatRestoreResult(result: BackupRestoreResult): string {
  return [
    `Backup archive restored to staging: ${shortenHomePath(result.targetPath)}`,
    `Verified archive: ${shortenHomePath(result.archivePath)}`,
    `Archive root: ${result.archiveRoot}`,
    `Archive entries restored: ${result.entryCount}`,
    "",
    "Rollback warnings:",
    ...result.warnings.map((warning) => `- ${warning}`),
    "",
    "Activation is explicit: stop the Gateway, move the restored asset tree into place or point OPENCLAW_STATE_DIR at the restored state asset, then run `openclaw doctor`.",
  ].join("\n");
}

/** Verify first, then extract a whole backup archive into a fresh staging directory. */
export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  options: { archive: string; target?: string; json?: boolean },
) {
  const targetPath = resolveRequiredBackupPath(options.target, "--target");
  await assertTargetOutsideLiveState(targetPath);
  const {
    result: verified,
    hardlinkTargets,
    symbolicLinks,
    regularFileExtractionBytes,
    databaseRestoreCandidates,
    recoveryConfigPath,
    recoveryConfigContextPath,
    manifest,
  } = await prepareBackupArchive(options.archive);
  assertRestoreCapacity(targetPath, regularFileExtractionBytes);
  const target = await prepareRestoreTarget(targetPath);

  try {
    await extractBackupArchive(
      verified.archivePath,
      targetPath,
      hardlinkTargets,
      new Set(symbolicLinks.map(({ entryPath }) => entryPath)),
    );
    const restoreClientCredentials = prepareRestoredClientCredentials({ manifest, targetPath });
    // Materialize all parents before links: filesystem aliases then collide with
    // directories instead of letting an earlier link redirect a later write.
    for (const { entryPath } of symbolicLinks) {
      await fs.mkdir(path.dirname(path.join(targetPath, entryPath)), { recursive: true });
    }
    for (const { entryPath, linkpath } of symbolicLinks) {
      await fs.symlink(linkpath, path.join(targetPath, entryPath));
    }
    await restorePostgresExports(
      targetPath,
      databaseRestoreCandidates,
      recoveryConfigPath,
      recoveryConfigContextPath,
      verified.archiveRoot,
      restoreClientCredentials,
    );
  } catch (extractionError) {
    try {
      await cleanupFailedRestore(targetPath, target.created);
    } catch (cleanupError) {
      // Both errors are retained; extraction remains the primary cause, not cleanup.
      // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors preserves the cleanup error.
      throw new AggregateError(
        [extractionError, cleanupError],
        `Backup restore failed and the incomplete target could not be cleaned: ${targetPath}. Cleanup error: ${formatErrorMessage(cleanupError)}`,
        { cause: extractionError },
      );
    }
    throw new Error(
      `Backup restore failed; the incomplete target was cleaned: ${targetPath}. ${formatErrorMessage(extractionError)}`,
      { cause: extractionError },
    );
  }

  const result = {
    ...verified,
    targetPath,
    warnings: [
      ...BACKUP_RESTORE_WARNINGS,
      ...(verified.warnings ?? []),
      ...(verified.externalSymbolicLinks ?? []).map(
        ({ entryPath, linkpath }) =>
          `External link restored (target not copied through link): ${JSON.stringify(entryPath)} -> ${JSON.stringify(linkpath)}`,
      ),
    ],
  };
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatRestoreResult(result));
  }
  return result;
}
