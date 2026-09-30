import type { SqliteWorkerBackend } from "./sqlite-worker-contract.js";

type NoOperations = Record<never, never>;

export function createSqliteWorkerBackend(): SqliteWorkerBackend<NoOperations> {
  const cause = Object.assign(new Error("Fixture native open detail"), {
    code: "SQLITE_CANTOPEN",
  });
  throw new AggregateError([cause], "Fixture native open failed", { cause });
}

export const openExistingSqliteWorkerBackend = createSqliteWorkerBackend;
