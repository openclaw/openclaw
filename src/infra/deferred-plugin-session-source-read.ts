import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../cli/command-format.js";
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
  databaseFileIdentityKey,
  readDatabaseIdentityBirthtime,
} from "./sqlite-worker-identity.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";

export const DEFERRED_PLUGIN_SESSION_IMPORT_RECEIPT_KIND = "deferred-plugin-session-import";

export function databaseIdentity(
  sqlitePath: string,
  kind: "receipt" | "physical" = "receipt",
): string {
  const file = fs.lstatSync(sqlitePath, { bigint: true, throwIfNoEntry: false });
  if (!file?.isFile()) {
    throw new Error(
      `The imported session database is missing or no longer a regular file: ${sqlitePath}. Run ${formatCliCommand("openclaw doctor --session-sqlite recover --session-sqlite-all-agents")} against the same state/config before retrying repair.`,
    );
  }
  // Device numbers can change after a VM reboot; durable receipts bind file creation instead.
  return kind === "physical"
    ? databaseFileIdentityKey(file)
    : `inode:${file.ino}:birthtime:${readDatabaseIdentityBirthtime(file)}`;
}

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
