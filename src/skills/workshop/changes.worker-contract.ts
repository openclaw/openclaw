import type { WorkshopChange, WorkshopChangesQuery } from "./changes.kernel.js";

export type WorkshopChangesWorkerOperations = {
  "skills.workshop.changes.record": { input: WorkshopChange; output: void };
  "skills.workshop.changes.list": { input: WorkshopChangesQuery; output: WorkshopChange[] };
};
