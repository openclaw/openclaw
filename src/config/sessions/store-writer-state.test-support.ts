import { drainStoreWriterQueuesForTest } from "../../../test/helpers/promise.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

export async function drainSessionStoreWriterQueuesForTest(): Promise<void> {
  await Promise.all([
    drainStoreWriterQueuesForTest(WRITER_QUEUES, "session store queue cleared for test"),
    drainStoreWriterQueuesForTest(
      SQLITE_SESSION_WRITER_QUEUES,
      "SQLite session store queue cleared for test",
    ),
  ]);
}
