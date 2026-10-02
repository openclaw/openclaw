import type { publicationOperations } from "./github-publication.worker.js";
import type { WorkerOperations } from "./worker-operation-registry.js";

export type PublicationWorkerOperations = WorkerOperations<typeof publicationOperations>;
