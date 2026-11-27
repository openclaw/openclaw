import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import {
  listWorkshopChangesInDatabase,
  readWorkshopActivityInDatabase,
  recordWorkshopChangeInDatabase,
  type WorkshopChange,
  type WorkshopChangesQuery,
} from "./changes.kernel.js";

export const skillWorkshopOperations = {
  "skills.workshop.activity.read": (input: { agentId: string; skillName: string }, { open }) =>
    readWorkshopActivityInDatabase(open().db, input.agentId, input.skillName),
  "skills.workshop.changes.list": (input: WorkshopChangesQuery, { open }) =>
    listWorkshopChangesInDatabase(open().db, input),
  "skills.workshop.changes.record": (input: WorkshopChange, { open, stateOptions }) =>
    runOpenClawStateWriteTransaction(
      (current) => recordWorkshopChangeInDatabase(current, input),
      { database: open(), ...stateOptions() },
      { operationLabel: "skill-workshop.changes.record" },
    ),
} satisfies WorkerOperationHandlers;
