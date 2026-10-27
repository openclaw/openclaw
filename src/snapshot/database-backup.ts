import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
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
import type { DatabaseEngineSelection } from "../infra/database-engine/types.js";
import { hasActiveGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import type { BackupTask, Capture, Restore } from "./database-backup.operations.js";
import type { PostgresExportEnvelope } from "./export-envelope.js";
import type { GitBackupIdentity, GitBackupManifest } from "./git-backup-codec.js";
export { captureDatabaseArtifact, assertDatabaseArtifact } from "./database-backup-core.worker.js";
export { verifyMatchedPostgresBackup } from "./database-backup.operations.js";
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

async function runBackupTask<T>(task: BackupTask, assertCurrent: () => void): Promise<T> {
  assertCurrent();
  // This one-shot worker is joined before publication; it never survives a runtime swap.
  const { WorkerTaskPool } = await import("../infra/worker-task-pool.js");
  const source = captureRuntimeWorkerSource(
    resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.databaseBackup),
  );
  const selection =
    getScopedDatabaseEngineSelection() ??
    (await resolveDatabaseEngineSelection(task.params.config));
  assertCurrent();
  return withDatabaseEngineSelection(selection, async () => {
    const pool = new WorkerTaskPool<BackupTask, T>({
      workerUrl: source.moduleUrl,
      maxWorkers: 1,
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
  return runBackupTask<
    Awaited<
      ReturnType<typeof import("./database-backup.operations.js").preparePostgresRestoreInWorker>
    >
  >({ operation: "restore", params }, assertCurrent);
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
