import fs from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { vi } from "vitest";
import * as nodeSqlite from "./node-sqlite.js";
import {
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
} from "./state-database-coordinator.js";

const emptyCounts = () => ({ prepare: 0, exec: 0, close: 0, get: 0, all: 0, run: 0, iterate: 0 });

/** Distinguish token-data work from the existing synchronous lifecycle coordinator. */
export function observeDeviceAuthHostSql(databasePath: string) {
  const coordinatorPath = resolveStateDatabaseCoordinatorPath({
    databasePath,
    runtimeDirectory: captureStateDatabaseCoordinatorRuntime().directory,
    uid: process.getuid?.(),
  });
  const runtimeInitialization = Symbol("coordinator runtime initialization");
  type Source = string | null | typeof runtimeInitialization;
  const databaseLocations = new WeakMap<DatabaseSync, Source>();
  const statementLocations = new WeakMap<StatementSync, Source>();
  const open = nodeSqlite.openNodeSqliteDatabase;
  let openingCoordinator = false;
  const openSpy = vi
    .spyOn(nodeSqlite, "openNodeSqliteDatabase")
    .mockImplementation((pathname, options) => {
      const previous = openingCoordinator;
      openingCoordinator = pathname === coordinatorPath;
      try {
        return open(pathname, options);
      } finally {
        openingCoordinator = previous;
      }
    });
  const location = (database: DatabaseSync) => {
    if (!databaseLocations.has(database)) {
      const pathname = database.location();
      databaseLocations.set(
        database,
        pathname === null && openingCoordinator ? runtimeInitialization : pathname,
      );
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
        coordinator: emptyCounts(),
        runtimeInitialization: emptyCounts(),
        unknown: emptyCounts(),
      };
      const dataPath = canonicalPath(databasePath);
      const controlPath = canonicalPath(coordinatorPath);
      const record = (method: keyof ReturnType<typeof emptyCounts>, source: Source | undefined) => {
        const pathname = typeof source === "string" ? canonicalPath(source) : null;
        const group =
          source === runtimeInitialization
            ? "runtimeInitialization"
            : pathname === dataPath
              ? "data"
              : pathname === controlPath
                ? "coordinator"
                : "unknown";
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
      for (const spy of [
        openSpy,
        ...Object.values(databaseSpies),
        ...Object.values(statementSpies),
      ]) {
        spy.mockRestore();
      }
    },
  };
}
