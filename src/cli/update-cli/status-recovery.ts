import { formatErrorMessage } from "../../infra/errors.js";
import type { getUpdateRunAsync } from "../../infra/update-run-reader.js";

export async function readUpdateRecoverySetStatus(readRun?: typeof getUpdateRunAsync) {
  try {
    const { inspectUpdateRecoveryBackups } =
      await import("../../infra/update-recovery-backup-status.js");
    const sets = await inspectUpdateRecoveryBackups(readRun);
    return {
      recoverySets: sets.map((set) =>
        set.status === "incomplete" || set.status === "unreadable" || set.status === "warning"
          ? set
          : {
              runId: set.runId,
              manifestPath: set.ref.manifestPath,
              status: set.status,
              message: set.message,
              nextAction: set.nextAction,
            },
      ),
    };
  } catch (error) {
    return { recoverySetsError: formatErrorMessage(error) };
  }
}
