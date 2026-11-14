import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("worker/idle-gc");

export function reportSlowIdleWorkerGc(fields: Record<string, number>): void {
  log.warn("slow idle worker garbage collection", fields);
}
