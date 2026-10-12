import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { diagnosticReadOperations } from "./sqlite-audit-record.kernel.js";

export type DiagnosticReadOperations = WorkerOperations<typeof diagnosticReadOperations>;
