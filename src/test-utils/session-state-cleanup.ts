// Cleans session-related shared state after tests.
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite-read-pool.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../config/sessions/session-transcript-reconcile.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { drainSessionStoreWriterQueuesForTest } from "../config/sessions/store-writer-state.test-support.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";

export async function cleanupSessionStateForTest(
  options: { stateDir?: string; rootPath?: string } = {},
): Promise<void> {
  await drainSessionStoreWriterQueuesForTest();
  if (options.stateDir) {
    // Writers can publish deferred reconciles as the initial drain settles.
    // Finish those owners and their writes before closing fixture databases.
    await waitForSessionTranscriptIndexReconcilesInStateDir(options.rootPath ?? options.stateDir);
    await drainSessionStoreWriterQueuesForTest();
  }
  await drainFileLockStateForTest();
  clearSessionStoreCacheForTest();
  if (!options.stateDir) {
    return;
  }
  const rootPath = options.rootPath ?? options.stateDir;
  closeAuthProfileReadPool({ kind: "root", rootPath });
  // Close agent handles before shared state: releasing their leases can reopen
  // shared state. Unrelated fixtures keep their handles.
  await closeOpenClawAgentDatabasesAsync(rootPath);
  await closeOpenClawStateDatabaseByPathAsync(
    resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: options.stateDir }),
  );
}
