import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

export function setOpenClawStateCleanupRuntimeForTests(_params: Record<string, never>): void {
  // Retained as a test hook while callers migrate away from file-era cleanup injection.
}

export function resetOpenClawStateCleanupRuntimeForTests(): void {
  // No mutable file-era cleanup hooks remain.
}

export async function cleanupOpenClawStateForTest(): Promise<void> {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}
