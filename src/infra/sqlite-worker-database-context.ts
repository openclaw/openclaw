import type { EngineConnection } from "./sql-connection.js";

export type SqliteWorkerDatabaseContext = {
  database: EngineConnection;
  databasePath: string;
  admit(stage: "transaction" | "commit"): void;
};
