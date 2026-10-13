import { createHash, randomUUID } from "node:crypto";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parentPort, workerData } from "node:worker_threads";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readEngineAnchor } from "../infra/database-engine/open.js";
import {
  inspectDatabasePort,
  materializeDatabasePort,
  type PortDescriptor,
} from "../infra/database-engine/port.worker.js";
import { expectedPostgresCatalog } from "../infra/database-engine/postgres-catalog.js";
import { requireDirectorySync, syncDirectory, sha256File } from "../infra/directory-durability.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-snapshot-source.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  readSnapshotExportEnvelope,
  verifyPostgresExportEnvelope,
  writePostgresExportEnvelope,
  type PostgresExportEnvelope,
} from "./export-envelope.js";
import type { GitBackupIdentity, GitBackupManifest } from "./git-backup-codec.js";

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

/** Acquire the private image in a child so source descriptor closes preserve live POSIX locks. */
export function readBackupEngine(sourcePath: string): BackupEngine {
  const prepared = prepareSqliteReadOnlyLocationSync(sourcePath);
  try {
    using db = openNodeSqliteDatabase(prepared.location, { readOnly: true });
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
  } finally {
    prepared.cleanup();
  }
}

async function withPostgres<T>(
  config: OpenClawConfig,
  run: (client: import("pg").Client, descriptor: PortDescriptor) => Promise<T>,
): Promise<T> {
  const { resolveDatabaseEngineInput } = await import("../infra/database-engine/config.js");
  const input = await resolveDatabaseEngineInput(config);
  if (!input) {
    throw new Error(
      "PostgreSQL backup requires database.engine=postgres and its configured connection.",
    );
  }
  const { Client } = await import("pg");
  const client = new Client({ connectionString: input.connection });
  await client.connect();
  try {
    const metadata = (
      await import("../infra/database-engine/workboard-port.generated.json", {
        with: { type: "json" },
      })
    ).default;
    const { resolveBundledPluginsDir } = await import("../plugins/bundled-dir.js");
    const plugins = resolveBundledPluginsDir();
    if (!plugins) {
      throw new Error("Bundled store backup descriptors are unavailable.");
    }
    const postgres = await fs.readFile(
      path.join(plugins, "workboard/src/workboard-schema.postgres.sql"),
      "utf8",
    );
    return await run(client, {
      ...metadata,
      preData: postgres.slice(metadata.preData[0], metadata.preData[1]),
      postData: postgres.slice(metadata.postData[0], metadata.postData[1]),
      expectedCatalog: expectedPostgresCatalog(metadata),
    });
  } finally {
    await client.end();
  }
}

async function artifact(file: string) {
  await using handle = await fs.open(file, "r");
  const { digest, bytes } = await sha256File(handle);
  return { sha256: digest, sizeBytes: bytes };
}

async function inspectHeldAnchor(handle: FileHandle) {
  const workspace = { rootDir: resolvePreferredOpenClawTmpDir(), prefix: "openclaw-anchor-" };
  return await withTempWorkspace(workspace, async ({ dir }) => {
    const file = path.join(dir, "anchor.sqlite");
    {
      await using output = await fs.open(file, "wx", 0o600);
      await copyFileHandle(handle, output);
    }
    const anchor = readBackupEngine(file);
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
  return await withPostgres(params.config, async (client, descriptor) => {
    const raw = path.join(params.directory, ".export.sqlite");
    const image = path.join(params.directory, "database.sqlite");
    const anchorPath = path.join(params.directory, "anchor.sqlite");
    params.assertCurrent();
    await createVerifiedSqliteSnapshot({
      sourcePath: params.sourcePath,
      targetPath: anchorPath,
      preserveRowIds: true,
    });
    let verification;
    {
      params.assertCurrent();
      // The private artifact must exist before the host admits a worker's native open.
      await fs.writeFile(raw, "", { flag: "wx", mode: 0o600 });
      using db = openNodeSqliteDatabase(raw, { readBigInts: true });
      verification = await materializeDatabasePort({
        source: { engine: "postgres", db: client, namespace: anchor.namespace },
        destination: { engine: "sqlite", db },
        descriptor,
        storeId: anchor.storeId,
        assertCurrent: params.assertCurrent,
      });
    }
    const sanitizedDifferences: string[] = [];
    params.assertCurrent();
    if (params.profile === "exact") {
      await fs.rename(raw, image);
    } else {
      const { sanitizeOpenClawGlobalStateSnapshot } =
        await import("../state/openclaw-state-snapshot-sanitizer.js");
      await createVerifiedSqliteSnapshot({
        sourcePath: raw,
        targetPath: image,
        preserveRowIds: true,
        async transform(db) {
          const before = /* sqlite-allow-raw: count the sanitizer's native changes. */ db
            .prepare("SELECT total_changes() AS n")
            .get()?.n;
          sanitizeOpenClawGlobalStateSnapshot(db);
          const { embedSessionColdArchivesInSnapshot } =
            await import("../config/sessions/session-cold-storage-backup.js");
          await embedSessionColdArchivesInSnapshot({
            database: db,
            sourceStorePath: params.sourcePath,
          });
          const after = /* sqlite-allow-raw: count the sanitizer's native changes. */ db
            .prepare("SELECT total_changes() AS n")
            .get()?.n;
          if (after !== before) {
            sanitizedDifferences.push("transient-state");
          }
        },
      });
      await fs.unlink(raw);
    }
    const manifest: PostgresExportEnvelope = {
      schemaVersion: 2,
      snapshotId: path.basename(params.directory),
      createdAt: new Date().toISOString(),
      profile: params.profile,
      source: { ...anchor, owner: descriptor.id, schemaVersion: descriptor.version },
      exportSchemaVersion: descriptor.version,
      activeFragments: [],
      verification,
      artifacts: {
        "database.sqlite": await artifact(image),
        "anchor.sqlite": await artifact(anchorPath),
      },
      sanitizedDifferences,
    };
    params.assertCurrent();
    await writePostgresExportEnvelope(params.directory, manifest);
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
  return await withPostgres(params.config, async (client, descriptor) => {
    const namespace = `restore_${randomUUID().replaceAll("-", "")}`;
    using image = openNodeSqliteDatabase(path.join(params.directory, "database.sqlite"), {
      readOnly: true,
      readBigInts: true,
    });
    params.assertCurrent();
    const verified = await materializeDatabasePort({
      source: { engine: "sqlite", db: image },
      destination: { engine: "postgres", db: client, namespace },
      descriptor,
      storeId: manifest.source.storeId,
      sourceAllocations: manifest.verification.allocations,
      assertCurrent: params.assertCurrent,
    });
    if (params.profile === "exact" && !isDeepStrictEqual(verified, manifest.verification)) {
      throw new Error("Exact PostgreSQL export verification differs from its manifest.");
    }
    params.assertCurrent();
    await fs.copyFile(
      path.join(params.directory, "anchor.sqlite"),
      params.anchorPath,
      fs.constants.COPYFILE_EXCL,
    );
    if (
      !isDeepStrictEqual(await artifact(params.anchorPath), manifest.artifacts["anchor.sqlite"])
    ) {
      throw new Error("PostgreSQL restore anchor changed during preparation.");
    }
    {
      using anchor = openNodeSqliteDatabase(params.anchorPath);
      anchor.prepare("UPDATE openclaw_engine_anchor SET schema = ?").run(namespace);
    }
    return {
      ...(await artifact(params.anchorPath)),
      namespace,
    };
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
      return withPostgres(task.params.config, async (db, descriptor) =>
        createHash("sha256")
          .update(
            JSON.stringify({
              ...anchor,
              version: descriptor.version,
              ...(await inspectDatabasePort(
                { engine: "postgres", db, namespace: anchor.namespace },
                descriptor,
                anchor.storeId,
              )),
            }),
          )
          .digest("hex"),
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
