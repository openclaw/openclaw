import { SQLITE_SESSION_WRITER_QUEUES } from "./openclaw-agent-write-admission.js";

/** Joins accepted writes without cancelling queued followers. Stop their producers first. */
export async function drainOpenClawAgentWriteQueuesForTest(
  ownsPath: (storePath: string) => boolean = () => true,
): Promise<void> {
  while (true) {
    const drains = [...SQLITE_SESSION_WRITER_QUEUES].flatMap(([storePath, queue]) =>
      ownsPath(storePath) && queue.drainPromise ? [queue.drainPromise] : [],
    );
    if (drains.length === 0) {
      return;
    }
    await Promise.all(drains);
    // A settling writer can enqueue another store or a fresh drain generation.
  }
}
