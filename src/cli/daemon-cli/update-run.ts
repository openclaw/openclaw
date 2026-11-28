import { sendUpdateResultTelemetry } from "../../infra/update-result-telemetry.js";
import type { UpdateRunLedgerOptions } from "../../infra/update-run-codec.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { finishUpdateRun as finishLedgerRun } from "../../infra/update-run-write.js";

/** Stable recovery entry used by installed managed-update drivers. */
export async function finishDaemonUpdateRun(
  runId: string,
  result: Parameters<typeof finishLedgerRun>[1],
  options: UpdateRunLedgerOptions = {},
): Promise<UpdateRunRecord> {
  const run = finishLedgerRun(
    runId,
    result,
    options,
    (payload) => void sendUpdateResultTelemetry(payload, { env: options.env }),
  );
  return run;
}
