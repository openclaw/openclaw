import path from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { vi } from "vitest";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";

const methods = [
  "constructor",
  "prepare",
  "exec",
  "get",
  "all",
  "run",
  "iterate",
  "close",
] as const;
type Boundary = (typeof methods)[number];
type Bucket = "data" | "unknown";

/** No path is exempt: classification supplements the unfiltered native-call ledger. */
export function observeReconcileHostSqlite(paths: { data: string[] }) {
  const sqlite = requireNodeSqlite();
  const NativeDatabase = sqlite.DatabaseSync;
  const descriptor = Object.getOwnPropertyDescriptor(sqlite, "DatabaseSync")!;
  const statements = new WeakMap<StatementSync, DatabaseSync>();
  const locations = new WeakMap<DatabaseSync, string>();
  const calls: Array<{ method: Boundary; bucket: Bucket; location?: string; sql?: string }> = [];
  const classify = (location: string | undefined): Bucket => {
    if (!location || location === ":memory:" || location.startsWith("file:")) {
      return "unknown";
    }
    const resolved = path.resolve(location);
    return paths.data.includes(resolved) ? "data" : "unknown";
  };
  const record = (method: Boundary, database?: DatabaseSync, sql?: string, opening?: string) => {
    let location = opening ?? (database && locations.get(database));
    if (!location && database) {
      try {
        location = database.location() ?? undefined;
      } catch {
        /* Closed/unknown handles remain counted. */
      }
    }
    calls.push({ method, bucket: classify(location), location, sql });
  };
  Object.defineProperty(sqlite, "DatabaseSync", {
    ...descriptor,
    value: new Proxy(NativeDatabase, {
      construct(target, args, newTarget) {
        const location = typeof args[0] === "string" ? args[0] : undefined;
        record("constructor", undefined, undefined, location);
        const database = Reflect.construct(target, args, newTarget) as DatabaseSync;
        if (location) {
          locations.set(database, location);
        }
        return database;
      },
    }),
  });
  // oxlint-disable-next-line typescript/unbound-method -- The proxy supplies the intercepted database receiver.
  const originalPrepare = NativeDatabase.prototype.prepare;
  const spies = [
    vi.spyOn(NativeDatabase.prototype, "prepare").mockImplementation(
      new Proxy(originalPrepare, {
        apply(target, database: DatabaseSync, args: [string]) {
          record("prepare", database, args[0]);
          const statement = Reflect.apply(target, database, args) as StatementSync;
          statements.set(statement, database);
          return statement;
        },
      }),
    ),
    ...(["exec", "close"] as const).map((method) => {
      const original = NativeDatabase.prototype[method];
      return vi.spyOn(NativeDatabase.prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, database: DatabaseSync, args) {
            record(method, database, typeof args[0] === "string" ? args[0] : undefined);
            return Reflect.apply(target, database, args);
          },
        }),
      );
    }),
    ...(["get", "all", "run", "iterate"] as const).map((method) => {
      const original = sqlite.StatementSync.prototype[method];
      return vi.spyOn(sqlite.StatementSync.prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, statement: StatementSync, args) {
            record(method, statements.get(statement), statement.sourceSQL);
            return Reflect.apply(target, statement, args);
          },
        }),
      );
    }),
  ];
  return {
    calls,
    counts: () =>
      Object.fromEntries(
        methods.map((method) => [method, calls.filter((call) => call.method === method).length]),
      ),
    restore() {
      spies.forEach((spy) => spy.mockRestore());
      Object.defineProperty(sqlite, "DatabaseSync", descriptor);
    },
  };
}
