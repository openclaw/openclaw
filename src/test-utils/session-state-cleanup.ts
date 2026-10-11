// Cleans session-related shared state after tests.
import { mkdtempSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeAuthProfileReadPool } from "../agents/auth-profiles/sqlite-read-pool.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../config/sessions/session-transcript-reconcile.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import { drainSessionStoreWriterQueuesForTest } from "../config/sessions/store-writer-state.test-support.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";
import { closeOpenClawAgentDatabasesAsync } from "../state/openclaw-agent-db-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest } from "./database-cleanup.js";

/** Settle case-owned work while a suite fixture retains its database workers. */
export async function drainSessionStateForTest(
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
}

export async function cleanupSessionStateForTest(
  options: { stateDir?: string; rootPath?: string } = {},
): Promise<void> {
  await drainSessionStateForTest(options);
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

/**
 * Case directories for session stores under one suite root. Session writes leave
 * maintenance and history Workers on each store's agent database; the root is removed
 * only after one drain, so no owner reopens a database mid-removal.
 */
export function useSessionStoreTempDirs(
  registerCleanup: (cleanup: () => Promise<void>) => unknown,
  prefix: string,
): { make(): string } {
  let root: string | undefined;
  registerCleanup(async () => {
    if (!root) {
      return;
    }
    const currentRoot = root;
    root = undefined;
    await closeOpenClawAgentDatabasesAsync(currentRoot);
    // Releasing agent leases can reopen shared state, which cases may keep under the root.
    await closeStateDatabaseForTest();
    await fs.rm(currentRoot, { recursive: true, force: true });
  });
  return {
    make() {
      // openclaw-temp-dir: allow suite-owned session stores require one drain before removal
      root ??= mkdtempSync(path.join(realpathSync.native(os.tmpdir()), prefix));
      // openclaw-temp-dir: allow isolated cases share the suite's database teardown
      return mkdtempSync(path.join(root, "case-"));
    },
  };
}
