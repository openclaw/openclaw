import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as state from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    state.closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

function intercept(
  begin: "BEGIN" | "BEGIN IMMEDIATE",
  onExec: (database: DatabaseSync, sql: string) => void,
  onClose?: (database: DatabaseSync) => void,
) {
  const env = { OPENCLAW_STATE_DIR: dirs.make("state-settlement-") };
  const pathname = realpathSync(state.openOpenClawStateDatabase({ env }).path);
  state.closeOpenClawStateDatabaseForTest();
  const selected = new Set<DatabaseSync>();
  let foreignKeys: unknown;
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the native receiver.
  const exec = DatabaseSync.prototype.exec;
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded with the native receiver.
  const close = DatabaseSync.prototype.close;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    if ((begin !== "BEGIN" || !selected.size) && sql === begin && this.location() === pathname) {
      selected.add(this);
    }
    if (selected.has(this)) {
      onExec(this, sql);
    }
    exec.call(this, sql);
  });
  vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
    if (selected.has(this)) {
      foreignKeys = this.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
    }
    close.call(this);
    if (selected.has(this)) {
      onClose?.(this);
    }
  });
  return { env, selected, foreignKeys: () => foreignKeys };
}

it.each([
  [false, false, false],
  [true, false, false],
  [true, true, false],
  [false, false, true],
])(
  "settles COMMIT failure (rollback=%s, undefined error=%s, convergence=%s)",
  (rollbackFails, undefinedError, convergenceFails) => {
    const original = undefinedError ? undefined : new Error("synthetic fast-path COMMIT failure");
    const rollbackError = new Error("synthetic fast-path ROLLBACK failure");
    const convergenceError = new Error("synthetic schema BEGIN failure");
    const events: Array<["commit" | "rollback" | "close" | "fallback", boolean]> = [];
    let injected = false;
    const { env, selected, foreignKeys } = intercept(
      "BEGIN",
      (database, sql) => {
        if (!injected && sql === "COMMIT") {
          injected = true;
          events.push(["commit", database.isOpen]);
          // oxlint-disable-next-line typescript/only-throw-error -- The public opener must preserve an undefined rejection too.
          throw original;
        }
        if (injected && sql === "ROLLBACK") {
          events.push(["rollback", database.isOpen]);
          if (rollbackFails) {
            throw rollbackError;
          }
        }
        if (sql === "PRAGMA foreign_keys = OFF;") {
          events.push(["fallback", database.isOpen]);
        }
        if (convergenceFails && sql === "BEGIN IMMEDIATE") {
          throw convergenceError;
        }
      },
      (database) => events.push(["close", database.isOpen]),
    );
    let result:
      | { status: "fulfilled"; database: ReturnType<typeof state.openOpenClawStateDatabase> }
      | { status: "rejected"; error: unknown };
    try {
      result = { status: "fulfilled", database: state.openOpenClawStateDatabase({ env }) };
    } catch (error) {
      result = { status: "rejected", error };
    }
    expect(injected).toBe(true);
    if (convergenceFails) {
      expect(result).toEqual({ status: "rejected", error: convergenceError });
      expect(foreignKeys()).toBe(1);
    } else if (rollbackFails) {
      assert(result.status === "rejected", "Failed native rollback must refuse opening");
      expect(result.error).toBe(original);
      expect([...selected].map((database) => database.isOpen)).toEqual([false]);
    } else {
      assert(result.status === "fulfilled", "Successful rollback must retain schema repair");
      expect(result.database.db.isOpen).toBe(true);
      expect(result.database.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    }
    expect(events).toEqual([
      ["commit", true],
      ["rollback", true],
      ...(!rollbackFails ? [["fallback", true]] : []),
      ...(rollbackFails || convergenceFails ? [["close", false]] : []),
    ]);
  },
);

it.each([false, true])("settles Doctor's disabled foreign-key connection (failure=%s)", (fails) => {
  const { env, selected, foreignKeys } = intercept("BEGIN IMMEDIATE", (database, sql) => {
    if (sql === "BEGIN IMMEDIATE") {
      expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
      if (fails) {
        throw new Error("synthetic Doctor BEGIN failure");
      }
    }
  });

  const repaired = state.repairOpenClawStateDatabaseSchema({ env });
  expect(repaired.warnings).toEqual(
    fails ? [expect.stringContaining("synthetic Doctor BEGIN failure")] : [],
  );
  expect([...selected].map((database) => database.isOpen)).toEqual([false]);
  expect(foreignKeys()).toBe(0);
});
