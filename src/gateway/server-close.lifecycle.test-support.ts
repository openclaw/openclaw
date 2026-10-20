import { DatabaseSync } from "node:sqlite";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";

export function createTestGate(signal: AbortSignal) {
  return <T>(gate: PromiseLike<T>, operation: PromiseLike<unknown>, message: string) =>
    withinTest(awaitGateBeforeSettlement(gate, operation, message), signal);
}

export function readClosedDatabase<T>(path: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}
