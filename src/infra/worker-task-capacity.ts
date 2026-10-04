import { availableParallelism } from "node:os";
import { createWorkerComputeCapacity } from "@openclaw/worker-runtime";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export {
  DEFAULT_WORKER_PENDING_TASKS,
  DEFAULT_WORKER_PENDING_BYTES,
} from "@openclaw/worker-runtime";

/** All runtime chunks share the same host-owned computation budget. */
export function getWorkerComputeCapacity() {
  return resolveGlobalSingleton(Symbol.for("openclaw.workerComputeCapacity"), () =>
    createWorkerComputeCapacity(Math.max(1, availableParallelism() - 1)),
  );
}
