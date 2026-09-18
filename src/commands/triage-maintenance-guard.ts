import { readActiveGatewayLockIdentity } from "../infra/gateway-lock.js";
import { getSelfAndAncestorPidsSync } from "../infra/restart-stale-pids.js";
import {
  acquireGatewayMaintenanceCoordinator,
  StateDatabaseCoordinatorContentionError,
} from "../infra/state-database-coordinator.js";
import { recordedUpdateRunDrivers } from "../infra/update-run-activity.js";
import { inspectUpdateRunDriver } from "../infra/update-run-driver.js";
import { getUpdateRun } from "../infra/update-run-reader.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { TriageMaintenanceBlock } from "./triage-prompt.js";
import type { TriageUpdateFailure } from "./triage-update.js";

/** Detect an active update owner above triage before recommending nested maintenance. */
export async function inspectTriageMaintenanceBlock(
  failure: TriageUpdateFailure | undefined,
  env: NodeJS.ProcessEnv,
): Promise<TriageMaintenanceBlock | undefined> {
  const runId = failure && "result" in failure ? failure.result.runId : undefined;
  if (!runId) {
    return undefined;
  }
  try {
    const run = getUpdateRun(runId, { env });
    if (run?.status !== "running") {
      return undefined;
    }
    const ancestors = getSelfAndAncestorPidsSync(undefined, { requireVerifiedParent: true });
    const driver = recordedUpdateRunDrivers(run).find(
      (candidate) => ancestors.has(candidate.pid) && inspectUpdateRunDriver(candidate) === "alive",
    );
    if (!driver) {
      return undefined;
    }
    try {
      const maintenance = acquireGatewayMaintenanceCoordinator({
        databasePath: resolveOpenClawStateSqlitePath(env),
        busyTimeoutMs: 0,
      });
      maintenance.release();
      return undefined;
    } catch (error) {
      if (!(error instanceof StateDatabaseCoordinatorContentionError)) {
        return undefined;
      }
      const gateway = await readActiveGatewayLockIdentity({ env, requireInspection: true }).catch(
        () => undefined,
      );
      // The lifecycle coordinator is also held by a running Gateway. Its verified
      // lock proves contention is not the ancestor update driver's exclusion, so
      // Doctor must retain the opportunity to admit a matching continuation and
      // stop that managed Gateway itself.
      return gateway && gateway.pid !== driver.pid ? undefined : { runId, pid: driver.pid };
    }
  } catch {
    // Unreadable history cannot safely prove an ancestor-held maintenance scope.
    return undefined;
  }
}
