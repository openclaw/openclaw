import type { DatabaseSync } from "node:sqlite";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";

export type WorkerEnvironmentKernelOptions = {
  database: OpenClawStateDatabase;
  now: () => number;
  write: <T>(operation: (db: DatabaseSync) => T) => T;
};
