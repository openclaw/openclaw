import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  MigrationArtifactSchema,
  readMigrationArtifactIdentity,
  sameMigrationArtifact,
  type MigrationArtifactIdentity,
} from "../commands/doctor-session-sqlite-artifact.js";
import {
  filterRestoreManifestTargets,
  listSessionSqliteMigrationManifestPaths,
  readSessionSqliteMigrationManifest,
} from "../commands/doctor-session-sqlite-migration-run.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import type { DeferredPluginMigration } from "./deferred-plugin-migrations.js";
import {
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";

type SessionImportTarget = { agentId: string; storePath: string; sqlitePath: string };
const RECEIPT_KIND = "deferred-plugin-session-import";
const receiptSchema = z.object({
  databaseIdentity: z.string(),
  pluginIds: z.array(z.string()),
  sources: z.array(
    z.object({ path: z.string(), identity: MigrationArtifactSchema.shape.identity }),
  ),
});
export type DeferredPluginSessionImport = z.infer<typeof receiptSchema>;

export function deferredPluginSessionStoreIds(params: {
  target: { agentId: string; storePath: string };
  pending: readonly DeferredPluginMigration[];
}): string[] {
  if (params.target.storePath.endsWith(".sqlite")) {
    return [];
  }
  // The session owner selected this target. An unavailable plugin cannot yet narrow its inputs.
  return params.pending.map((pending) => pending.pluginId);
}

/** File-era repair must not rewrite an original that a deferred owner still needs. */
export function preserveDeferredPluginSessionSource(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  target: { agentId: string; storePath: string };
  pending: readonly DeferredPluginMigration[];
}): boolean {
  if (deferredPluginSessionStoreIds(params).length > 0) {
    return true;
  }
  const sqlite = resolveSqliteTargetFromSessionStorePath(params.target.storePath, {
    agentId: params.target.agentId,
    env: params.env,
  });
  return (
    readDeferredPluginSessionImport({
      target: { ...params.target, sqlitePath: sqlite.path },
      env: params.env,
    }) !== undefined
  );
}

function sourceKey(target: SessionImportTarget): string {
  return resolveLegacyMigrationSourceKey(
    RECEIPT_KIND,
    target.storePath,
    `${target.agentId}\0${path.resolve(target.sqlitePath)}`,
  );
}

function databaseIdentity(sqlitePath: string): string {
  const file = fs.lstatSync(sqlitePath, { bigint: true });
  if (!file.isFile()) {
    throw new Error("The imported session database is no longer a regular file.");
  }
  return `${file.dev}:${file.ino}`;
}

function sourceIsArchived(
  source: DeferredPluginSessionImport["sources"][number],
  target: SessionImportTarget,
  env: NodeJS.ProcessEnv,
): boolean {
  for (const manifestPath of listSessionSqliteMigrationManifestPaths(env)) {
    const manifest = readSessionSqliteMigrationManifest(manifestPath);
    if (!manifest) {
      continue;
    }
    for (const candidate of filterRestoreManifestTargets(manifest, [target])) {
      for (const move of candidate.plannedMoves) {
        if (
          move.sourcePath === source.path &&
          move.artifact &&
          sameMigrationArtifact(move.artifact.identity, source.identity) &&
          fs.existsSync(move.archivePath) &&
          sameMigrationArtifact(readMigrationArtifactIdentity(move.archivePath), source.identity)
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

function matchesVerifiedSessionSource(
  source: DeferredPluginSessionImport["sources"][number],
  target: SessionImportTarget,
  env: NodeJS.ProcessEnv,
): boolean {
  return fs.existsSync(source.path)
    ? sameMigrationArtifact(readMigrationArtifactIdentity(source.path), source.identity)
    : sourceIsArchived(source, target, env);
}

/** A completed core import remains authoritative after canonical sessions change or are deleted. */
export function readDeferredPluginSessionImport(params: {
  target: SessionImportTarget;
  env: NodeJS.ProcessEnv;
  database?: DatabaseSync;
}): DeferredPluginSessionImport | undefined {
  const read = (db: DatabaseSync) =>
    tableExists(db, "migration_sources")
      ? readLegacyMigrationReceiptFromDatabase(db, sourceKey(params.target))
      : undefined;
  const receipt = params.database
    ? read(params.database)
    : withExistingOpenClawStateDatabaseReadOnly(({ db }) => read(db), { env: params.env });
  if (!receipt) {
    return undefined;
  }
  const recorded = receiptSchema.parse(JSON.parse(receipt.reportJson));
  if (recorded.databaseIdentity !== databaseIdentity(params.target.sqlitePath)) {
    throw new Error(
      "The verified session import database changed; retained source was not replayed.",
    );
  }
  for (const source of recorded.sources) {
    if (!matchesVerifiedSessionSource(source, params.target, params.env)) {
      throw new Error(
        `Retained session migration source changed: ${source.path}. Resolve the source conflict before running openclaw doctor --fix again; the verified import was not replayed.`,
      );
    }
  }
  return recorded;
}

/** Reuse verified source bytes only within one uninterrupted synchronous migration loop. */
export function prepareDeferredPluginSessionImportReader(params: {
  storePath: string;
  env: NodeJS.ProcessEnv;
}) {
  const verified = new Map<
    string,
    { receipt: LegacyMigrationReceipt | null; imported: DeferredPluginSessionImport | undefined }
  >();
  return (database: DatabaseSync, agentId: string): SessionImportTarget | undefined => {
    const sqlite = resolveSqliteTargetFromSessionStorePath(params.storePath, {
      agentId,
      env: params.env,
    });
    const target = { agentId, storePath: params.storePath, sqlitePath: sqlite.path };
    const key = sourceKey(target);
    const receipt = readLegacyMigrationReceiptFromDatabase(database, key);
    let prepared = verified.get(key);
    if (!prepared || !isDeepStrictEqual(prepared.receipt, receipt)) {
      prepared = {
        receipt,
        imported: readDeferredPluginSessionImport({ target, env: params.env, database }),
      };
      verified.set(key, prepared);
    }
    if (!prepared.imported) {
      return undefined;
    }
    if (prepared.imported.databaseIdentity !== databaseIdentity(target.sqlitePath)) {
      throw new Error(
        "The verified session import database changed; retained source was not replayed.",
      );
    }
    return target;
  };
}

/** Called after full core import validation, before any original can be retired. */
export function recordDeferredPluginSessionImport(params: {
  target: SessionImportTarget;
  env: NodeJS.ProcessEnv;
  pluginIds: string[];
  sources: Array<{ path: string; identity: MigrationArtifactIdentity }>;
  recordCount: number;
}): void {
  const report: DeferredPluginSessionImport = {
    databaseIdentity: databaseIdentity(params.target.sqlitePath),
    pluginIds: params.pluginIds,
    sources: params.sources,
  };
  const index = params.sources.find(
    (source) => source.path === path.resolve(params.target.storePath),
  );
  if (!index) {
    throw new Error("A deferred session import requires its verified original index.");
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      for (const source of params.sources) {
        if (!matchesVerifiedSessionSource(source, params.target, params.env)) {
          throw new Error(
            "Session migration source changed before its import receipt was recorded.",
          );
        }
      }
      if (report.databaseIdentity !== databaseIdentity(params.target.sqlitePath)) {
        throw new Error("Session import database changed before its receipt was recorded.");
      }
      const key = sourceKey(params.target);
      recordLegacyMigrationReceipt(db, {
        sourceKey: key,
        migrationKind: RECEIPT_KIND,
        sourcePath: path.resolve(params.target.storePath),
        targetTable: "session_nodes",
        sourceSha256: index.identity.sha256,
        sourceSizeBytes: index.identity.size,
        sourceRecordCount: params.recordCount,
        runId: key,
        reportJson: JSON.stringify(report),
        now: Date.now(),
      });
    },
    { env: params.env },
    { operationLabel: "state.retain-plugin-session-source" },
  );
}
