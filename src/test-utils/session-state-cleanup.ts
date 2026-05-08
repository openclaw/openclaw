import { drainFileLockStateForTest } from "../infra/file-lock.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";

let fileLockDrainerForTests: typeof drainFileLockStateForTest | null = null;

export function setSessionStateCleanupRuntimeForTests(params: {
  drainFileLockStateForTest?: typeof drainFileLockStateForTest | null;
}): void {
  if ("drainFileLockStateForTest" in params) {
    fileLockDrainerForTests = params.drainFileLockStateForTest ?? null;
  }
}

export function resetSessionStateCleanupRuntimeForTests(): void {
  fileLockDrainerForTests = null;
}

export async function cleanupSessionStateForTest(): Promise<void> {
  await (fileLockDrainerForTests ?? drainFileLockStateForTest)();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}
