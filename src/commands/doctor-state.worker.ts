import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "../state/openclaw-state-db-readonly.js";
import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import { readSqliteDatabaseBloat } from "./doctor-db-bloat.read.js";
import { readWorkshopMigrationRecordsInDatabase } from "./doctor-skill-workshop-read.kernel.js";

export const doctorOperations = {
  "doctor.databaseBloat": (_input: undefined, { stateOptions }) =>
    readSqliteDatabaseBloat(stateOptions()),
  "doctor.workshopMigrationRecords.read": (input: { includeEvents: boolean }, { stateOptions }) =>
    withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(
      ({ db }) => readWorkshopMigrationRecordsInDatabase(db, input.includeEvents),
      stateOptions(),
    ),
} satisfies WorkerOperationHandlers;

export type DoctorWorkerOperations = WorkerOperations<typeof doctorOperations>;
