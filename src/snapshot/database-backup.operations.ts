import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getScopedDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { readBackupEngineImage } from "../infra/database-engine/physical-store.js";
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
import { DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX } from "../infra/deferred-plugin-migrations.contract.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { quoteSqliteIdentifier as quote } from "../infra/sqlite-schema-sql.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import {
  assertPluginCohortDatabaseRestoreRecords,
  assertPluginCohortDatabaseRestoreMigrations,
  type PluginCohortDatabaseMigrationRow,
} from "../infra/update-plugin-cohort-records.js";
import {
  PLUGIN_COHORT_RECOVERY_KEY_PREFIX,
  type PluginCohortRecoveryBinding,
} from "../infra/update-plugin-cohort-schema.js";
import { UPDATE_RECOVERY_KEY_PREFIX } from "../infra/update-run-recovery-keys.js";
import { decodePluginCohortRecoveryPairRows } from "../infra/update-run-recovery-store.js";
import { INSTALLED_PLUGIN_INDEX_STATE_KEY } from "../plugins/plugin-metadata-state.kernel.js";
import {
  captureDatabaseArtifact,
  exportPostgresBackup,
  restorePostgresBackup,
  discardPostgresNamespace,
} from "./database-backup-core.worker.js";
import {
  readSnapshotExportEnvelope,
  verifyPostgresExportEnvelope,
  type PostgresExportEnvelope,
} from "./export-envelope.js";
import type { GitBackupIdentity } from "./git-backup-codec.js";

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
export async function capturePostgresBackupInWorker(params: {
  sourcePath: string;
  directory: string;
  profile: PostgresExportEnvelope["profile"];
  config: OpenClawConfig;
  pluginOwners?: DatabasePortPluginOwners;
  assertCurrent: () => void;
  gitIdentity?: GitBackupIdentity;
}): Promise<PostgresExportEnvelope> {
  const { createVerifiedSqliteSnapshot } = await import("../infra/sqlite-snapshot.js");
  params.assertCurrent();
  await fs.mkdir(params.directory, { mode: 0o700 });
  await fs.writeFile(path.join(params.directory, ".pending"), "", { flag: "wx", mode: 0o600 });
  const anchorPath = path.join(params.directory, "anchor.sqlite");
  await createVerifiedSqliteSnapshot({
    sourcePath: params.sourcePath,
    targetPath: anchorPath,
    preserveRowIds: true,
  });
  // Identify the captured bytes; reacquiring the live anchor adds another isolated copy.
  const anchor = readBackupEngineImage(anchorPath, params.sourcePath);
  if (anchor.engine !== "postgres") {
    throw new Error("A PostgreSQL backup requires its original anchor.");
  }
  return await withDatabasePortPostgres(
    params.config,
    anchor,
    async (client, baseDescriptor) => {
      const descriptor = await admitDatabasePortDescriptor(
        { engine: "postgres", db: client, namespace: anchor.namespace },
        baseDescriptor,
      );
      params.assertCurrent();
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
export async function preparePostgresRestoreInWorker(params: {
  directory: string;
  anchorPath: string;
  config: OpenClawConfig;
  profile: PostgresExportEnvelope["profile"];
  expectedSource?: { storeId: string; namespace: string };
  pluginOwners?: DatabasePortPluginOwners;
  preserveUpdateHistory?: boolean;
  pluginCohortRecovery?: PluginCohortRecoveryBinding;
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
        if (params.pluginCohortRecovery) {
          const machineStateSchema = [descriptor, ...(descriptor.fragments ?? [])].find((schema) =>
            schema.tables.some((entry) => entry.name === "config_machine_state"),
          );
          if (!machineStateSchema) {
            throw new Error("PostgreSQL rollback cannot preserve plugin cohort recovery storage.");
          }
          assertPostgresCatalog(
            catalog.filter((fact) => fact.table === "config_machine_state"),
            machineStateSchema.expectedCatalog.filter(
              (fact) => fact.table === "config_machine_state",
            ),
          );
        }
        const columns = table.columns.map(({ name }) => quote(name)).join(", ");
        const binding = params.pluginCohortRecovery;
        const keys = binding
          ? [
              UPDATE_RECOVERY_KEY_PREFIX + binding.runId,
              PLUGIN_COHORT_RECOVERY_KEY_PREFIX + binding.runId,
            ]
          : [];
        params.assertCurrent();
        await client.query("BEGIN; SET LOCAL synchronous_commit = on");
        try {
          if (binding) {
            const sourceRows = await client.query<{ state_key: string; value_json: string }>(
              `SELECT state_key,value_json FROM ${quote(source)}.config_machine_state WHERE state_key = ANY($1::text[]) FOR SHARE`,
              [keys],
            );
            const pair = decodePluginCohortRecoveryPairRows(sourceRows.rows, binding);
            if (!pair) {
              throw new Error("PostgreSQL rollback lost its live plugin cohort recovery pair.");
            }
            const indexRows = await client.query<{
              baseline_value: string | null;
              current_value: string | null;
            }>(
              `SELECT (SELECT value_json FROM ${quote(namespace)}.config_machine_state WHERE state_key=$1) AS baseline_value,(SELECT value_json FROM ${quote(source)}.config_machine_state WHERE state_key=$1) AS current_value`,
              [INSTALLED_PLUGIN_INDEX_STATE_KEY],
            );
            const indexRow = indexRows.rows[0];
            if (!indexRow) {
              throw new Error("PostgreSQL rollback did not read its canonical plugin records.");
            }
            assertPluginCohortDatabaseRestoreRecords(
              pair.cohort.publications,
              indexRow.baseline_value ?? undefined,
              indexRow.current_value ?? undefined,
            );
            const migrationRows = async (name: string, present: boolean) =>
              present
                ? (
                    await client.query<PluginCohortDatabaseMigrationRow>(
                      `SELECT id,started_at::float8 AS started_at,finished_at::float8 AS finished_at,status,report_json FROM ${quote(name)}.migration_runs WHERE id LIKE $1`,
                      [DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX + "%"],
                    )
                  ).rows
                : [];
            assertPluginCohortDatabaseRestoreMigrations(
              pair.cohort.publications,
              await migrationRows(
                namespace,
                Object.hasOwn(manifest.verification.tables, "migration_runs"),
              ),
              await migrationRows(
                source,
                catalog.some((fact) => fact.table === "migration_runs"),
              ),
            );
          }
          params.assertCurrent();
          await client.query(`DELETE FROM ${quote(namespace)}.update_runs`);
          params.assertCurrent();
          await client.query(
            `INSERT INTO ${quote(namespace)}.update_runs (${columns}) SELECT ${columns} FROM ${quote(source)}.update_runs`,
          );
          if (binding) {
            params.assertCurrent();
            await client.query(
              `DELETE FROM ${quote(namespace)}.config_machine_state WHERE state_key = ANY($1::text[])`,
              [keys],
            );
            params.assertCurrent();
            await client.query(
              `INSERT INTO ${quote(namespace)}.config_machine_state (state_key,value_json,updated_at_ms) SELECT state_key,value_json,updated_at_ms FROM ${quote(source)}.config_machine_state WHERE state_key = ANY($1::text[])`,
              [keys],
            );
            const restoredRows = await client.query<{ state_key: string; value_json: string }>(
              `SELECT state_key,value_json FROM ${quote(namespace)}.config_machine_state WHERE state_key = ANY($1::text[]) FOR SHARE`,
              [keys],
            );
            if (!decodePluginCohortRecoveryPairRows(restoredRows.rows, binding)) {
              throw new Error(
                "PostgreSQL rollback did not preserve its plugin cohort recovery pair.",
              );
            }
          }
          params.assertCurrent();
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

export type Capture = Parameters<typeof capturePostgresBackupInWorker>[0];
export type Restore = Parameters<typeof preparePostgresRestoreInWorker>[0];
export type BackupTask =
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
export type BackupReply =
  | void
  | PostgresExportEnvelope
  | string
  | Awaited<ReturnType<typeof preparePostgresRestoreInWorker>>;
