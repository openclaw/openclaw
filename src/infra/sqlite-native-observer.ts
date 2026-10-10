import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { hasErrnoCode } from "./errno.js";
import { classifySqliteMutation } from "./sqlite-schema-mutation.js";

declare module "node:sqlite" {
  interface StatementSync {
    /** Node 26.8+ supports finalization; older supported runtimes omit this method. */
    close?(): void;
    [Symbol.dispose]?(): void;
  }
}

export type SqliteIteratorBehavior = Readonly<{
  nextAfterDoneIsTerminal: boolean;
  returnAfterDoneIsInert: boolean;
}>;
export type NativeSqlite = Pick<typeof import("node:sqlite"), "DatabaseSync" | "StatementSync"> & {
  iteratorBehavior: SqliteIteratorBehavior;
};

/** The runtime owner reuses its prepared one-row library probe, once per process load. */
export function probeSqliteIteratorBehavior(statement: StatementSync): SqliteIteratorBehavior {
  const previous = statement.iterate();
  previous.next();
  previous.next();
  const nextAfterDoneIsTerminal = previous.next().done === true;
  previous.return?.();
  const current = statement.iterate();
  try {
    current.next();
    previous.return?.();
    return { nextAfterDoneIsTerminal, returnAfterDoneIsInert: current.next().done === true };
  } finally {
    current.return?.();
  }
}
const pending = resolveGlobalSingleton(
  Symbol.for("openclaw.sqliteNativeExecution"),
  () => new WeakMap<DatabaseSync, number>(),
);

/** Execution custody is not evidence of COMMIT or complete authority write-set coverage. */
export function hasPendingSqliteNativeExecution(database: DatabaseSync): boolean {
  return (pending.get(database) ?? 0) > 0;
}

export type SqliteNativeMutation = ReturnType<typeof classifySqliteMutation>;
type NativePhase = "exec" | "execute" | "bind" | "iterate";
type NativeOperation = {
  finish: (succeeded: boolean, abandoned?: boolean) => void;
  stepped?: () => void;
  expire?: () => void;
};
type IteratorLifetime = {
  observed?: NativeOperation;
  finished: boolean;
  invalidated: boolean;
  finish: (succeeded?: boolean, abandoned?: boolean) => void;
  invalidate: () => void;
  pause: () => void;
  expire: () => void;
  stopObservation: (succeeded?: boolean, abandoned?: boolean) => void;
};

const iteratorFinalizer = new FinalizationRegistry<Set<IteratorLifetime>>((lifetimes) => {
  for (const lifetime of lifetimes) {
    lifetime.finish(false, true);
  }
});

// Finalizer holdings must not share a closure with the statement or its bound methods.
function createIteratorLifetime(
  active: Set<IteratorLifetime>,
  activeIterators: Set<IteratorLifetime>,
): IteratorLifetime {
  const lifetime: IteratorLifetime = {
    finished: false,
    invalidated: false,
    expire: () => lifetime.observed?.expire?.(),
    pause: () => lifetime.stopObservation(),
    invalidate: () => {
      lifetime.invalidated = true;
      lifetime.finish();
    },
    stopObservation: (succeeded = false, abandoned = false) => {
      const previous = lifetime.observed;
      lifetime.observed = undefined;
      activeIterators.delete(lifetime);
      previous?.finish(succeeded, abandoned);
    },
    finish: (succeeded = false, abandoned = false) => {
      if (!lifetime.finished) {
        lifetime.finished = true;
        active.delete(lifetime);
        lifetime.stopObservation(succeeded, abandoned);
      }
    },
  };
  active.add(lifetime);
  return lifetime;
}
const bindingMutation: SqliteNativeMutation = {
  schemaChange: false,
  mainSchemaChange: false,
  dataChange: false,
  control: undefined,
};

function refusedBeforeReset(error: unknown): boolean {
  // Node checks these native states before ResetStatement; bindings are checked afterward.
  return (
    error instanceof Error &&
    hasErrnoCode(error, "ERR_INVALID_STATE") &&
    [
      "statement has been finalized",
      "database cannot be accessed from an authorizer callback",
      "statement is already being executed",
      "iterator was invalidated",
    ].includes(error.message)
  );
}

/** Dispose callbacks may refuse close; native custody expires only after SQLite has closed. */
export function observeSqliteNativeClose(database: DatabaseSync, onClose: () => void): void {
  for (const method of ["close", Symbol.dispose] as const) {
    if (typeof database[method] !== "function") {
      continue;
    }
    const close = database[method].bind(database);
    database[method] = () => {
      try {
        close();
      } finally {
        if (!database.isOpen) {
          onClose();
        }
      }
    };
  }
}

function callStatement<Result>(
  method: {
    (...parameters: SQLInputValue[]): Result;
    (named: Record<string, SQLInputValue>, ...parameters: SQLInputValue[]): Result;
  },
  bindings: [(SQLInputValue | Record<string, SQLInputValue>)?, ...SQLInputValue[]],
): Result {
  // Preserve native validation of invalid arguments, including explicit undefined.
  return Reflect.apply(method, undefined, bindings);
}

/** Native callbacks can mutate from any SQL, including SELECT and retained prepared statements. */
export function observeSqliteNativeOperations(
  database: DatabaseSync,
  native: NativeSqlite,
  observe: (mutation: SqliteNativeMutation, phase: NativePhase) => NativeOperation,
): <T>(operation: () => T, mutation: SqliteNativeMutation) => T {
  const begin = (mutation: SqliteNativeMutation, phase: NativePhase): NativeOperation => {
    const observed = observe(mutation, phase);
    pending.set(database, (pending.get(database) ?? 0) + 1);
    return {
      ...observed,
      finish(succeeded, abandoned) {
        try {
          observed.finish(succeeded, abandoned);
        } finally {
          const remaining = (pending.get(database) ?? 1) - 1;
          if (remaining === 0) {
            pending.delete(database);
          } else {
            pending.set(database, remaining);
          }
        }
      },
    };
  };
  const activeIterators = new Set<IteratorLifetime>();
  // A callback can propagate a nested native refusal after its caller already reset SQLite.
  const failures: Array<Set<unknown> | undefined> = [];
  const isPreResetRefusal = (error: unknown) =>
    refusedBeforeReset(error) && !failures.at(-1)?.has(error);
  const propagate = (error: unknown) => {
    if (failures.length > 1) {
      (failures[failures.length - 2] ??= new Set()).add(error);
    }
  };
  const execute = <T>(
    operation: () => T,
    mutation: SqliteNativeMutation,
    phase: NativePhase = "execute",
  ): T => {
    const observed = begin(mutation, phase);
    let succeeded = false;
    failures.push(undefined);
    try {
      const result = operation();
      if (phase !== "bind") {
        observed.stepped?.();
      }
      succeeded = true;
      return result;
    } catch (error) {
      propagate(error);
      throw error;
    } finally {
      failures.pop();
      observed.finish(succeeded);
    }
  };
  database.exec = (sql) =>
    execute(
      () => native.DatabaseSync.prototype.exec.call(database, sql),
      classifySqliteMutation(sql, "batch"),
      "exec",
    );
  database.prepare = (...prepareArgs) => {
    const statement = native.DatabaseSync.prototype.prepare.call(database, ...prepareArgs);
    const mutation = classifySqliteMutation(prepareArgs[0], "statement");
    const run = Object.hasOwn(statement, "run") ? statement.run.bind(statement) : undefined;
    const get = Object.hasOwn(statement, "get") ? statement.get.bind(statement) : undefined;
    const all = Object.hasOwn(statement, "all") ? statement.all.bind(statement) : undefined;
    const iterate = Object.hasOwn(statement, "iterate")
      ? statement.iterate.bind(statement)
      : undefined;
    const active = new Set<IteratorLifetime>();
    let registered = false;
    const reset = <T>(operation: () => T, kind: "reuse" | "finalize" | "return" = "reuse"): T => {
      if (active.size === 0) {
        return operation();
      }
      const previous = [...active];
      for (const lifetime of previous) {
        lifetime.expire();
      }
      let result: T;
      try {
        result = operation();
      } catch (error) {
        if (kind === "reuse" && !isPreResetRefusal(error)) {
          for (const lifetime of previous) {
            try {
              lifetime.invalidate();
            } catch {
              /* Preserve the native binding or execution error. */
            }
          }
        }
        throw error;
      }
      for (const lifetime of previous) {
        if (kind === "return") {
          lifetime.pause();
        } else {
          lifetime.invalidate();
        }
      }
      return result;
    };
    const wrap =
      <Result>(resolve: () => Parameters<typeof callStatement<Result>>[0]) =>
      (...bindings: Parameters<typeof callStatement<Result>>[1]): Result =>
        execute(() => reset(() => callStatement(resolve(), bindings)), mutation);
    statement.run = wrap(() => run ?? native.StatementSync.prototype.run.bind(statement));
    statement.get = wrap(() => get ?? native.StatementSync.prototype.get.bind(statement));
    statement.all = wrap(() => all ?? native.StatementSync.prototype.all.bind(statement));
    statement.iterate = (...bindings) => {
      if (!registered) {
        // Iterator collection alone does not reset a still-reachable native statement.
        iteratorFinalizer.register(statement, active);
        registered = true;
      }
      // Native iterate resets and binds immediately, but does not step until next().
      const rows = execute(
        () =>
          reset(() =>
            callStatement(
              iterate ?? native.StatementSync.prototype.iterate.bind(statement),
              bindings,
            ),
          ),
        bindingMutation,
        "bind",
      );
      const reference = new WeakRef(rows);
      let done = false;
      const lifetime = createIteratorLifetime(active, activeIterators);
      // oxlint-disable-next-line typescript/unbound-method -- Wrappers pass the native receiver unchanged.
      const nativeNext = rows.next;
      // oxlint-disable-next-line typescript/unbound-method -- Wrappers pass the native receiver unchanged.
      const nativeReturn = rows.return;
      rows.next = function (this: typeof rows, ...args) {
        if (this !== reference.deref() || lifetime.invalidated || done || !database.isOpen) {
          return nativeNext.apply(this, args);
        }
        if (lifetime.finished) {
          lifetime.finished = false;
          active.add(lifetime);
        }
        const alreadyObserved = lifetime.observed !== undefined;
        lifetime.observed ??= begin(mutation, "iterate");
        activeIterators.add(lifetime);
        failures.push(undefined);
        try {
          const result = nativeNext.apply(this, args);
          if (result.done) {
            done = native.iteratorBehavior.nextAfterDoneIsTerminal;
            if (done) {
              lifetime.finish(true);
            } else {
              lifetime.stopObservation(true);
            }
          } else {
            lifetime.observed?.stepped?.();
          }
          return result;
        } catch (error) {
          if (!alreadyObserved && isPreResetRefusal(error)) {
            lifetime.pause();
          }
          // Row conversion can fail after a successful step. Preserve the native cursor;
          // ambiguous failures retain custody until return, reset, finalization, or close.
          propagate(error);
          throw error;
        } finally {
          failures.pop();
        }
      };
      if (nativeReturn) {
        rows.return = function (this: typeof rows, ...args) {
          if (
            this !== reference.deref() ||
            (done && native.iteratorBehavior.returnAfterDoneIsInert) ||
            !database.isOpen
          ) {
            return nativeReturn.apply(this, args);
          }
          const result = execute(
            () =>
              lifetime.finished || lifetime.invalidated
                ? nativeReturn.apply(this, args)
                : reset(() => nativeReturn.apply(this, args), "return"),
            bindingMutation,
            "bind",
          );
          done = result.done === true;
          lifetime.finish();
          return result;
        };
      }
      return rows;
    };
    for (const method of ["close", Symbol.dispose] as const) {
      const close = statement[method]?.bind(statement);
      if (close) {
        statement[method] = () => reset(close, "finalize");
      }
    }
    return statement;
  };
  observeSqliteNativeClose(database, () => {
    for (const lifetime of activeIterators) {
      lifetime.invalidate();
    }
  });
  return execute;
}
