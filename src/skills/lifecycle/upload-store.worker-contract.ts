import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { skillUploadOperations } from "./upload-store.worker.js";

export type SkillUploadWorkerOperations = WorkerOperations<typeof skillUploadOperations>;
