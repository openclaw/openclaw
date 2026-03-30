import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import {
	clearSessionStoreCacheForTest,
	drainSessionStoreLockQueuesForTest,
} from "../config/sessions/store.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";

export async function cleanupSessionStateForTest(): Promise<void> {
	await drainSessionStoreLockQueuesForTest();
	clearSessionStoreCacheForTest();
	await drainFileLockStateForTest();
	await drainSessionWriteLockStateForTest();
}
