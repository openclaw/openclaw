import { vi } from "vitest";
import * as sqlite from "./node-sqlite.js";

export function captureCoordinatorDatabase<T>(operation: () => T) {
  const open = sqlite.openNodeSqliteDatabase;
  let database: ReturnType<typeof open> | undefined;
  const opening = vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementationOnce((...args) => {
    database = open(...args);
    return database;
  });
  try {
    const result = operation();
    if (!database) {
      throw new Error("Fixture did not open its coordinator");
    }
    return { result, database };
  } finally {
    opening.mockRestore();
  }
}
