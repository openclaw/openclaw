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
import { requireDirectorySync, syncDirectory } from "../infra/directory-durability.js";
import { copyFileHandle } from "../infra/file-descriptor.js";
import { quoteSqliteIdentifier as quote } from "../infra/sqlite-schema-sql.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
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
