import { formatErrorMessage } from "../../infra/errors.js";
import { refreshUpdateRunReportArtifact } from "../../infra/update-failure-report-artifact.js";
import type { UpdateRunLedgerOptions } from "../../infra/update-run-codec.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { finishUpdateRun as finishLedgerRun } from "../../infra/update-run-write.js";

/** Stable recovery entry used by installed managed-update drivers. */
export async function finishDaemonUpdateRun(
  runId: string,
  result: Parameters<typeof finishLedgerRun>[1],
  options: UpdateRunLedgerOptions = {},
): Promise<UpdateRunRecord> {
  const run = finishLedgerRun(runId, result, options);
  try {
    await refreshUpdateRunReportArtifact(run, options);
  } catch (error) {
    // The ledger owns the verdict. An unavailable export cannot undo settlement.
    console.warn(`Update report could not be saved: ${formatErrorMessage(error)}`);
  }
  return run;
}
