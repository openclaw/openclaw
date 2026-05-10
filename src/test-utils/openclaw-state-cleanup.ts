import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

export async function cleanupOpenClawStateForTest(): Promise<void> {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}
