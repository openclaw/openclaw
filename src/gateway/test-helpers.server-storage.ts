import path from "node:path";
import { closeIdleSqliteCoordinators } from "../infra/sqlite-coordinator.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { drainOpenClawAgentWriteQueuesForTest } from "../state/openclaw-agent-write-admission.test-support.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export async function closeGatewayTestHomeDatabases(
  home: string,
  options: { restoreEnv: boolean },
): Promise<void> {
  // External stores can still have queued writes using this home’s coordinator.
  await drainOpenClawAgentWriteQueuesForTest();
  // Release leases before deleting their store, and revoke trust in recreated paths.
  await closeOpenClawAgentDatabasesAsync(home);
  closeOpenClawAgentDatabasesForTest(home);
  // External agent stores can retain workers whose lease coordinator belongs to this home.
  await closeOpenClawStateDatabaseByPathAsync(
    resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: path.join(home, ".openclaw") }),
  );
  if (options.restoreEnv) {
    closeIdleSqliteCoordinators(home);
  }
}
