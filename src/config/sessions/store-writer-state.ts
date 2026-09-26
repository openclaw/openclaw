// Shared session-store writer queue state.
import {
  clearStoreWriterQueuesForTest,
  type StoreWriterQueue,
} from "../../shared/store-writer-queue.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import { clearSessionSkillPromptRefCache } from "./skill-prompt-blobs.js";

export const WRITER_QUEUES = new Map<string, StoreWriterQueue>();
// Teardown drains the canonical agent writer before closing SQLite handles.

/** Clears session writer queues and prompt-blob caches for tests. */
export function clearSessionStoreCacheForTest(): void {
  clearSessionSkillPromptRefCache();
  clearStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test");
  clearStoreWriterQueuesForTest(
    SQLITE_SESSION_WRITER_QUEUES,
    "SQLite session store queue cleared for test",
  );
}
