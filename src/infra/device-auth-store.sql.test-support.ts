import fs from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { vi } from "vitest";

const emptyCounts = () => ({ prepare: 0, exec: 0, close: 0, get: 0, all: 0, run: 0, iterate: 0 });

/** Observe token-data and unexpected host SQLite work without exempting control databases. */
export function observeDeviceAuthHostSql(databasePath: string) {
  type Source = string | null;
  const databaseLocations = new WeakMap<DatabaseSync, Source>();
  const statementLocations = new WeakMap<StatementSync, Source>();
  const location = (database: DatabaseSync) => {
    if (!databaseLocations.has(database)) {
      databaseLocations.set(database, database.location());
    }
    return databaseLocations.get(database) ?? null;
  };
  const databaseSpies = {
    prepare: vi.spyOn(DatabaseSync.prototype, "prepare"),
    exec: vi.spyOn(DatabaseSync.prototype, "exec"),
    close: vi.spyOn(DatabaseSync.prototype, "close"),
  };
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    const source = location(this);
    const statement = databaseSpies.prepare.call(this, sql);
    statementLocations.set(statement, source);
    return statement;
  };
  DatabaseSync.prototype.exec = function (this: DatabaseSync, sql: string) {
    location(this);
    return databaseSpies.exec.call(this, sql);
  };
  DatabaseSync.prototype.close = function (this: DatabaseSync) {
    location(this);
    return databaseSpies.close.call(this);
  };
  const statementSpies = {
    get: vi.spyOn(StatementSync.prototype, "get"),
    all: vi.spyOn(StatementSync.prototype, "all"),
    run: vi.spyOn(StatementSync.prototype, "run"),
    iterate: vi.spyOn(StatementSync.prototype, "iterate"),
  };
  const canonicalPath = (pathname: string) => {
    try {
      return fs.realpathSync(pathname);
    } catch {
      return pathname;
    }
  };
  return {
    counts() {
      const counts = {
        data: emptyCounts(),
        unknown: emptyCounts(),
      };
      const dataPath = canonicalPath(databasePath);
      const record = (method: keyof ReturnType<typeof emptyCounts>, source: Source | undefined) => {
        const pathname = typeof source === "string" ? canonicalPath(source) : null;
        const group = pathname === dataPath ? "data" : "unknown";
        counts[group][method]++;
      };
      for (const method of ["prepare", "exec", "close"] as const) {
        for (const database of databaseSpies[method].mock.contexts) {
          record(
            method,
            database instanceof DatabaseSync ? databaseLocations.get(database) : undefined,
          );
        }
      }
      for (const method of ["get", "all", "run", "iterate"] as const) {
        for (const statement of statementSpies[method].mock.contexts) {
          record(
            method,
            statement instanceof StatementSync ? statementLocations.get(statement) : undefined,
          );
        }
      }
      return counts;
    },
    restore() {
      for (const spy of [...Object.values(databaseSpies), ...Object.values(statementSpies)]) {
        spy.mockRestore();
      }
    },
  };
}
