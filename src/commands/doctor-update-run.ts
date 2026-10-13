import { note } from "../../packages/terminal-core/src/note.js";
import { readRetiredDeferredPluginMigrationWarnings } from "../infra/deferred-plugin-migration-warnings.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import {
  UPDATE_ACTIVATION_TIMEOUT_REASON,
  UPDATE_ENVIRONMENT_FAILURE_REASONS,
} from "../shared/update-outcome.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

/** Report unfinished or failed update work during Doctor diagnostics. */
export async function noteStaleUpdateRuns(
  options: {
    migrateState?: boolean;
  } = {},
): Promise<void> {
  const warnings = new Set<string>();
  const reportReconciliationError = (error: unknown) => {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    warnings.add(`Update history reconciliation could not complete: ${String(error)}`);
  };
  try {
    await inspectStaleUpdateRuns(options, reportReconciliationError);
  } catch (error) {
    reportReconciliationError(error);
  }
  for (const warning of warnings) {
    note(warning, "Update history");
  }
  if (warnings.size && options.migrateState !== false) {
    try {
      await recordUpdateHistoryWarning([...warnings].join("\n"));
    } catch (error) {
      if (hasCommandProcessCleanupError(error)) {
        throw error;
      }
      note(`Update history warning could not be saved: ${String(error)}`, "Update history");
    }
  }
}

async function recordUpdateHistoryWarning(detail: string): Promise<void> {
  const [
    { runExistingOpenClawStateWriteTransaction },
    { executeSqliteQuerySync, executeSqliteQueryTakeFirstSync, getNodeSqliteKysely },
    { decodeRun },
    { encodeRun },
    { updateRunLedgerSchema, upsertStep },
  ] = await Promise.all([
    import("../state/openclaw-state-db-existing-write.js"),
    import("../infra/kysely-sync.js"),
    import("../infra/update-run-read.kernel.js"),
    import("../infra/update-run-codec.js"),
    import("../infra/update-run-write.js"),
  ]);
  runExistingOpenClawStateWriteTransaction(
    ({ db }) => {
      const latest = executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
          .selectFrom("update_runs")
          .selectAll()
          .orderBy("created_at_ms", "desc")
          .orderBy("run_id", "desc")
          .limit(1),
      );
      if (!latest) {
        return;
      }
      const record = decodeRun(latest);
      upsertStep(record, {
        step: "warning:update-history-reconciliation",
        status: "completed",
        detail,
      });
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "update_runs">>(db)
          .updateTable("update_runs")
          .set({ steps_json: encodeRun(record, {}).steps_json })
          .where("run_id", "=", record.runId),
      );
    },
    {},
    { schemaSql: updateRunLedgerSchema, operationLabel: "update.history.warning" },
  );
}

async function inspectStaleUpdateRuns(
  options: { migrateState?: boolean },
  reportReconciliationError: (error: unknown) => void,
): Promise<void> {
  const [
    { staleUpdateRunGuidance },
    { listUpdateRunsAsync },
    { renderUpdateRunReport },
    { updateRunWarningMessages },
    { readInstalledUpdateCandidate, reconcileInterruptedUpdateRuns },
    { isAcknowledgedAbandonedUpdateRun },
  ] = await Promise.all([
    import("../infra/update-run-activity.js"),
    import("../infra/update-run-reader.js"),
    import("../infra/update-run-report.js"),
    import("../infra/update-run-step.js"),
    import("../infra/update-run-interruption.js"),
    import("../infra/update-run-record.js"),
  ]);
  if (options.migrateState !== false) {
    try {
      for (const run of await reconcileInterruptedUpdateRuns()) {
        note(
          `Update ${run.runId}: recorded succeeded after verifying the installed and serving candidate build ${run.after.buildId}; its updater exited before recording completion.`,
          "Update history",
        );
      }
    } catch (error) {
      reportReconciliationError(error);
    }
  }
  for (const run of await listUpdateRunsAsync({ active: true, limit: 100 })) {
    const guidance = staleUpdateRunGuidance(run);
    if (guidance) {
      note(`Update ${run.runId}: ${guidance}`, "Update history");
    }
  }
  const history = await listUpdateRunsAsync({ limit: 100 });
  for (const run of history) {
    if (
      run.status === "failed" &&
      run.reason === "abandoned" &&
      !isAcknowledgedAbandonedUpdateRun(run)
    ) {
      const reason = readInstalledUpdateCandidate(run)
        ? "the recorded candidate has not been verified as installed and serving"
        : "the target build was not recorded, so current version equality cannot prove this update completed";
      note(
        `Update ${run.runId} remains abandoned: ${reason}. Run \`openclaw update repair\` to repair the installation and reconcile its history.`,
        "Update history",
      );
    }
  }
  const [latest] = history;
  if (latest) {
    if (
      latest.status === "failed" &&
      latest.reason &&
      (latest.reason === UPDATE_ACTIVATION_TIMEOUT_REASON ||
        UPDATE_ENVIRONMENT_FAILURE_REASONS.has(latest.reason))
    ) {
      note(`Update ${latest.runId}: ${renderUpdateRunReport(latest).markdown}`, "Update history");
    }
    const retiredWarnings = await readRetiredDeferredPluginMigrationWarnings(
      latest.steps.map((step) => step.detail),
    );
    const warningSteps = latest.steps.filter((step) => !retiredWarnings.has(step.detail ?? ""));
    const warnings = updateRunWarningMessages(warningSteps);
    if (warnings.length) {
      note(
        `Recorded warnings from update ${latest.runId} (a later repair may have resolved them):\n${warnings.slice(-3).join("\n")}`,
        "Update history",
      );
    }
  }
}
