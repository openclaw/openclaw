import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { WorkerOperationHandlers } from "../../state/worker-operation-registry.js";
import {
  listWorkshopChangesInDatabase,
  recordWorkshopChangeInDatabase,
  type WorkshopChange,
  type WorkshopChangesQuery,
} from "./changes.kernel.js";
import {
  readSkillUsageInDatabase,
  recordSkillUsageInDatabase,
  type PreparedSkillUsage,
} from "./skill-usage.kernel.js";

export const skillWorkshopOperations = {
  "skills.workshop.changes.list": (input: WorkshopChangesQuery, { open }) =>
    listWorkshopChangesInDatabase(open().db, input),
  "skills.workshop.changes.record": (input: WorkshopChange, { open, stateOptions }) =>
    runOpenClawStateWriteTransaction(
      (current) => recordWorkshopChangeInDatabase(current, input),
      { database: open(), ...stateOptions() },
      { operationLabel: "skill-workshop.changes.record" },
    ),
  "skills.usage.read": (input: { skillFiles: readonly string[] }, { open }) =>
    readSkillUsageInDatabase(open(), input.skillFiles),
  "skills.usage.record": (input: PreparedSkillUsage, { open, stateOptions }) =>
    runOpenClawStateWriteTransaction((current) => recordSkillUsageInDatabase(current, input), {
      database: open(),
      ...stateOptions(),
    }),
} satisfies WorkerOperationHandlers;
