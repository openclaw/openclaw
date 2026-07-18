/** Arms the POSIX managed-service rollback transaction after package finalization. */
import {
  readUpdateRollbackTransaction,
  writeUpdateRollbackTransaction,
  type UpdateRollbackTransaction,
} from "../../infra/update-rollback.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";

export async function armManagedServiceUpdateRollback(params: {
  enabled: boolean;
  result: UpdateRunResult;
  currentRoot: string;
  gatewayPort: number;
  serviceEnv?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  if (
    !params.enabled ||
    params.result.status !== "ok" ||
    !params.result.rollback?.retainedPackageRoot ||
    params.result.mode === "git" ||
    params.result.mode === "unknown"
  ) {
    return null;
  }
  const existing = await readUpdateRollbackTransaction(params.serviceEnv ?? process.env);
  const transaction: UpdateRollbackTransaction = {
    ...existing,
    state: "pending",
    newVersion: params.result.after?.version ?? "unknown",
    previousVersion: params.result.before?.version ?? "unknown",
    currentRoot: params.currentRoot,
    retainedRoot: params.result.rollback.retainedPackageRoot,
    gatewayPort: params.gatewayPort,
  };
  return await writeUpdateRollbackTransaction({
    env: params.serviceEnv ?? process.env,
    transaction,
  });
}
