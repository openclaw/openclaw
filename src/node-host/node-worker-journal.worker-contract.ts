import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { nodeWorkerJournalOperations } from "./node-worker-journal.worker.js";

export type NodeWorkerJournalWorkerOperations = WorkerOperations<
  typeof nodeWorkerJournalOperations
>;
