import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";

export const sqliteMethods = [
  "construct",
  "close",
  "prepare",
  "exec",
  "get",
  "all",
  "run",
  "iterate",
] as const;
type SqliteCounts = Record<(typeof sqliteMethods)[number], number>;
export const emptySqliteCounts = (): SqliteCounts => ({
  construct: 0,
  close: 0,
  prepare: 0,
  exec: 0,
  get: 0,
  all: 0,
  run: 0,
  iterate: 0,
});

export function observeParentSqlite() {
  const sqlite = requireNodeSqlite();
  const { DatabaseSync, StatementSync } = sqlite;
  const counts = emptySqliteCounts();
  const restores: Array<() => void> = [];
  const constructor = Object.getOwnPropertyDescriptor(sqlite, "DatabaseSync");
  if (!constructor?.writable || constructor.value !== DatabaseSync) {
    throw new Error("All eight parent SQLite counters require a writable constructor");
  }
  Object.defineProperty(sqlite, "DatabaseSync", {
    ...constructor,
    value: new Proxy(DatabaseSync, {
      construct(target, args, newTarget) {
        counts.construct += 1;
        return Reflect.construct(target, args, newTarget);
      },
    }),
  });
  restores.push(() => Object.defineProperty(sqlite, "DatabaseSync", constructor));
  try {
    for (const [prototype, names] of [
      [DatabaseSync.prototype, ["close", "prepare", "exec"]],
      [StatementSync.prototype, ["get", "all", "run", "iterate"]],
    ] as const) {
      for (const name of names) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        if (!descriptor?.writable || typeof descriptor.value !== "function") {
          throw new Error(`Parent SQLite counter unavailable: ${name}`);
        }
        Object.defineProperty(prototype, name, {
          ...descriptor,
          value(this: unknown, ...args: unknown[]) {
            counts[name] += 1;
            return Reflect.apply(descriptor.value, this, args);
          },
        });
        restores.push(() => Object.defineProperty(prototype, name, descriptor));
      }
    }
    return {
      counts,
      reset: () => Object.assign(counts, emptySqliteCounts()),
      restore: () => restores.toReversed().forEach((restore) => restore()),
    };
  } catch (error) {
    restores.toReversed().forEach((restore) => restore());
    throw error;
  }
}
