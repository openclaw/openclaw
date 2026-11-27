import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { withTempWorkspace } from "@openclaw/fs-safe/temp";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getScopedDatabaseEngineSelection } from "../infra/database-engine/context.js";
import { readBackupEngineImage } from "../infra/database-engine/physical-store-inspection.js";
import { readBackupEngine } from "../infra/database-engine/physical-store.js";
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
import {
  postgresCopyAclSql,
  preflightPostgresCopyAcl,
} from "../infra/database-engine/postgres-copy-acl.js";
import { readPostgresPortCapabilities } from "../infra/database-engine/postgres-port-capabilities.js";
import {
  assertDatabasePortNamespaceOwner,
  readPostgresStoreMetadata,
} from "../infra/database-engine/postgres-store-metadata.js";
import { DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX } from "../infra/deferred-plugin-migrations.contract.js";
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { quoteSqliteIdentifier as quote } from "../infra/sqlite-schema-sql.js";
import { createVerifiedSqliteSnapshot } from "../infra/sqlite-snapshot.js";
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
  capturePostgresSchema,
  clonePostgresSchema,
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
  /** Keep an exact capture on its server; omit it for the portable SQLite export. */
  carrier?: "postgres-schema";
  /** Doctor owns local directory retention; other captures retire through their manifest. */
  prune?: { directoryPrefix: string; captureId: string };
}): Promise<PostgresExportEnvelope> {
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
      const manifest = params.carrier
        ? await capturePostgresSchema({ ...params, client, descriptor, anchor })
        : await exportPostgresBackup({ ...params, client, descriptor, anchor });
      try {
        await verifyPostgresExportEnvelope(
          params.directory,
          manifest,
          inspectHeldAnchor,
          params.profile,
        );
        await fs.unlink(path.join(params.directory, ".pending"));
      } catch (error) {
        // An incomplete capture must not leave its server copy behind.
        if (manifest.schema) {
          await discardPostgresNamespace(client, manifest.schema);
        }
        throw error;
      }
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

function requirePostgresUpgradeAnchor(sourcePath: string) {
  const anchor = readBackupEngine(sourcePath);
  if (anchor.engine !== "postgres") {
    throw new Error("A protected PostgreSQL upgrade requires its original anchor.");
  }
  return anchor;
}

/** Read the physical version without opening a writable family connection. */
export async function inspectPostgresUpgradeInWorker(params: {
  sourcePath: string;
  config: OpenClawConfig;
}) {
  const anchor = requirePostgresUpgradeAnchor(params.sourcePath);
  return withDatabasePortConnection(params.config, async (client) => {
    const { store: family, version, minReader } = await readPostgresStoreMetadata(client, anchor);
    // Total relation size already includes indexes and TOAST. Partition parents
    // have no storage; their ordinary-table partitions are counted individually.
    const size = await client.query<{ physical_bytes: string }>(
      "SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::text AS physical_bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r', 'm')",
      [anchor.namespace],
    );
    const physicalBytes = Number(size.rows[0]!.physical_bytes);
    const retainedAgentIds: string[] = [];
    const registeredAgentDatabases: { agentId: string; path: string }[] = [];
    if (family === "state") {
      const present = await client.query(
        "SELECT to_regclass($1) IS NOT NULL AS present, to_regclass($2) IS NOT NULL AS registered",
        [
          `${quote(anchor.namespace)}.agent_deletion_journal`,
          `${quote(anchor.namespace)}.agent_databases`,
        ],
      );
      if (present.rows[0]?.present) {
        const retained = await client.query<{ agent_id: string }>(
          `SELECT agent_id FROM ${quote(anchor.namespace)}.agent_deletion_journal WHERE cleanup_completed = 1 AND delete_files = 0`,
        );
        retainedAgentIds.push(...retained.rows.map((row) => row.agent_id));
      }
      if (present.rows[0]?.registered) {
        const registered = await client.query<{ agent_id: string; path: string }>(
          `SELECT agent_id, path FROM ${quote(anchor.namespace)}.agent_databases`,
        );
        registeredAgentDatabases.push(
          ...registered.rows.map((row) => ({ agentId: row.agent_id, path: row.path })),
        );
      }
    }
    return {
      ...anchor,
      family,
      version,
      minReader,
      physicalBytes,
      retainedAgentIds,
      registeredAgentDatabases,
    };
  });
}

/** Check every source before the first private namespace is allocated. */
export async function preflightPostgresUpgradeInWorker(params: {
  sourcePaths: string[];
  config: OpenClawConfig;
}) {
  for (const sourcePath of params.sourcePaths) {
    const anchor = requirePostgresUpgradeAnchor(sourcePath);
    await withDatabasePortPostgres(params.config, anchor, async (client, baseDescriptor) => {
      const permission = await client.query<{
        allowed: boolean;
        database: string;
        role: string;
      }>(
        "SELECT has_database_privilege(current_database(), 'CREATE') AS allowed, current_database() AS database, current_user AS role",
      );
      const access = permission.rows[0];
      if (!access?.allowed) {
        throw new Error(
          access
            ? `Protected PostgreSQL upgrade requires CREATE on the configured database. Run GRANT CREATE ON DATABASE ${quote(access.database)} TO ${quote(access.role)}; then retry the update.`
            : "Protected PostgreSQL upgrade could not inspect database CREATE permission.",
        );
      }
      await assertDatabasePortNamespaceOwner(client, anchor.namespace);
      await preflightPostgresCopyAcl(client, anchor.namespace);
      const descriptor = await admitDatabasePortDescriptor(
        { engine: "postgres", db: client, namespace: anchor.namespace },
        baseDescriptor,
      );
      await readPostgresPortCapabilities(client, descriptor);
    });
  }
}

/** The carrier's first verified server copy is the private upgrade destination. */
export async function clonePostgresUpgradeInWorker(params: {
  sourcePath: string;
  anchorPath: string;
  config: OpenClawConfig;
  assertCurrent: () => void;
}) {
  params.assertCurrent();
  if (path.resolve(params.sourcePath) === path.resolve(params.anchorPath)) {
    throw new Error("A protected PostgreSQL copy requires a private anchor path.");
  }
  // The shadow tree already contains an anchor; replace only that private file.
  await fs.unlink(params.anchorPath).catch(ignoreMissingPath);
  await createVerifiedSqliteSnapshot({
    sourcePath: params.sourcePath,
    targetPath: params.anchorPath,
    preserveRowIds: true,
  });
  const anchor = requirePostgresUpgradeAnchor(params.anchorPath);
  return withDatabasePortPostgres(params.config, anchor, async (client, baseDescriptor) => {
    const descriptor = await admitDatabasePortDescriptor(
      { engine: "postgres", db: client, namespace: anchor.namespace },
      baseDescriptor,
    );
    const { namespace } = await clonePostgresSchema({
      ...params,
      client,
      anchor,
      descriptor: {
        ...descriptor,
        postgresPostData: (destinationNamespace) =>
          `${descriptor.postgresPostData?.(destinationNamespace) ?? ""}\n;\n` +
          postgresCopyAclSql(client, anchor.namespace, destinationNamespace),
      },
    });
    try {
      params.assertCurrent();
      using privateAnchor = openNodeSqliteDatabase(params.anchorPath);
      privateAnchor.prepare("UPDATE openclaw_engine_anchor SET schema = ?").run(namespace);
      return { namespace };
    } catch (error) {
      await discardPostgresNamespace(client, namespace);
      throw error;
    }
  }).catch((error: unknown) => {
    if (isRecord(error) && error.code === "53100") {
      throw new Error(
        "The PostgreSQL server has insufficient disk space for the protected database copy. The original PostgreSQL data was not migrated. Free space on the PostgreSQL server, then run openclaw update.",
        { cause: error },
      );
    }
    throw error;
  });
}

/** Adoption requires both exact role ownership and the preserved anchor's physical store ID. */
export async function retirePostgresUpgradeInWorker(params: {
  anchorPath: string;
  config: OpenClawConfig;
  activeAnchors: string[];
}) {
  const anchor = requirePostgresUpgradeAnchor(params.anchorPath);
  for (const activePath of params.activeAnchors) {
    const active = readBackupEngine(activePath);
    if (active.engine === "postgres" && active.namespace === anchor.namespace) {
      throw new Error("Refusing to retire an active PostgreSQL namespace.");
    }
  }
  await withDatabasePortConnection(params.config, async (client) => {
    // A crash after DROP but before file pruning leaves the same preserved anchor.
    const present = await client.query(
      "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = $1) AS present",
      [anchor.namespace],
    );
    if (!present.rows[0]?.present) {
      return;
    }
    await assertDatabasePortNamespaceOwner(client, anchor.namespace);
    await readPostgresStoreMetadata(client, anchor);
    await client.query(`DROP SCHEMA ${quote(anchor.namespace)} CASCADE`);
  });
}

export type PostgresUpgradeInspection = {
  engine: "postgres";
  storeId: string;
  namespace: string;
  family: string;
  version: number;
  minReader: number;
  physicalBytes: number;
  retainedAgentIds: string[];
  registeredAgentDatabases: { agentId: string; path: string }[];
};
type PostgresUpgradeClone = Parameters<typeof clonePostgresUpgradeInWorker>[0];
type PostgresUpgradeRetirement = Parameters<typeof retirePostgresUpgradeInWorker>[0];

export type Capture = Parameters<typeof capturePostgresBackupInWorker>[0];
export type Restore = Parameters<typeof preparePostgresRestoreInWorker>[0];
export type BackupTask =
  | { operation: "inspect-upgrade"; params: { sourcePath: string; config: OpenClawConfig } }
  | { operation: "preflight-upgrade"; params: { sourcePaths: string[]; config: OpenClawConfig } }
  | { operation: "clone-upgrade"; params: Omit<PostgresUpgradeClone, "assertCurrent"> }
  | { operation: "retire-upgrade"; params: PostgresUpgradeRetirement }
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
      operation: "prune";
      params: { sourcePath: string; config: OpenClawConfig; directoryPrefix: string };
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
  | PostgresUpgradeInspection
  | { namespace: string }
  | PostgresExportEnvelope
  | string
  | string[]
  | Awaited<ReturnType<typeof preparePostgresRestoreInWorker>>;
