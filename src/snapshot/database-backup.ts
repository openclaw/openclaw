import { AsyncLocalStorage } from "node:async_hooks";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import {
  createConfigReadError,
  createInvalidConfigError,
  formatInvalidConfigDetails,
  isConfigReadFailure,
} from "../config/io.invalid-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDatabaseEngineSelection } from "../infra/database-engine/config.js";
import {
  getScopedDatabaseEngineSelection,
  withDatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import {
  readBackupEngine,
  readBackupEngineImage,
  type BackupEngine,
} from "../infra/database-engine/physical-store.js";
import type { DatabasePortPluginOwners } from "../infra/database-engine/port-descriptor.js";
import {
  withDatabasePortPostgres,
  withDatabasePortConnection,
} from "../infra/database-engine/port-provider.js";
import { admitDatabasePortDescriptor } from "../infra/database-engine/port.worker.js";
import {
  assertPostgresCatalog,
  postgresCatalogQuery,
  readPostgresCatalog,
} from "../infra/database-engine/postgres-catalog.js";
import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { quoteSqliteIdentifier as quote } from "../infra/sqlite-schema-sql.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  captureDatabaseArtifact,
  exportPostgresBackup,
  restorePostgresBackup,
  fingerprintPostgresDatabase,
  discardPostgresNamespace,
} from "./database-backup-core.worker.js";
import {
  readSnapshotExportEnvelope,
  verifyPostgresExportEnvelope,
  type PostgresExportEnvelope,
} from "./export-envelope.js";
import type { GitBackupIdentity, GitBackupManifest } from "./git-backup-codec.js";
export { captureDatabaseArtifact, assertDatabaseArtifact } from "./database-backup-core.worker.js";

export { readBackupEngine, readBackupEngineImage };
export type { BackupEngine };

const offlineBackup = new AsyncLocalStorage<{
  config: OpenClawConfig;
  assertCurrent: () => void;
}>();

export async function runOfflineDatabaseBackup<T>(
  sourcePath: string,
  run: (scope: { config: OpenClawConfig; assertCurrent: () => void }) => Promise<T>,
  prepared?:
    | { config: OpenClawConfig; selection: DatabaseEngineSelection }
    | {
        configPath: string;
        configSourcePath?: string;
        mapIncludePath?: (absolutePath: string) => string;
        env?: NodeJS.ProcessEnv;
      },
): Promise<T> {
  const existing = offlineBackup.getStore();
  if (existing) {
    existing.assertCurrent();
    return run(existing);
  }
  const { runWithLocalStateOwner } = await import("../cli/local-state-owner.js");
  const { resolveStateDir } = await import("../config/paths.js");
  if (hasActiveGatewayStateOwner(path.join(resolveStateDir(), "state", "openclaw.sqlite"))) {
    throw new Error(
      "PostgreSQL backup requires the Gateway stopped; stop through the service owner, then rerun.",
    );
  }
  const { createConfigIO } = await import("../config/config.js");
  return runWithLocalStateOwner({
    method: "backup.create",
    params: {},
    target: sourcePath,
    onForeignOwner: "refuse",
    runLocal: async ({ assertCurrent }) => {
      assertCurrent();
      const captured = prepared && "config" in prepared ? prepared : undefined;
      let config = captured?.config;
      if (!config) {
        const capturedPaths = prepared && "configPath" in prepared ? prepared : undefined;
        const io = createConfigIO({
          ...(prepared && "configPath" in prepared ? prepared : {}),
          observe: false,
          pluginValidation: "core-only",
        });
        const sourceRaw = capturedPaths?.configSourcePath
          ? await fs.readFile(capturedPaths.configSourcePath, "utf8")
          : undefined;
        assertCurrent();
        const snapshot = await (sourceRaw === undefined
          ? io.readConfigFileSnapshot()
          : io.readConfigFileSnapshotFromRaw(sourceRaw));
        assertCurrent();
        if (!snapshot.valid) {
          const details = formatInvalidConfigDetails(snapshot.issues);
          throw isConfigReadFailure(snapshot)
            ? createConfigReadError(snapshot, details)
            : createInvalidConfigError(snapshot.path, details);
        }
        config = snapshot.config;
      }
      const selection = captured?.selection ?? (await resolveDatabaseEngineSelection(config));
      assertCurrent();
      const scope = { config, assertCurrent };
      return withDatabaseEngineSelection(selection, () =>
        offlineBackup.run(scope, () => run(scope)),
      );
    },
  });
}

export async function verifyMatchedPostgresBackup(
  directory: string,
  profile: PostgresExportEnvelope["profile"],
  expectedSource?: { storeId: string; namespace: string },
) {
  if ((await fs.readdir(directory)).includes(".pending")) {
    throw new Error("PostgreSQL backup is incomplete.");
  }
  const envelope = await readSnapshotExportEnvelope(directory);
  if (envelope.engine !== "postgres") {
    throw new Error("Expected a matched PostgreSQL export.");
  }
  await verifyPostgresExportEnvelope(directory, envelope.manifest, inspectHeldAnchor, profile);
  if (
    expectedSource &&
    (envelope.manifest.source.storeId !== expectedSource.storeId ||
      envelope.manifest.source.namespace !== expectedSource.namespace)
  ) {
    throw new Error("PostgreSQL backup belongs to a different store.");
  }
  return envelope.manifest;
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
  pluginOwners?: DatabasePortPluginOwners;
  assertCurrent: () => void;
  gitIdentity?: GitBackupIdentity;
}): Promise<PostgresExportEnvelope> {
  const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
  const anchor = readBackupEngine(params.sourcePath);
  if (anchor.engine !== "postgres") {
    throw new Error("A PostgreSQL backup requires its original anchor.");
  }
  await fs.mkdir(params.directory, { mode: 0o700 });
  await fs.writeFile(path.join(params.directory, ".pending"), "", { flag: "wx", mode: 0o600 });
  return await withDatabasePortPostgres(
    params.config,
    anchor,
    async (client, baseDescriptor) => {
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
    },
    params.pluginOwners,
  );
}

/** Build a new namespace and anchor; the caller alone publishes the anchor. Never drop the old namespace. */
async function preparePostgresRestoreInWorker(params: {
  directory: string;
  anchorPath: string;
  config: OpenClawConfig;
  profile: PostgresExportEnvelope["profile"];
  expectedSource?: { storeId: string; namespace: string };
  pluginOwners?: DatabasePortPluginOwners;
  preserveUpdateHistory?: boolean;
  assertCurrent: () => void;
}) {
  const manifest = await verifyMatchedPostgresBackup(
    params.directory,
    params.profile,
    params.expectedSource,
  );
  return await withDatabasePortConnection(params.config, async (client) => {
    const { loadDatabasePortDescriptor } =
      await import("../infra/database-engine/port-provider-descriptor.js");
    const descriptor = await loadDatabasePortDescriptor(manifest.source.owner, params.config, {
      version: manifest.source.schemaVersion,
      pluginOwners: params.pluginOwners,
    });
    const { namespace } = await restorePostgresBackup({ ...params, client, descriptor, manifest });
    try {
      const input = getScopedDatabaseEngineSelection()?.postgres;
      params.assertCurrent();
      await descriptor.admit?.(params.anchorPath, input);
      if (params.preserveUpdateHistory) {
        if (!params.expectedSource) {
          throw new Error("PostgreSQL update rollback requires its captured source identity.");
        }
        const source = params.expectedSource.namespace;
        const historySchema = [descriptor, ...(descriptor.fragments ?? [])].find((schema) =>
          schema.tables.some((entry) => entry.name === "update_runs"),
        );
        const table = historySchema?.tables.find((entry) => entry.name === "update_runs");
        if (!historySchema || !table) {
          throw new Error(
            "PostgreSQL rollback cannot preserve the current update history contract.",
          );
        }
        const expected = historySchema.expectedCatalog.filter((fact) => fact.table === table.name);
        const catalog = readPostgresCatalog(
          (await client.query(postgresCatalogQuery(source))).rows[0].catalog,
        );
        assertPostgresCatalog(
          catalog.filter((fact) => fact.table === table.name),
          expected,
        );
        const columns = table.columns.map(({ name }) => quote(name)).join(", ");
        await client.query("BEGIN; SET LOCAL synchronous_commit = on");
        try {
          await client.query(`DELETE FROM ${quote(namespace)}.update_runs`);
          await client.query(
            `INSERT INTO ${quote(namespace)}.update_runs (${columns}) SELECT ${columns} FROM ${quote(source)}.update_runs`,
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      }
      // Owner admission can change anchor journal mode; bind the final bytes for publication.
      const { sha256, size: sizeBytes } = await captureDatabaseArtifact(params.anchorPath);
      return { namespace, sha256, sizeBytes };
    } catch (error) {
      await discardPostgresNamespace(client, namespace);
      throw error;
    }
  });
}

type Capture = Parameters<typeof capturePostgresBackupInWorker>[0];
type Restore = Parameters<typeof preparePostgresRestoreInWorker>[0];
type BackupTask =
  | { operation: "discard"; params: { config: OpenClawConfig; namespaces: string[] } }
  | { operation: "capture"; params: Omit<Capture, "assertCurrent"> }
  | { operation: "restore"; params: Omit<Restore, "assertCurrent"> }
  | {
      operation: "family";
      params: {
        sourcePath: string;
        config: OpenClawConfig;
        pluginOwners?: DatabasePortPluginOwners;
      };
    }
  | {
      operation: "fingerprint";
      params: {
        sourcePath: string;
        config: OpenClawConfig;
        pluginOwners?: DatabasePortPluginOwners;
      };
    };
type BackupReply =
  | void
  | PostgresExportEnvelope
  | string
  | Awaited<ReturnType<typeof preparePostgresRestoreInWorker>>;

async function runBackupTask<T>(task: BackupTask, assertCurrent: () => void): Promise<T> {
  assertCurrent();
  // This one-shot worker is joined before publication; it never survives a runtime swap.
  const { WorkerTaskPool } = await import("../infra/worker-task-pool.js");
  const source = captureRuntimeWorkerSource(new URL(import.meta.url));
  const selection =
    getScopedDatabaseEngineSelection() ??
    (await resolveDatabaseEngineSelection(task.params.config));
  assertCurrent();
  return withDatabaseEngineSelection(selection, async () => {
    const pool = new WorkerTaskPool<BackupTask, T>({
      workerUrl: source.moduleUrl,
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
  });
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
  excludeSecrets?: boolean;
}): Promise<GitBackupManifest | undefined> {
  if ((params.physicalEngine ?? readBackupEngine(params.snapshotPath).engine) !== "postgres") {
    return undefined;
  }
  await fs.mkdir(params.outputPath, { mode: 0o700 });
  const exported = await runOfflineDatabaseBackup(
    params.snapshotPath,
    ({ config, assertCurrent }) =>
      capturePostgresBackup({
        sourcePath: params.snapshotPath,
        directory: path.join(params.outputPath, "postgres"),
        profile: "user-backup",
        config,
        assertCurrent,
        ...(params.excludeSecrets ? { gitIdentity: params.identity } : {}),
      }),
  );
  const { gitBackupRedaction } = await import("./git-backup-sanitizer.js");
  const redaction = gitBackupRedaction(
    params.identity,
    new Set(Object.keys(exported.verification.tables)),
    params.excludeSecrets === true,
    exported.source.owner,
  );
  const manifest: GitBackupManifest = {
    schemaVersion: 2,
    identity: params.identity,
    postgresSource: { storeId: exported.source.storeId, namespace: exported.source.namespace },
    userVersion: exported.exportSchemaVersion,
    ...redaction,
    tables: {},
  };
  await fs.writeFile(
    path.join(params.outputPath, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  return manifest;
}

export function discardPostgresRestores(config: OpenClawConfig, namespaces: string[]) {
  return runBackupTask<void>({ operation: "discard", params: { config, namespaces } }, () => {});
}

export function preparePostgresRestore({ assertCurrent, ...params }: Restore) {
  return runBackupTask<Awaited<ReturnType<typeof preparePostgresRestoreInWorker>>>(
    { operation: "restore", params },
    assertCurrent,
  );
}

/** Resolve physical family identity through the same provider admission as capture. */
export function readPostgresBackupFamily(sourcePath: string, config: OpenClawConfig) {
  return runBackupTask<string>({ operation: "family", params: { sourcePath, config } }, () => {});
}

export function fingerprintPostgresBackup(
  sourcePath: string,
  config: OpenClawConfig,
  pluginOwners?: DatabasePortPluginOwners,
) {
  return runBackupTask<string>(
    { operation: "fingerprint", params: { sourcePath, config, pluginOwners } },
    () => {},
  );
}

if (parentPort && workerData?.openclawDatabaseBackup === true) {
  const { serveWorkerTasks } = await import("../infra/worker-task-server.js");
  serveWorkerTasks<BackupReply>((value, _channel, control) => {
    // SAFETY: The private one-shot host is the sole producer of this structured-clone payload.
    const task = value as BackupTask;
    if (task.operation === "discard") {
      return control.runNativeSection(() =>
        withDatabasePortConnection(task.params.config, async (client) => {
          for (const namespace of task.params.namespaces) {
            control.throwIfCancelled();
            await discardPostgresNamespace(client, namespace);
          }
        }),
      );
    }
    if (task.operation === "fingerprint" || task.operation === "family") {
      const anchor = readBackupEngine(task.params.sourcePath);
      if (anchor.engine !== "postgres") {
        throw new Error("PostgreSQL anchor disappeared.");
      }
      if (task.operation === "fingerprint") {
        return withDatabasePortConnection(task.params.config, (client) =>
          fingerprintPostgresDatabase({ client, anchor }),
        );
      }
      return withDatabasePortPostgres(
        task.params.config,
        anchor,
        (_client, descriptor) => Promise.resolve(descriptor.id),
        task.params.pluginOwners,
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
