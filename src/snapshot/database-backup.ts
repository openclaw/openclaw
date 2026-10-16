import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readEngineAnchor } from "../infra/database-engine/open.js";
import {
  withDatabasePortPostgres,
  withDatabasePortConnection,
} from "../infra/database-engine/port-provider.js";
import { admitDatabasePortDescriptor } from "../infra/database-engine/port.worker.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  captureDatabaseArtifact,
  exportPostgresBackup,
  restorePostgresBackup,
  fingerprintPostgresDatabase,
} from "./database-backup-core.worker.js";
import {
  readSnapshotExportEnvelope,
  verifyPostgresExportEnvelope,
  type PostgresExportEnvelope,
} from "./export-envelope.js";
import type { GitBackupIdentity, GitBackupManifest } from "./git-backup-codec.js";
export { captureDatabaseArtifact, assertDatabaseArtifact } from "./database-backup-core.worker.js";

export type BackupEngine =
  | { engine: "sqlite" }
  | { engine: "postgres"; storeId: string; namespace: string };

export async function runOfflineDatabaseBackup<T>(
  sourcePath: string,
  run: (scope: { config: OpenClawConfig; assertCurrent: () => void }) => Promise<T>,
): Promise<T> {
  const { runWithLocalStateOwner } = await import("../cli/local-state-owner.js");
  const { resolveStateDir } = await import("../config/paths.js");
  if (hasActiveGatewayStateOwner(path.join(resolveStateDir(), "state", "openclaw.sqlite"))) {
    throw new Error(
      "PostgreSQL backup requires the Gateway stopped; stop through the service owner, then rerun.",
    );
  }
  return runWithLocalStateOwner({
    method: "backup.create",
    params: {},
    target: sourcePath,
    onForeignOwner: "refuse",
    runLocal: run,
  });
}

export async function verifyMatchedPostgresBackup(
  directory: string,
  profile: PostgresExportEnvelope["profile"],
) {
  if ((await fs.readdir(directory)).includes(".pending")) {
    throw new Error("PostgreSQL backup is incomplete.");
  }
  const envelope = await readSnapshotExportEnvelope(directory);
  if (envelope.engine !== "postgres") {
    throw new Error("Expected a matched PostgreSQL export.");
  }
  await verifyPostgresExportEnvelope(directory, envelope.manifest, inspectHeldAnchor, profile);
  return envelope.manifest;
}

/** Reads an already captured private image without reacquiring its live source. */
export function readBackupEngineImage(imagePath: string, sourcePath: string): BackupEngine {
  using db = openNodeSqliteDatabase(imagePath, { readOnly: true });
  const rows = readEngineAnchor(db);
  if (!rows) {
    return { engine: "sqlite" };
  }
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row?.engine !== "postgres" ||
    typeof row.store_id !== "string" ||
    typeof row.schema !== "string" ||
    !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(row.schema)
  ) {
    throw new Error(`Invalid PostgreSQL anchor: ${sourcePath}. Restore its matched backup.`);
  }
  return { engine: "postgres", storeId: row.store_id, namespace: row.schema };
}

/** Acquire the private image in a child so source descriptor closes preserve live POSIX locks. */
export function readBackupEngine(sourcePath: string): BackupEngine {
  const prepared = prepareSqliteReadOnlyLocationSync(sourcePath);
  try {
    return readBackupEngineImage(prepared.location, sourcePath);
  } finally {
    prepared.cleanup();
  }
}

async function inspectHeldAnchor(handle: FileHandle) {
  const workspace = { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-anchor-" };
  return await withTempWorkspace(workspace, async ({ dir }) => {
    const file = path.join(dir, "anchor.sqlite");
    {
      await using output = await fs.open(file, "wx", 0o600);
      await copyFileHandle(handle, output);
    }
    const anchor = readBackupEngineImage(file, file);
    if (anchor.engine !== "postgres") {
      throw new Error("Export artifact is not a PostgreSQL anchor.");
    }
    return anchor;
  });
}

/** Caller retains stopped installation custody until all client/native handles settle. */
async function capturePostgresBackupInWorker(params: {
  sourcePath: string;
  directory: string;
  profile: PostgresExportEnvelope["profile"];
  config: OpenClawConfig;
  assertCurrent: () => void;
}): Promise<PostgresExportEnvelope> {
  const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
  const anchor = readBackupEngine(params.sourcePath);
  if (anchor.engine !== "postgres") {
    throw new Error("A PostgreSQL backup requires its original anchor.");
  }
  await fs.mkdir(params.directory, { mode: 0o700 });
  await fs.writeFile(path.join(params.directory, ".pending"), "", { flag: "wx", mode: 0o600 });
  return await withDatabasePortPostgres(params.config, anchor, async (client, baseDescriptor) => {
    const descriptor = await admitDatabasePortDescriptor(
      { engine: "postgres", db: client, namespace: anchor.namespace },
      baseDescriptor,
    );
    params.assertCurrent();
    await createVerifiedSqliteSnapshot({
      sourcePath: params.sourcePath,
      targetPath: path.join(params.directory, "anchor.sqlite"),
      preserveRowIds: true,
    });
    const manifest = await exportPostgresBackup({ ...params, client, descriptor, anchor });
    await verifyPostgresExportEnvelope(
      params.directory,
      manifest,
      inspectHeldAnchor,
      params.profile,
    );
    await fs.unlink(path.join(params.directory, ".pending"));
    requireDirectorySync(await syncDirectory(params.directory), "PostgreSQL backup");
    requireDirectorySync(
      await syncDirectory(path.dirname(params.directory)),
      "PostgreSQL backup parent",
    );
    return manifest;
  });
}

/** Build a new namespace and anchor; the caller alone publishes the anchor. Never drop the old namespace. */
async function preparePostgresRestoreInWorker(params: {
  directory: string;
  anchorPath: string;
  config: OpenClawConfig;
  profile: PostgresExportEnvelope["profile"];
  expectedSource?: { storeId: string; namespace: string };
  assertCurrent: () => void;
}) {
  const manifest = await verifyMatchedPostgresBackup(params.directory, params.profile);
  if (
    params.expectedSource &&
    (manifest.source.storeId !== params.expectedSource.storeId ||
      manifest.source.namespace !== params.expectedSource.namespace)
  ) {
    throw new Error("PostgreSQL rollback capture belongs to a different store.");
  }
  return await withDatabasePortConnection(params.config, async (client) => {
    const { loadDatabasePortDescriptor } =
      await import("../infra/database-engine/port-provider-descriptor.js");
    const descriptor = await loadDatabasePortDescriptor(manifest.source.owner, params.config);
    const { namespace } = await restorePostgresBackup({ ...params, client, descriptor, manifest });
    const { resolveDatabaseEngineInput } = await import("../infra/database-engine/config.js");
    const input = await resolveDatabaseEngineInput(params.config);
    params.assertCurrent();
    await descriptor.admit?.(params.anchorPath, input);
    // Owner admission can change anchor journal mode; bind the final bytes for publication.
    const { sha256, size: sizeBytes } = await captureDatabaseArtifact(params.anchorPath);
    return { namespace, sha256, sizeBytes };
  });
}

type Capture = Parameters<typeof capturePostgresBackupInWorker>[0];
type Restore = Parameters<typeof preparePostgresRestoreInWorker>[0];
type BackupTask =
  | { operation: "capture"; params: Omit<Capture, "assertCurrent"> }
  | { operation: "restore"; params: Omit<Restore, "assertCurrent"> }
  | { operation: "fingerprint"; params: { sourcePath: string; config: OpenClawConfig } };
type BackupReply =
  | PostgresExportEnvelope
  | string
  | Awaited<ReturnType<typeof preparePostgresRestoreInWorker>>;

async function runBackupTask<T>(task: BackupTask, assertCurrent: () => void): Promise<T> {
  assertCurrent();
  // This one-shot worker is joined before publication; it never survives a runtime swap.
  const { WorkerTaskPool } = await import("../infra/worker-task-pool.js");
  const pool = new WorkerTaskPool<BackupTask, T>({
    workerUrl: new URL(import.meta.url),
    maxWorkers: 1,
    workerOptions: { workerData: { openclawDatabaseBackup: true } },
  });
  try {
    const result = await pool.run(task, {});
    assertCurrent();
    return result;
  } finally {
    await pool.close();
  }
}

export function capturePostgresBackup(
  params: Capture | Pick<Capture, "sourcePath" | "directory">,
): Promise<PostgresExportEnvelope> {
  if (!("config" in params)) {
    return runOfflineDatabaseBackup(params.sourcePath, ({ config, assertCurrent }) =>
      capturePostgresBackup({ ...params, config, assertCurrent, profile: "user-backup" }),
    );
  }
  const { assertCurrent, ...input } = params;
  return runBackupTask<PostgresExportEnvelope>(
    { operation: "capture", params: input },
    assertCurrent,
  );
}

export async function captureGitPostgresBackup(params: {
  snapshotPath: string;
  outputPath: string;
  identity: GitBackupIdentity;
  physicalEngine?: BackupEngine["engine"];
}): Promise<GitBackupManifest | undefined> {
  if ((params.physicalEngine ?? readBackupEngine(params.snapshotPath).engine) !== "postgres") {
    return undefined;
  }
  await fs.mkdir(params.outputPath, { mode: 0o700 });
  const exported = await capturePostgresBackup({
    sourcePath: params.snapshotPath,
    directory: path.join(params.outputPath, "postgres"),
  });
  const manifest: GitBackupManifest = {
    schemaVersion: 2,
    identity: params.identity,
    userVersion: exported.exportSchemaVersion,
    excludedTables: [],
    excludedConfigStateKeyPrefixes: [],
    tables: {},
  };
  await fs.writeFile(
    path.join(params.outputPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export function preparePostgresRestore({ assertCurrent, ...params }: Restore) {
  return runBackupTask<Awaited<ReturnType<typeof preparePostgresRestoreInWorker>>>(
    { operation: "restore", params },
    assertCurrent,
  );
}

export function fingerprintPostgresBackup(sourcePath: string, config: OpenClawConfig) {
  return runBackupTask<string>(
    { operation: "fingerprint", params: { sourcePath, config } },
    () => {},
  );
}

if (parentPort && workerData?.openclawDatabaseBackup === true) {
  const { serveWorkerTasks } = await import("../infra/worker-task-server.js");
  serveWorkerTasks<BackupReply>((value, _channel, control) => {
    // SAFETY: The private one-shot host is the sole producer of this structured-clone payload.
    const task = value as BackupTask;
    if (task.operation === "fingerprint") {
      const anchor = readBackupEngine(task.params.sourcePath);
      if (anchor.engine !== "postgres") {
        throw new Error("PostgreSQL anchor disappeared.");
      }
      return withDatabasePortPostgres(task.params.config, anchor, (client, descriptor) =>
        fingerprintPostgresDatabase({ client, descriptor, anchor }),
      );
    }
    return control.runNativeSection<BackupReply>(() =>
      task.operation === "capture"
        ? capturePostgresBackupInWorker({ ...task.params, assertCurrent: control.throwIfCancelled })
        : preparePostgresRestoreInWorker({
            ...task.params,
            assertCurrent: control.throwIfCancelled,
          }),
    );
  });
}
