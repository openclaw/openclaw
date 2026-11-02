import { getUpdateRun } from "./update-run-reader.js";

/** Whether an update run has a terminal outcome in this state directory's ledger. */
export function readUpdateRunSettlement(
  runId: string,
  env: NodeJS.ProcessEnv,
): "settled" | "running" | undefined {
  const run = getUpdateRun(runId, { env });
  return run && (run.finishedAtMs === null ? "running" : "settled");
}
