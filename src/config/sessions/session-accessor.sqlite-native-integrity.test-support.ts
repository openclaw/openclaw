import { vi } from "vitest";
import * as sqlite from "../../infra/node-sqlite.js";

const realOpen = sqlite.openNodeSqliteDatabase;

export function observeNativeSqliteIntegrityChecks(databasePath: string, record: () => void): void {
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname !== databasePath || options?.readOnly) {
      return database;
    }
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;" || sql === "PRAGMA integrity_check('sqlite_schema');") {
        const all = statement.all.bind(statement);
        statement.all = () => {
          record();
          return all();
        };
      }
      return statement;
    };
    return database;
  });
}
