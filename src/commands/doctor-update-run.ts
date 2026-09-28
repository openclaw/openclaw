import { note } from "../../packages/terminal-core/src/note.js";
import {
  UPDATE_ACTIVATION_TIMEOUT_REASON,
  UPDATE_ENVIRONMENT_FAILURE_REASONS,
} from "../shared/update-outcome.js";

/** Report unfinished or failed update work during Doctor diagnostics. */
export async function noteStaleUpdateRuns(
  options: {
    migrateState?: boolean;
  } = {},
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
    let warningSteps = latest.steps;
    const migrationWarning =
      /^Plugin "([^"]+)" (?:state migration is pending|data\/settings upgrade is unfinished):/u;
    if (warningSteps.some((step) => step.detail && migrationWarning.test(step.detail))) {
      const { readDeferredPluginMigrationCompletionsAsync } =
        await import("../infra/deferred-plugin-migrations.js");
      const completions = new Map(
        (await readDeferredPluginMigrationCompletionsAsync()).map(({ pluginId, completedAtMs }) => [
          pluginId,
          completedAtMs,
        ]),
      );
      warningSteps = warningSteps.filter((step) => {
        const pluginId = step.detail && migrationWarning.exec(step.detail)?.[1];
        const completedAtMs = pluginId ? completions.get(pluginId) : undefined;
        return (
          completedAtMs === undefined ||
          completedAtMs < (step.endedAtMs ?? latest.finishedAtMs ?? latest.createdAtMs)
        );
      });
    }
    const warnings = updateRunWarningMessages(warningSteps);
    if (warnings.length) {
      note(
        `Recorded warnings from update ${latest.runId} (a later repair may have resolved them):\n${warnings.slice(-3).join("\n")}`,
        "Update history",
      );
    }
  }
}
