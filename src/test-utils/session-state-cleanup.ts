import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";

export async function cleanupSessionStateForTest(): Promise<void> {
  clearSessionStoreCacheForTest();
  await drainSessionWriteLockStateForTest();
}
