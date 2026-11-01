import type {
  WorkerOperationHandlers,
  WorkerOperations,
} from "../state/worker-operation-registry.js";
import { readSqliteDatabaseBloat } from "./doctor-db-bloat.read.js";

export const doctorOperations = {
  "doctor.databaseBloat": (_input: undefined, { stateOptions }) =>
    readSqliteDatabaseBloat(stateOptions()),
} satisfies WorkerOperationHandlers;

export type DoctorWorkerOperations = WorkerOperations<typeof doctorOperations>;
