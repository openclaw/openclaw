// Session store writes are serialized per store path to avoid lost updates.
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

<<<<<<< HEAD
export type RunExclusiveSessionStoreWriteOptions = {
  reentrant?: boolean;
};
=======
/** Runs a callback under the same per-store writer queue used in production. */
export async function withSessionStoreWriterForTest<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await runExclusiveSessionStoreWrite(storePath, fn);
}
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

export async function runExclusiveSessionStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
<<<<<<< HEAD
  opts: RunExclusiveSessionStoreWriteOptions = {},
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
): Promise<T> {
  return await runQueuedStoreWrite({
    queues: WRITER_QUEUES,
    storePath,
    label: "runExclusiveSessionStoreWrite",
    fn,
<<<<<<< HEAD
    reentrant: opts.reentrant,
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });
}
