import { note } from "../../packages/terminal-core/src/note.js";
import { staleUpdateRunGuidance } from "../infra/update-run-activity.js";
import { listUpdateRunsAsync } from "../infra/update-run-reader.js";
import { updateRunWarningMessages } from "../infra/update-run-step.js";

/** Startup and proven-pristine preflights do not need a public ledger snapshot. */
export async function noteStaleUpdateRuns(options: {
  requireStartupMigrationCheckpoint?: boolean;
  skipPristineStartupStateMigrations?: boolean;
}): Promise<void> {
  if (options.requireStartupMigrationCheckpoint || options.skipPristineStartupStateMigrations) {
    return;
  }
  for (const run of await listUpdateRunsAsync({ active: true, limit: 100 })) {
    const guidance = staleUpdateRunGuidance(run);
    if (guidance) {
      note(`Update ${run.runId}: ${guidance}`, "Update history");
    }
  }
  const [latest] = await listUpdateRunsAsync({ limit: 1 });
  if (latest) {
    const warnings = updateRunWarningMessages(latest.steps);
    if (warnings.length) {
      note(
        `Recorded warnings from update ${latest.runId} (a later repair may have resolved them):\n${warnings.slice(-3).join("\n")}`,
        "Update history",
      );
    }
  }
}
