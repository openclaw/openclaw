import { note } from "../../packages/terminal-core/src/note.js";
import { repairOpenClawAgentDatabasePaths } from "../state/openclaw-agent-db-path-repair.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { isUpdateDoctorLintPass } from "./doctor/shared/update-phase.js";

/** Repair the inventory only before an updater captures its exact-path baseline. */
export function noteDoctorAgentDatabasePathHealth(params: {
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
}): string[] {
  if (!params.shouldRepair) {
    return [];
  }
  const report = runOpenClawStateWriteTransaction(
    (database) =>
      isUpdateDoctorLintPass(params.env)
        ? {
            repaired: 0,
            warnings: [
              "Skipped agent database path repair during update Doctor. Run openclaw doctor --fix after the update finishes.",
            ],
          }
        : repairOpenClawAgentDatabasePaths(database),
    { env: params.env },
    { operationLabel: "doctor.agent-database-paths" },
  );
  if (report.repaired > 0) {
    invalidateRegisteredAgentDatabasesMemo({ env: params.env });
    note(`Repaired ${report.repaired} agent database path registration(s).`, "Doctor changes");
  }
  if (report.warnings.length > 0) {
    note(report.warnings.join("\n"), "Doctor warnings");
  }
  return report.warnings;
}
