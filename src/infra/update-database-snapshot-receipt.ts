import type { UpdateRunRecord } from "./update-run-record.js";

const LOCATION = "Databases snapshotted at ";

/**
 * Opens the `database snapshot` step's first diagnostic. The run ledger retains that row as
 * `diagnostic:database snapshot`: the only record linking a snapshot directory to its run.
 */
export function formatUpdateDatabaseSnapshotReceipt(directory: string): string {
  return `${LOCATION}${directory}.`;
}

/**
 * The snapshot location a run recorded, as the ledger stores it: the home directory reads
 * `~`, and an install root outside it reads `[path]`, which nothing can resolve.
 */
export function readUpdateDatabaseSnapshotReceipt(
  run: Pick<UpdateRunRecord, "steps">,
): string | undefined {
  const detail = run.steps.find((step) => step.step === "diagnostic:database snapshot")?.detail;
  return detail?.startsWith(LOCATION)
    ? /^(.+?\.databases)\.(?: |$)/u.exec(detail.slice(LOCATION.length))?.[1]
    : undefined;
}
