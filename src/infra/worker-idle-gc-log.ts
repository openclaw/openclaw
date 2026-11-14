import { threadId } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("worker/idle-gc");

/** Loaded only when an idle collection needs a diagnostic warning. */
export function logSlowWorkerIdleGc(
  elapsedMs: number,
  before: Pick<NodeJS.MemoryUsage, "heapUsed" | "external">,
  after: Pick<NodeJS.MemoryUsage, "heapUsed" | "external">,
): void {
  log.warn("slow idle worker garbage collection", {
    elapsedMs,
    threadId,
    heapUsedBeforeBytes: before.heapUsed,
    heapUsedAfterBytes: after.heapUsed,
    externalBeforeBytes: before.external,
    externalAfterBytes: after.external,
  });
}
