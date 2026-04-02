import { drainSessionWriteLockStateForTest } from "../agents/session-write-lock.js";
import {
  clearSessionStoreCacheForTest,
  drainSessionStoreLockQueuesForTest,
} from "../config/sessions/store.js";
import { drainFileLockStateForTest } from "../infra/file-lock.js";

let fileLockDrainerForTests: typeof drainFileLockStateForTest | null = null;
let sessionStoreLockQueueDrainerForTests: typeof drainSessionStoreLockQueuesForTest | null = null;
let sessionWriteLockDrainerForTests: typeof drainSessionWriteLockStateForTest | null = null;

export function setSessionStateCleanupRuntimeForTests(params: {
  drainFileLockStateForTest?: typeof drainFileLockStateForTest | null;
  drainSessionStoreLockQueuesForTest?: typeof drainSessionStoreLockQueuesForTest | null;
  drainSessionWriteLockStateForTest?: typeof drainSessionWriteLockStateForTest | null;
}): void {
  if ("drainFileLockStateForTest" in params) {
    fileLockDrainerForTests = params.drainFileLockStateForTest ?? null;
  }
  if ("drainSessionStoreLockQueuesForTest" in params) {
    sessionStoreLockQueueDrainerForTests = params.drainSessionStoreLockQueuesForTest ?? null;
  }
  if ("drainSessionWriteLockStateForTest" in params) {
    sessionWriteLockDrainerForTests = params.drainSessionWriteLockStateForTest ?? null;
  }
}

export function resetSessionStateCleanupRuntimeForTests(): void {
  fileLockDrainerForTests = null;
  sessionStoreLockQueueDrainerForTests = null;
  sessionWriteLockDrainerForTests = null;
}

export async function cleanupSessionStateForTest(): Promise<void> {
  await (sessionStoreLockQueueDrainerForTests ?? drainSessionStoreLockQueuesForTest)();
  clearSessionStoreCacheForTest();
  await (fileLockDrainerForTests ?? drainFileLockStateForTest)();
  await (sessionWriteLockDrainerForTests ?? drainSessionWriteLockStateForTest)();
}
