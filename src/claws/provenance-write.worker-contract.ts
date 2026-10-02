import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { clawProvenanceOperations } from "./provenance-write.worker.js";

export type ClawProvenanceWriteOperations = WorkerOperations<typeof clawProvenanceOperations>;
