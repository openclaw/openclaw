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
const exitAfterCommit = new WeakSet();
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
function install(prepared) {
  if (!prepared) {
    return () => {};
  }
  let exitAfterStatement = false;
  const selected = faults.filter((fault, index) => {
    if (!Atomics.load(enabled, index) || !fault.match.test(prepared.sql)) {
      return false;
    }
    if ("exitOnMatch" in fault) {
      if (Atomics.sub(enabled, index, 1) === 1) {
        if (fault.afterCommit) {
          exitAfterCommit.add(prepared.database);
        } else if (fault.afterStatement) {
          exitAfterStatement = true;
        } else {
          process.exit(1);
        }
      }
      return false;
    }
    return true;
  });
  // TEMP triggers affect the actual write without invalidating the admitted main schema.
  for (const fault of selected) {
    prepared.database.exec(fault.sql);
  }
  return () => {
    if (/^rollback\b/u.test(prepared.sql)) {
      exitAfterCommit.delete(prepared.database);
    }
    if (/^commit\b/u.test(prepared.sql) && exitAfterCommit.delete(prepared.database)) {
      process.exit(1);
    }
    if (exitAfterStatement) {
      process.exit(1);
    }
    for (const fault of selected.toReversed()) {
      prepared.database.exec(`DROP TRIGGER temp.${fault.name}`);
    }
  };
}
const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  const restore = install({ database: this, sql: sql.trim().toLowerCase() });
  try {
    return exec.call(this, sql);
  } finally {
    restore();
  }
};
for (const method of ["run", "get", "all"]) {
  const original = StatementSync.prototype[method];
  StatementSync.prototype[method] = function (...args) {
    const restore = install(statements.get(this));
    try {
      return Reflect.apply(original, this, args);
    } finally {
      restore();
    }
  };
}
const iterate = StatementSync.prototype.iterate;
StatementSync.prototype.iterate = function* (...args) {
  const restore = install(statements.get(this));
  try {
    const iterator = Reflect.apply(iterate, this, args);
    try {
      yield* iterator;
    } finally {
      // yield* does not close its delegate when next() throws; reset the native statement.
      iterator.return?.();
    }
  } finally {
    restore();
  }
};
await import(entry);
