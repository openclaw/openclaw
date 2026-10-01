import type { WorkerOperations } from "../../state/worker-operation-registry.js";
import type { skillWorkshopOperations, skillCuratorOperations } from "./store.worker.js";

export type SkillWorkshopWorkerOperations = WorkerOperations<typeof skillWorkshopOperations>;
export type SkillWorkshopExecutionOperations = Omit<
  SkillWorkshopWorkerOperations,
  "workshop.events.list"
>;

export type SkillCuratorOperations = WorkerOperations<typeof skillCuratorOperations>;
