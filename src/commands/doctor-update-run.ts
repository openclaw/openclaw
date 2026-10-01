import { note } from "../../packages/terminal-core/src/note.js";
import { readResolvedDeferredPluginMigrationWarnings } from "../infra/deferred-plugin-migration-warnings.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import {
  UPDATE_ACTIVATION_TIMEOUT_REASON,
  UPDATE_ENVIRONMENT_FAILURE_REASONS,
} from "../shared/update-outcome.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "../state/openclaw-state-db-readonly.js";

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
    { readInterruptedUpdateCandidateAsync },
  ] = await Promise.all([
    import("../infra/update-run-activity.js"),
    import("../infra/update-run-reader.js"),
    import("../infra/update-run-report.js"),
    import("../infra/update-run-step.js"),
    import("../infra/update-run-interruption.js"),
    import("../infra/update-run-record.js"),
    import("../infra/update-run-interruption-worker.js"),
  ]);
  const reportReconciliationError = (error: unknown) =>
    note(`Update history reconciliation could not complete: ${String(error)}`, "Update history");
  const discovered = await withArtifactPreservingStateReads(() =>
    withOpenClawStateDatabaseReadSnapshot(async () => {
      let candidate: UpdateRunRecord | undefined;
      if (options.migrateState !== false) {
        try {
          candidate = await readInterruptedUpdateCandidateAsync({});
        } catch (error) {
          reportReconciliationError(error);
        }
      }
      return {
        candidate,
        active: await listUpdateRunsAsync({ active: true, limit: 100 }),
        history: await listUpdateRunsAsync({ limit: 100 }),
      };
    }),
  );
  let { active, history } = discovered;
  let reconciled: UpdateRunRecord[] = [];
  if (discovered.candidate) {
    try {
      reconciled = await reconcileInterruptedUpdateRuns({ candidate: discovered.candidate });
      for (const run of reconciled) {
        note(
          `Update ${run.runId}: recorded succeeded after verifying the installed and serving candidate build ${run.after.buildId}; its updater exited before recording completion.`,
          "Update history",
        );
      }
    } catch (error) {
      reportReconciliationError(error);
    }
  }
  if (reconciled.length) {
    // Reconciliation writes live state; notes must not use its discovery snapshot.
    active = await listUpdateRunsAsync({ active: true, limit: 100 });
    history = await listUpdateRunsAsync({ limit: 100 });
  }
  for (const run of active) {
    const guidance = staleUpdateRunGuidance(run);
    if (guidance) {
      note(`Update ${run.runId}: ${guidance}`, "Update history");
    }
  }
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
    const resolvedWarnings = await readResolvedDeferredPluginMigrationWarnings(
      latest.steps.map((step) => step.detail),
    );
    const warningSteps = latest.steps.filter((step) => {
      const completedAtMs = step.detail ? resolvedWarnings.get(step.detail) : undefined;
      return (
        completedAtMs === undefined ||
        completedAtMs < (step.endedAtMs ?? latest.finishedAtMs ?? latest.createdAtMs)
      );
    });
    const warnings = updateRunWarningMessages(warningSteps);
    if (warnings.length) {
      note(
        `Recorded warnings from update ${latest.runId} (a later repair may have resolved them):\n${warnings.slice(-3).join("\n")}`,
        "Update history",
      );
    }
  }
}
