import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveLegacyTranscriptPaths } from "../config/sessions/legacy-store-inspection.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import type { DeferredPluginSessionImportSchema } from "./deferred-plugin-session-sources.js";
import {
  databaseIdentity,
  type readDeferredPluginSessionImportReceipt,
  resolveDeferredPluginSessionImportSourceKey,
  preservesRecordedIndexValue,
  sameSourceContent,
} from "./deferred-plugin-session-verification.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { MigrationArtifactIdentity } from "./session-sqlite-migration-artifact.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type SessionTarget = { agentId: string; storePath: string; sqlitePath: string };
export type CapturedSessionReceipt = {
  receipt: NonNullable<ReturnType<typeof readDeferredPluginSessionImportReceipt>>;
  recorded: ReturnType<typeof DeferredPluginSessionImportSchema.parse>;
  index?: {
    identity: MigrationArtifactIdentity;
    bytes: Buffer;
    records: Array<{ sessionId: string; sessionFile: unknown }>;
  };
};

function refuseProjection(detail: string): never {
  throw new Error(
    `Legacy session inputs cannot be rehearsed safely: ${detail}. Preserve the original state and run openclaw doctor --fix against it before retrying the update.`,
  );
}

/** Validate each logical owner before the caller publishes each persisted receipt once. */
export function prepareUpdateCandidateSessionReceipt(params: {
  database: DatabaseSync;
  source: SessionTarget;
  target: SessionTarget;
  sourceDatabaseIdentity: string | undefined;
  captured: CapturedSessionReceipt;
  paths: ReadonlyMap<string, string>;
  env: NodeJS.ProcessEnv;
  sourceEnv: NodeJS.ProcessEnv;
}): () => void {
  const { database, source, target, paths, env } = params;
  const { receipt, recorded } = params.captured;
  const project = (filename: string) => {
    const copied = paths.get(filename);
    if (!copied) {
      refuseProjection("a retained source was not included in the snapshot inventory");
    }
    return copied;
  };
  const copiedDatabaseIdentity = databaseIdentity(target.sqlitePath);
  if (
    recorded.databaseIdentity !== params.sourceDatabaseIdentity &&
    recorded.databaseIdentity === copiedDatabaseIdentity
  ) {
    refuseProjection("a replaced database would inherit an unrelated recorded identity");
  }
  const projected = {
    ...recorded,
    databaseIdentity:
      recorded.databaseIdentity === params.sourceDatabaseIdentity
        ? copiedDatabaseIdentity
        : recorded.databaseIdentity,
    // These hashes remain original, including mismatches that Doctor must diagnose.
    sources: recorded.sources.map((item) => ({ ...item, path: project(item.path) })),
  };
  const index = recorded.sources.find((item) => item.path === path.resolve(source.storePath));
  if (index && params.captured.index) {
    const { bytes, identity, records } = params.captured.index;
    let equivalent = sameSourceContent(index.identity, identity);
    try {
      equivalent ||= preservesRecordedIndexValue(bytes, index.identity);
    } catch {
      // Malformed or changed original bytes remain Doctor's source conflict.
    }
    // A changed index remains a conflict. Equivalent formatting remains recoverable by Doctor.
    if (equivalent) {
      const originals = new Set(recorded.sources.map((item) => item.path));
      const copies = new Set(projected.sources.map((item) => item.path));
      for (const locator of records) {
        const selected = resolveLegacyTranscriptPaths(
          source,
          locator,
          originals,
          params.sourceEnv,
        ).transcriptPath;
        const relocated = resolveLegacyTranscriptPaths(target, locator, copies, env).transcriptPath;
        if (selected && (!originals.has(selected) || project(selected) !== relocated)) {
          refuseProjection(
            "a retained transcript cannot retain its private routing without rewriting its index",
          );
        }
      }
    }
  }
  const sourceKey = receipt.sourceKey;
  const targetKey = resolveDeferredPluginSessionImportSourceKey(target);
  const queries = getNodeSqliteKysely<Pick<DB, "migration_sources" | "migration_runs">>(database);
  const reportJson = JSON.stringify(projected);
  const hasRuns = tableExists(database, "migration_runs");
  const run = hasRuns
    ? executeSqliteQueryTakeFirstSync(
        database,
        queries.selectFrom("migration_runs").selectAll().where("id", "=", sourceKey),
      )
    : undefined;
  if (!run || run.report_json !== receipt.reportJson) {
    refuseProjection("the retained source and its migration run disagree or the run is missing");
  }
  return () =>
    runSqliteImmediateTransactionSync(database, () => {
      // The source row references its run without ON UPDATE CASCADE. Relocate both
      // atomically without disabling foreign-key validation or inventing a missing run.
      executeSqliteQuerySync(
        database,
        queries
          .insertInto("migration_runs")
          .values({ ...run, id: targetKey, report_json: reportJson }),
      );
      const changed = executeSqliteQuerySync(
        database,
        queries
          .updateTable("migration_sources")
          .set({
            source_key: targetKey,
            source_path: target.storePath,
            last_run_id: targetKey,
            report_json: reportJson,
          })
          .where("source_key", "=", sourceKey)
          .where("source_path", "=", path.resolve(source.storePath))
          .where("last_run_id", "=", sourceKey)
          .where("report_json", "=", receipt.reportJson),
      );
      if (changed.numAffectedRows !== 1n) {
        refuseProjection("the retained receipt changed or has inconsistent source ownership");
      }
      executeSqliteQuerySync(
        database,
        queries
          .deleteFrom("migration_runs")
          .where("id", "=", sourceKey)
          .where((eb) =>
            eb.not(
              eb.exists(
                queries
                  .selectFrom("migration_sources")
                  .select("source_key")
                  .where("last_run_id", "=", sourceKey),
              ),
            ),
          ),
      );
    });
}
