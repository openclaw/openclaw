import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "@openclaw/fs-safe/path";
import { z } from "zod";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { readConfigFileSnapshotForWrite } from "../config/io.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { buildBackupArchivePath } from "../infra/backup-archive-path-policy.js";
import { resolveBackupConfigCapture } from "../infra/backup-config-capture.js";
import { createBackupArchive } from "../infra/backup-create.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../infra/boundary-path.js";
import { readClientCredentialFileIdentity } from "../infra/client-credential-receipt.js";
import { rebindRehearsalClientCredentials } from "../infra/client-credential-restore.js";
import { sha256Hex } from "../infra/crypto-digest.js";
import { resolveDatabaseFamilyEngines } from "../infra/database-engine/registry.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { publishVerifiedSqliteFile } from "../infra/sqlite-snapshot.js";
import { createUpdateDatabaseBackup } from "../infra/update-database-backup.js";
import type { RuntimeEnv } from "../runtime.js";
import { captureDatabaseArtifact, assertDatabaseArtifact } from "../snapshot/database-backup.js";
import { withArtifactPreservingStateReads } from "../state/artifact-preserving-state-reads.js";
import { backupRestoreCommand } from "./backup-restore.js";
import { canonicalizePathForContainment } from "./backup-shared.js";
import { prepareBackupArchive } from "./backup-verify.js";
import { withGatewayMigrationQuiescence } from "./database-migration-quiescence.js";
import { assertDoctorSqliteMaintenancePathsNotAliased } from "./doctor-sqlite-maintenance-lock.js";

const absolute = z.string().refine((value) => path.isAbsolute(value) && !value.includes("\u0000"));
const relative = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      !path.isAbsolute(value) &&
      value.split(/[\\/]/u).every((part) => part !== ".." && part !== "." && part !== ""),
  );
const artifact = z.strictObject({
  file: relative,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().nonnegative(),
});
const captured = artifact.extend({ sourcePath: absolute });
const manifestSchema = z.strictObject({
  schema: z.literal("openclaw.database-migration-capture.v1"),
  profile: z.literal("exact-sqlite-migration"),
  captureId: z.uuid(),
  createdAt: z.string().datetime(),
  sourceStateDir: absolute,
  sourceConfigPath: absolute,
  baseArchive: artifact,
  databases: z.array(captured),
  missingDatabases: z.array(absolute),
  configs: z.array(captured).min(1),
  quiescence: z
    .strictObject({
      requestId: z.string().min(1).max(128),
      suspensionId: z.string().min(1).max(128),
      ownerId: z.string().min(1),
      pid: z.number().int().positive(),
      expiresAtMs: z.number().int().positive(),
    })
    .optional(),
  // This is a captured shared/local-pair witness, never a new owner's authority.
  sourceSharedFile: z
    .strictObject({
      path: absolute,
      dev: z.string().regex(/^\d+$/u),
      ino: z.string().regex(/^\d+$/u),
    })
    .nullable(),
});

type Manifest = z.infer<typeof manifestSchema>;

function assertLogicalPaths(manifest: Manifest): void {
  const configRoot = path.dirname(manifest.sourceConfigPath);
  if (
    manifest.sourceStateDir !== resolveIdentityPathViaExistingAncestorSync(resolveStateDir()) ||
    manifest.sourceConfigPath !== path.resolve(resolveConfigPath()) ||
    manifest.databases.some((entry) => !isPathInside(manifest.sourceStateDir, entry.sourcePath)) ||
    manifest.missingDatabases.some((file) => !isPathInside(manifest.sourceStateDir, file)) ||
    manifest.configs.some(
      (entry) =>
        entry.sourcePath !== manifest.sourceConfigPath &&
        !isPathInside(configRoot, entry.sourcePath),
    )
  ) {
    throw new Error(
      "Migration capture requires the same logical state/config paths and state-relative SQLite stores; external roots need an explicit mapping.",
    );
  }
  const paths = [...manifest.databases, ...manifest.configs].map((entry) => entry.sourcePath);
  if (
    new Set(paths).size !== paths.length ||
    !manifest.configs.some((entry) => entry.sourcePath === manifest.sourceConfigPath)
  ) {
    throw new Error("Migration capture has ambiguous database or configuration paths.");
  }
  if (
    manifest.sourceSharedFile &&
    (manifest.sourceSharedFile.path !==
      path.join(manifest.sourceStateDir, "state/openclaw.sqlite") ||
      !manifest.databases.some((entry) => entry.sourcePath === manifest.sourceSharedFile?.path))
  ) {
    throw new Error(
      "Migration capture shared/local identity witness is not a captured shared database.",
    );
  }
}

async function privateArtifact(root: string, entry: z.infer<typeof artifact>): Promise<string> {
  const file = path.join(root, entry.file);
  const actual = await fs.realpath(file);
  if (!isPathInside(root, actual) || actual !== file) {
    throw new Error("Migration capture artifact is outside its private directory.");
  }
  await assertDatabaseArtifact({ path: file, sha256: entry.sha256, size: entry.size });
  return file;
}

/** Capture exact SQLite state under offline custody or an existing host-held suspension. */
export async function createDatabaseMigrationCapture(options: {
  baseArchive?: string;
  output: string;
  externallyQuiesced?: boolean;
  requestId?: string;
  suspensionId?: string;
}) {
  if (options.externallyQuiesced) {
    if (options.baseArchive || !options.requestId || !options.suspensionId) {
      throw new Error(
        "Externally quiesced capture requires request/suspension IDs and creates its own filesystem base; --base-archive is not accepted.",
      );
    }
  } else if (!options.baseArchive || options.requestId || options.suspensionId) {
    throw new Error(
      "Offline migration capture requires --base-archive; suspension IDs require --externally-quiesced.",
    );
  }
  const suspension =
    options.requestId && options.suspensionId
      ? { requestId: options.requestId, suspensionId: options.suspensionId }
      : undefined;
  if (hasActiveGatewayStateOwner(path.join(resolveStateDir(), "state/openclaw.sqlite"))) {
    throw new Error(
      "Exact migration capture requires the Gateway stopped through its service owner.",
    );
  }
  const capture = async ({
    env,
    assertCurrent,
    signal,
    revalidate = async () => assertCurrent(),
    quiescence,
  }: {
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
    signal: AbortSignal;
    revalidate?: () => Promise<void>;
    quiescence?: () => NonNullable<Manifest["quiescence"]>;
  }) => {
    await revalidate();
    const stateDir = path.resolve(resolveStateDir(env));
    const configPath = path.resolve(resolveConfigPath(env));
    const [root, physicalStateDir, physicalConfigRoot] = await Promise.all([
      canonicalizePathForContainment(path.resolve(options.output)),
      canonicalizePathForContainment(stateDir),
      canonicalizePathForContainment(path.dirname(configPath)),
    ]);
    if (isPathInside(physicalStateDir, root) || isPathInside(physicalConfigRoot, root)) {
      throw new Error(
        "Migration capture output must be outside the source state and configuration roots.",
      );
    }
    const configuration = await readConfigFileSnapshotForWrite({
      observe: false,
      skipPluginValidation: true,
    });
    if (!configuration.snapshot.valid || configuration.snapshot.path !== configPath) {
      throw new Error("Migration capture requires valid pinned source configuration.");
    }
    if (
      Object.values(resolveDatabaseFamilyEngines(configuration.snapshot.config)).includes(
        "postgres",
      )
    ) {
      throw new Error(
        "This migration capture accepts SQLite sources only; it never exports or restores PostgreSQL namespaces.",
      );
    }
    const configCapture = await resolveBackupConfigCapture(configuration, { env });
    const preparedBase = options.baseArchive
      ? await prepareBackupArchive(options.baseArchive)
      : undefined;
    if (
      preparedBase &&
      (preparedBase.databaseRestoreCandidates.length > 0 ||
        (preparedBase.manifest.postgresAnchors?.length ?? 0) > 0)
    ) {
      throw new Error("Migration capture requires a SQLite-only base archive.");
    }
    if (
      preparedBase &&
      !preparedBase.manifest.assets.some(
        (entry) => entry.kind === "state" && entry.sourcePath === stateDir,
      )
    ) {
      throw new Error("Base archive belongs to a different state root.");
    }
    assertCurrent();
    await fs.mkdir(root, { mode: 0o700 });
    const base = path.join(root, "filesystem.tar.gz");
    if (preparedBase) {
      await fs.copyFile(
        preparedBase.result.archivePath,
        base,
        constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE,
      );
      await fs.chmod(base, 0o600);
    }
    const backup = await createUpdateDatabaseBackup({
      backupRoot: path.join(root, "native"),
      stateDir,
      config: configuration.snapshot.config,
      env,
      stopped: !options.externallyQuiesced,
      preserveSourceArtifacts: true,
      sourceEngine: "sqlite",
      timeoutMs: 600_000,
      signal,
      purpose: "original-state",
    });
    await revalidate();
    if (!preparedBase) {
      // The SQLite-only exact owner has admitted every physical store before
      // ordinary archive traversal. Both images share this same suspension.
      await createBackupArchive({
        output: base,
        verify: true,
        signal,
        preserveSourceArtifacts: true,
      });
      await revalidate();
    }
    const entry = async (sourcePath: string, file: string) => {
      await using copied = await fs.open(file, "r+");
      await copied.sync();
      const value = await captureDatabaseArtifact(file);
      return {
        sourcePath,
        file: path.relative(root, file),
        sha256: value.sha256,
        size: value.size,
      };
    };
    // These images and hashes are already verified and synced by the capture owner.
    const databases = backup.databases.map((database) => ({
      sourcePath: database.path,
      file: path.relative(root, database.snapshotPath),
      sha256: database.sha256,
      size: database.sizeBytes,
    }));
    const configs = [];
    for (const [index, input] of configCapture.files.entries()) {
      const file = path.join(root, `config-${index}.json`);
      await fs.copyFile(input.canonicalPath, file, constants.COPYFILE_EXCL);
      await fs.chmod(file, 0o600);
      configs.push(await entry(input.sourcePath, file));
    }
    await configCapture.revalidate();
    assertCurrent();
    const baseIdentity = await entry(stateDir, base);
    const manifest: Manifest = {
      schema: "openclaw.database-migration-capture.v1",
      profile: "exact-sqlite-migration",
      captureId: randomUUID(),
      createdAt: new Date().toISOString(),
      sourceStateDir: stateDir,
      sourceConfigPath: configPath,
      baseArchive: {
        file: "filesystem.tar.gz",
        sha256: baseIdentity.sha256,
        size: baseIdentity.size,
      },
      databases,
      missingDatabases: backup.missingPaths,
      configs,
      ...(quiescence ? { quiescence: quiescence() } : {}),
      sourceSharedFile:
        readClientCredentialFileIdentity(path.join(stateDir, "state/openclaw.sqlite")) ?? null,
    };
    assertLogicalPaths(manifest);
    await revalidate();
    const manifestPath = path.join(root, "manifest.json");
    await using handle = await fs.open(manifestPath, "wx", 0o600);
    const contents = `${JSON.stringify(manifest)}\n`;
    await handle.writeFile(contents);
    await handle.sync();
    requireDirectorySync(await syncDirectory(root), "Migration capture publication");
    await revalidate();
    assertCurrent();
    return {
      ok: true,
      verified: true,
      schema: manifest.schema,
      profile: manifest.profile,
      captureId: manifest.captureId,
      directory: root,
      manifestPath,
      manifestSha256: sha256Hex(contents),
      sourceStateDir: stateDir,
      sourceConfigPath: configPath,
      databases: databases.length,
      configs: configs.length,
      ...(manifest.quiescence ? { quiescence: manifest.quiescence } : {}),
    };
  };
  const run = () =>
    runWithLocalStateOwner({
      method: "database.migration-capture",
      params: {},
      target: resolveStateDir(),
      databaseEngine: "configured",
      onForeignOwner: suspension
        ? async ({ env, signal, assertCurrent }) =>
            withGatewayMigrationQuiescence({
              env,
              signal,
              assertCurrent,
              requestId: suspension.requestId,
              suspensionId: suspension.suspensionId,
              run: (held) =>
                capture({
                  env,
                  signal: held.signal,
                  assertCurrent: held.assertCurrent,
                  revalidate: held.revalidate,
                  quiescence: () => ({
                    requestId: suspension.requestId,
                    suspensionId: suspension.suspensionId,
                    ownerId: held.owner.ownerId,
                    pid: held.owner.pid,
                    expiresAtMs: held.expiresAtMs,
                  }),
                }),
            })
        : "refuse",
      runLocal: async (scope) => {
        if (options.externallyQuiesced) {
          throw new Error(
            "Externally quiesced capture requires the existing running Gateway owner.",
          );
        }
        return capture(scope);
      },
    });
  // Config and registry discovery also use the existing read owner. Keep those
  // descriptive reads on private copies, including the source WAL index.
  return options.externallyQuiesced
    ? withArtifactPreservingStateReads(run, { agentDatabases: true })
    : run();
}

/** Restore a full base plus exact native images only into a new private staging tree. */
export async function restoreDatabaseMigrationCapture(
  runtime: RuntimeEnv,
  options: { capture: string; target: string; manifestSha256: string },
) {
  const root = await fs.realpath(options.capture);
  const contents = await fs.readFile(path.join(root, "manifest.json"), "utf8");
  if (sha256Hex(contents) !== options.manifestSha256) {
    throw new Error("Migration capture manifest differs from its producer receipt.");
  }
  const manifest = manifestSchema.parse(JSON.parse(contents));
  assertLogicalPaths(manifest);
  // Complete artifact admission before creating the destination.
  const base = await privateArtifact(root, manifest.baseArchive);
  const sources = await Promise.all(
    [...manifest.databases, ...manifest.configs].map(async (entry) => ({
      entry,
      file: await privateArtifact(root, entry),
    })),
  );
  const result = await backupRestoreCommand(
    { ...runtime, log: () => {} },
    { archive: base, target: options.target, sourceEngine: "sqlite" },
  );
  const staged = (sourcePath: string) =>
    path.join(result.targetPath, buildBackupArchivePath(result.archiveRoot, sourcePath));
  const admitStaged = (sourcePath: string) => {
    const target = staged(sourcePath);
    assertDoctorSqliteMaintenancePathsNotAliased(
      "exact migration restore",
      [target],
      [result.targetPath],
    );
    return target;
  };
  try {
    for (const sourcePath of manifest.missingDatabases) {
      for (const suffix of ["", "-wal", "-shm", "-journal"]) {
        await fs.rm(admitStaged(`${sourcePath}${suffix}`), { force: true });
      }
    }
    for (const { entry, file } of sources) {
      const target = admitStaged(entry.sourcePath);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const parent = await fs.realpath(path.dirname(target));
      if (
        !isPathInside(result.targetPath, parent) ||
        path.join(parent, path.basename(target)) !== target
      ) {
        throw new Error("Migration restore destination is aliased.");
      }
      const old = await fs.lstat(target).catch((error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          return undefined;
        }
        throw error;
      });
      if (old && (!old.isFile() || old.nlink !== 1)) {
        throw new Error("Migration restore may replace only private regular staged files.");
      }
      if (old) {
        await fs.unlink(target);
      }
      if (manifest.databases.includes(entry)) {
        await publishVerifiedSqliteFile({
          sourcePath: file,
          sourceIdentity: await fs.lstat(file, { bigint: true }),
          targetPath: target,
          expectedContent: { sha256: entry.sha256, sizeBytes: entry.size },
          requireAtomicPublication: true,
        });
      } else {
        await fs.copyFile(file, target, constants.COPYFILE_EXCL);
        await fs.chmod(target, 0o600);
      }
    }
    const sourceLocalPath = path.join(manifest.sourceStateDir, "client/credentials.sqlite");
    if (
      manifest.sourceSharedFile &&
      manifest.databases.some((entry) => entry.sourcePath === sourceLocalPath)
    ) {
      rebindRehearsalClientCredentials({
        sourceStateRoot: manifest.sourceStateDir,
        sourceSharedFile: manifest.sourceSharedFile,
        sharedPath: staged(manifest.sourceSharedFile.path),
        localPath: staged(sourceLocalPath),
      });
    }
    return {
      ...result,
      profile: manifest.profile,
      exactMigration: {
        schemaVersion: 1,
        captureId: manifest.captureId,
        sourceStateDir: manifest.sourceStateDir,
        sourceConfigPath: manifest.sourceConfigPath,
        databases: manifest.databases.length,
        configs: manifest.configs.length,
      },
    };
  } catch (error) {
    // Nothing outside this newly extracted staging tree has been published.
    await fs.rm(result.targetPath, { recursive: true, force: true });
    throw error;
  }
}
