import { normalizeSessionIdentities } from "../../sessions/session-lifecycle-identity.js";
import { runQueuedStoreWrite } from "../../shared/store-writer-queue.js";
import { WRITER_QUEUES } from "./store-writer-state.js";

type RunExclusiveSessionStoreWriteOptions = {
  reentrant?: boolean;
  identities?: Iterable<string | undefined>;
};

export async function runExclusiveSessionStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
  opts: RunExclusiveSessionStoreWriteOptions = {},
): Promise<T> {
  return await runQueuedStoreWrite({
    queues: WRITER_QUEUES,
    storePath,
    label: "runExclusiveSessionStoreWrite",
    fn,
    reentrant: opts.reentrant,
    keys: opts.identities ? normalizeSessionIdentities(storePath, opts.identities) : undefined,
  });
}
