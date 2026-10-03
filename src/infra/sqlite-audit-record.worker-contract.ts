import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { diagnosticOperations } from "./sqlite-audit-record.worker.js";

export type DiagnosticWorkerOperations = WorkerOperations<typeof diagnosticOperations>;
