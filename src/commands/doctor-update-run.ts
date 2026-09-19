import { note } from "../../packages/terminal-core/src/note.js";
import {
  UPDATE_ACTIVATION_TIMEOUT_REASON,
  UPDATE_ENVIRONMENT_FAILURE_REASONS,
} from "../shared/update-outcome.js";

/** Startup and proven-pristine preflights do not need a public ledger snapshot. */
export async function noteStaleUpdateRuns(options: {
  migrateState?: boolean;
  requireStartupMigrationCheckpoint?: boolean;
  skipPristineStartupStateMigrations?: boolean;
}): Promise<void> {
  if (options.requireStartupMigrationCheckpoint || options.skipPristineStartupStateMigrations) {
    return;
  }
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
      note(`Update history reconciliation could not complete: ${String(error)}`, "Update history");
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
    const warnings = updateRunWarningMessages(latest.steps);
    if (warnings.length) {
      note(
        `Recorded warnings from update ${latest.runId} (a later repair may have resolved them):\n${warnings.slice(-3).join("\n")}`,
        "Update history",
      );
    }
  }
}
