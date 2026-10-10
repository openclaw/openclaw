import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { skillWorkshopOperations } from "./changes.worker.js";

export type SkillWorkshopWorkerOperations = WorkerOperations<typeof skillWorkshopOperations>;
