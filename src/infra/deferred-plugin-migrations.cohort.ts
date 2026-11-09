import { isDeepStrictEqual } from "node:util";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  DEFERRED_PLUGIN_MIGRATION_RUN_PREFIX as RUN_PREFIX,
  type DeferredPluginMigration,
} from "./deferred-plugin-migrations.contract.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import {
  pluginCohortPublicationContext,
  type PluginCohortPublicationContext,
} from "./update-plugin-cohort-context.js";
import { foldPluginCohortMigrationPublications } from "./update-plugin-cohort-records.js";
import {
  PluginCohortMigrationRowSchema,
  type PluginCohortMigrationPublication,
  type PluginCohortRecoveryWriteBinding,
} from "./update-plugin-cohort-schema.js";
import { recordPluginCohortMigrationPublicationInDatabase } from "./update-run-recovery-store.js";

export function captureCohortMigrationContext(
  env: NodeJS.ProcessEnv | undefined,
): PluginCohortPublicationContext | undefined {
  const context = pluginCohortPublicationContext.getStore();
  if (
    !context ||
    resolveOpenClawStateSqlitePath(context.env) !== resolveOpenClawStateSqlitePath(env)
  ) {
    return undefined;
  }
  context.assertCurrent();
  return context;
}

export function cohortMigrationBinding(
  context: PluginCohortPublicationContext | undefined,
): PluginCohortRecoveryWriteBinding | undefined {
  return (
    context && {
      runId: context.runId,
      transactionId: context.transactionId,
      installKey: context.installKey,
    }
  );
}

function readCohortMigrationRows(database: EngineConnection, pluginIds: readonly string[]) {
  const rows =
    pluginIds.length === 0
      ? []
      : executeSqliteQuerySync(
          database,
          getNodeSqliteKysely<Pick<DB, "migration_runs">>(database)
            .selectFrom("migration_runs")
            .select(["id", "started_at", "finished_at", "status", "report_json"])
            .where(
              "id",
              "in",
              pluginIds.map((pluginId) => RUN_PREFIX + pluginId),
            ),
        ).rows;
  return new Map(
    rows.map((row) => [
      row.id.slice(RUN_PREFIX.length),
      {
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        reportJson: row.report_json,
      },
    ]),
  );
}

/** Called inside the obligation owner's existing write transaction. */
export function capturePluginCohortMigrationRowsBeforeWrite(
  db: EngineConnection,
  binding: PluginCohortRecoveryWriteBinding | undefined,
  changes: {
    pending: readonly DeferredPluginMigration[];
    resolvedPluginIds?: readonly string[];
    settlements?: readonly { pluginId: string }[];
  },
) {
  if (!binding) {
    return undefined;
  }
  const pluginIds = [
    ...new Set([
      ...changes.pending.map((entry) => entry.pluginId),
      ...(changes.resolvedPluginIds ?? []),
      ...(changes.settlements?.map((entry) => entry.pluginId) ?? []),
    ]),
  ];
  return { binding, pluginIds, before: readCohortMigrationRows(db, pluginIds) };
}

/** Journal actual SQL results atomically with the obligation status changes. */
export function recordPluginCohortMigrationRowsAfterWrite(
  db: EngineConnection,
  observation: ReturnType<typeof capturePluginCohortMigrationRowsBeforeWrite>,
): void {
  if (!observation) {
    return;
  }
  const after = readCohortMigrationRows(db, observation.pluginIds);
  const rows = observation.pluginIds.flatMap((pluginId) => {
    const before = observation.before.get(pluginId);
    const next = after.get(pluginId);
    return !next || isDeepStrictEqual(before, next)
      ? []
      : [
          {
            pluginId,
            ...(before ? { before: PluginCohortMigrationRowSchema.parse(before) } : {}),
            after: PluginCohortMigrationRowSchema.parse(next),
          },
        ];
  });
  recordPluginCohortMigrationPublicationInDatabase(db, observation.binding, {
    kind: "plugin-migrations",
    rows,
  });
}

/** A rollback restores these rows before it counts settled publications. */
export function hasRestoredPluginCohortMigrationPublications(
  publications: readonly PluginCohortMigrationPublication[],
  options: { env: NodeJS.ProcessEnv },
): boolean {
  if (publications.length === 0) {
    return false;
  }
  const rows = foldPluginCohortMigrationPublications(publications);
  return (
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => {
        if (!tableExists(db, "migration_runs")) {
          return false;
        }
        const current = readCohortMigrationRows(db, [...rows.keys()]);
        return [...rows.values()].some(
          (row) =>
            !isDeepStrictEqual(row.before, row.after) &&
            isDeepStrictEqual(current.get(row.pluginId), row.before),
        );
      },
      { env: options.env },
    ) === true
  );
}

/**
 * The lifecycle owner retains the lease, transaction and cache invalidation.
 * Returns the plugin IDs whose later decision was kept instead of restored.
 */
export function restorePluginCohortMigrationRowsInDatabase(
  db: EngineConnection,
  rows: ReadonlyMap<string, PluginCohortMigrationPublication["rows"][number]>,
  assertCurrent: () => void,
  onRestored: (database: EngineConnection) => void,
): string[] {
  assertCurrent();
  const current = readCohortMigrationRows(db, [...rows.keys()]);
  const preserved: string[] = [];
  const changes = [...rows.values()].filter((row) => {
    const present = current.get(row.pluginId);
    if (isDeepStrictEqual(present, row.before)) {
      return false;
    }
    if (!isDeepStrictEqual(present, row.after)) {
      // A later writer decided this obligation. Keep it; restore the others.
      preserved.push(row.pluginId);
      return false;
    }
    return true;
  });
  const state = getNodeSqliteKysely<Pick<DB, "migration_runs">>(db);
  for (const row of changes) {
    assertCurrent();
    if (row.before) {
      executeSqliteQuerySync(
        db,
        state
          .updateTable("migration_runs")
          .set({
            started_at: row.before.startedAt,
            finished_at: row.before.finishedAt,
            status: row.before.status,
            report_json: row.before.reportJson,
          })
          .where("id", "=", RUN_PREFIX + row.pluginId),
      );
    } else {
      executeSqliteQuerySync(
        db,
        state.deleteFrom("migration_runs").where("id", "=", RUN_PREFIX + row.pluginId),
      );
    }
  }
  if (changes.length > 0) {
    onRestored(db);
  }
  assertCurrent();
  return preserved;
}
