import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";

export function createTestGate(signal: AbortSignal) {
  return <T>(gate: PromiseLike<T>, operation: PromiseLike<unknown>, message: string) =>
    withinTest(awaitGateBeforeSettlement(gate, operation, message), signal);
}

export function readClosedDatabase(path: string, sql: string, ...params: SQLInputValue[]) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database.prepare(sql).all(...params);
  } finally {
    database.close();
  }
}
