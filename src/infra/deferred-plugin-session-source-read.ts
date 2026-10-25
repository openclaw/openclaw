import path from "node:path";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { resolveRealpathOrAbsolute } from "./boundary-path.js";
import { collectArchivedSources } from "./deferred-plugin-session-artifacts.js";
import {
  DeferredPluginSessionImportSchema,
  type SessionImportSource,
} from "./deferred-plugin-session-import-schema.js";
import type { SessionSqliteMigrationTargetInput as SessionImportTarget } from "./session-sqlite-migration-manifest.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";

export const DEFERRED_PLUGIN_SESSION_IMPORT_RECEIPT_KIND = "deferred-plugin-session-import";

export function resolveDeferredPluginSessionSourceKey(target: SessionImportTarget): string {
  return resolveLegacyMigrationSourceKey(
    DEFERRED_PLUGIN_SESSION_IMPORT_RECEIPT_KIND,
    target.storePath,
    `${target.agentId}\0${path.resolve(target.sqlitePath)}`,
  );
}

export function readDeferredPluginSessionImportReceipt(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env"> & {
    database?: EngineConnection;
  },
) {
  const receipt = readDeferredPluginSessionImportBindingReceipt(params);
  return receipt?.removedSource ? undefined : receipt;
}

/** Archive retirement ends active source custody, not the canonical import's no-replay evidence. */
export function readDeferredPluginSessionImportBindingReceipt(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env"> & {
    database?: EngineConnection;
  },
) {
  const target = { ...params.target, sqlitePath: params.sqlitePath };
  const read = (db: EngineConnection) =>
    tableExists(db, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(db, resolveDeferredPluginSessionSourceKey(target))
      : undefined;
  return params.database
    ? read(params.database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db), { env: params.env });
}

/** Cleanup consumes the same receipt and manifest custody as Doctor, including unresolved sources. */
export function readDeferredPluginSessionArtifactPaths(
  params: Pick<SessionImportSource, "target" | "sqlitePath" | "env">,
): Set<string> {
  const paths = new Set<string>();
  const protect = (file: string) => paths.add(resolveRealpathOrAbsolute(file));
  const receipt = readDeferredPluginSessionImportReceipt(params);
  if (receipt) {
    const recorded = DeferredPluginSessionImportSchema.parse(JSON.parse(receipt.reportJson));
    for (const source of recorded.sources) {
      protect(source.path);
    }
  }
  const archives = collectArchivedSources(
    { ...params.target, sqlitePath: params.sqlitePath },
    params.env,
    true,
  );
  for (const [source, archived] of archives) {
    protect(source);
    for (const artifact of archived) {
      protect(artifact.path);
      for (const dependency of artifact.dependencies) {
        protect(dependency);
      }
    }
  }
  return paths;
}
