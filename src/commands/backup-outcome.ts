import { existsSync } from "node:fs";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { recordBackupRunOutcome } from "../state/backup-run-records.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

/** Route only the ledger write; archive creation keeps its existing backup owner. */
export async function recordBackupRunOutcomeWithOwner(
  params: Omit<Parameters<typeof recordBackupRunOutcome>[0], "env">,
): Promise<void> {
  const databasePath = resolveOpenClawStateSqlitePath();
  if (!existsSync(databasePath)) {
    return;
  }
  const outcome = {
    ...params,
    createdAt: params.createdAt ?? Date.now(),
    pushFailed: params.pushFailed === true ? true : undefined,
  };
  await runWithLocalStateOwner({
    method: "backup.recordOutcome",
    params: { outcome },
    target: "backup outcome ledger",
    recoveryCommand: "openclaw gateway call backup.status",
    // Config loading must not recreate a database removed while ownership was acquired.
    assertTargetCurrent: () => {
      if (!existsSync(databasePath)) {
        throw new Error("The state database disappeared; the backup outcome was not recorded.");
      }
    },
    runLocal: ({ env, assertCurrent, signal }) =>
      recordBackupRunOutcome({ ...outcome, env }, { assertCurrent, signal }),
  });
}
