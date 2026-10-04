import type { DatabaseSync } from "node:sqlite";

export type SqliteWorkerDatabaseContext = {
  database: DatabaseSync;
  databasePath: string;
  admit(stage: "transaction" | "commit"): void;
};
