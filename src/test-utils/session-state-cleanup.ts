import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";

export async function cleanupSessionStateForTest(): Promise<void> {
  clearSessionStoreCacheForTest();
  await drainFileLockStateForTest();
  await drainSessionWriteLockStateForTest();
}
