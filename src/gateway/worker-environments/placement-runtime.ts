import type { EngineConnection } from "../../infra/sql-connection.js";

/** Shared database runtime for the placement-store operation modules. */
export type PlacementStoreRuntime = {
  path: string;
  instanceId: string;
  now: () => number;
  read: () => EngineConnection;
  write: <T>(operation: (db: EngineConnection) => T) => T;
};
