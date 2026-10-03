import type { WorkerOperations } from "../state/worker-operation-registry.js";
import type { transcriptWriteOperations } from "./store-worker-write.js";

export type TranscriptWriteOperations = WorkerOperations<typeof transcriptWriteOperations>;
