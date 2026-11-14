import { threadId } from "node:worker_threads";
import { createSubsystemLogger } from "../logging/subsystem.js";

type MemorySample = Pick<NodeJS.MemoryUsage, "heapUsed" | "external">;

// A separate lazy entry keeps logging out of small workers and standalone bundle startup.
export function logSlowWorkerIdleGc(
  elapsedMs: number,
  before: MemorySample,
  after: MemorySample,
): void {
  createSubsystemLogger("worker/idle-gc").warn("slow idle worker garbage collection", {
    elapsedMs,
    threadId,
    heapUsedBeforeBytes: before.heapUsed,
    heapUsedAfterBytes: after.heapUsed,
    externalBeforeBytes: before.external,
    externalAfterBytes: after.external,
  });
}
