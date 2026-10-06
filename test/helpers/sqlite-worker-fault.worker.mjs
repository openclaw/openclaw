import { getEnvironmentData, setEnvironmentData } from "node:worker_threads";

const key = "openclaw.test.sqliteWorkerFault";
const { entry, enabled: buffer, rules } = getEnvironmentData(key);
setEnvironmentData(key, undefined);
if (process.versions.bun) {
  const { ensureSqliteLibrarySelected } = await import("../../src/infra/bun-sqlite-library.ts");
  ensureSqliteLibrarySelected();
}
const { DatabaseSync, StatementSync } = await import("node:sqlite");
const enabled = new Int32Array(buffer);
const statements = new WeakMap();
const prepare = DatabaseSync.prototype.prepare;
DatabaseSync.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  statements.set(statement, {
    database: this,
    sql: sql.trimStart().toLowerCase().replaceAll('"', ""),
  });
  return statement;
};
const faults = rules.map((rule) => ({ ...rule, match: new RegExp(rule.pattern, rule.flags) }));
function install(statement) {
  const prepared = statements.get(statement);
  if (!prepared) {
    return () => {};
  }
  const selected = faults.filter(
    (fault, index) => Atomics.load(enabled, index) && fault.match.test(prepared.sql),
  );
  // TEMP triggers affect the actual write without invalidating the admitted main schema.
  for (const fault of selected) {
    prepared.database.exec(fault.sql);
  }
  return () => {
    for (const fault of selected.toReversed()) {
      prepared.database.exec(`DROP TRIGGER temp.${fault.name}`);
    }
  };
}
for (const method of ["run", "get", "all"]) {
  const original = StatementSync.prototype[method];
  StatementSync.prototype[method] = function (...args) {
    const restore = install(this);
    try {
      return Reflect.apply(original, this, args);
    } finally {
      restore();
    }
  };
}
const iterate = StatementSync.prototype.iterate;
StatementSync.prototype.iterate = function* (...args) {
  const restore = install(this);
  try {
    yield* Reflect.apply(iterate, this, args);
  } finally {
    restore();
  }
};
await import(entry);
