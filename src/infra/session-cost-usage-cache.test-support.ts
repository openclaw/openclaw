import { normalizeAgentId } from "../routing/session-key.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import {
  readSessionCostUsageRollupRowsInDatabase,
  type SessionCostUsageRollupRow,
} from "./session-cost-usage-cache.kernel.js";

export function readSessionCostUsageRollupRows(
  agentId?: string,
  databasePath?: string,
): SessionCostUsageRollupRow[] {
  const result = withOpenClawAgentDatabaseReadOnly(
    ({ db }) => readSessionCostUsageRollupRowsInDatabase(db),
    { agentId: normalizeAgentId(agentId), ...(databasePath ? { path: databasePath } : {}) },
  );
  return result.found ? result.value : [];
}
