import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchema,
} from "./openclaw-state-db.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);

describe("state schema fast-path failure settlement", () => {
  it.each([
    { name: "retains repair after successful rollback" },
    { name: "preserves the original error after native close", rollbackFails: true },
    {
      name: "preserves undefined rejection after native close",
      rollbackFails: true,
      undefinedError: true,
    },
    {
      name: "restores foreign-key enforcement after failed schema convergence",
      convergenceFails: true,
    },
  ])("$name", ({ rollbackFails = false, undefinedError = false, convergenceFails = false }) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-fast-path-settlement-") };
    const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
    closeOpenClawStateDatabaseForTest();
    const original = undefinedError ? undefined : new Error("synthetic fast-path COMMIT failure");
    const rollbackError = new Error("synthetic fast-path ROLLBACK failure");
    const convergenceError = new Error("synthetic schema BEGIN failure");
    // oxlint-disable-next-line typescript/unbound-method -- Fault injection forwards the native method with its exact database receiver.
    const exec = DatabaseSync.prototype.exec;
    // oxlint-disable-next-line typescript/unbound-method -- Native close is called with its exact database receiver below.
    const close = DatabaseSync.prototype.close;
    const events: Array<["commit" | "rollback" | "close" | "fallback", boolean]> = [];
    const selected = new Set<DatabaseSync>();
    let injected = false;
    let foreignKeysAtClose: unknown;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
      if (!selected.size && sql === "BEGIN" && this.location() === pathname) {
        selected.add(this);
      }
      if (selected.has(this)) {
        if (!injected && sql === "COMMIT") {
          injected = true;
          events.push(["commit", this.isOpen]);
          // oxlint-disable-next-line typescript/only-throw-error -- The public opener must preserve an undefined rejection too.
          throw original;
        }
        if (injected && sql === "ROLLBACK") {
          events.push(["rollback", this.isOpen]);
          if (rollbackFails) {
            throw rollbackError;
          }
        }
        if (sql === "PRAGMA foreign_keys = OFF;") {
          events.push(["fallback", this.isOpen]);
        }
        if (convergenceFails && sql === "BEGIN IMMEDIATE") {
          throw convergenceError;
        }
      }
      Reflect.apply(exec, this, [sql]);
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
      if (selected.has(this)) {
        foreignKeysAtClose = this.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
      }
      Reflect.apply(close, this, []);
      if (selected.has(this)) {
        events.push(["close", this.isOpen]);
      }
    });
    let result:
      | { status: "fulfilled"; database: ReturnType<typeof openOpenClawStateDatabase> }
      | { status: "rejected"; error: unknown };
    try {
      result = { status: "fulfilled", database: openOpenClawStateDatabase({ env }) };
    } catch (error) {
      result = { status: "rejected", error };
    }
    expect(injected).toBe(true);
    if (convergenceFails) {
      expect(result).toEqual({ status: "rejected", error: convergenceError });
      expect(foreignKeysAtClose).toBe(1);
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
  });

  it.each([false, true])(
    "settles Doctor's disabled foreign-key connection (failure=%s)",
    (fails) => {
      const env = { OPENCLAW_STATE_DIR: dirs.make("state-doctor-foreign-keys-") };
      const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
      closeOpenClawStateDatabaseForTest();
      // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its exact database receiver.
      const originalExec = DatabaseSync.prototype.exec;
      // oxlint-disable-next-line typescript/unbound-method -- Forwarded with its exact database receiver.
      const originalClose = DatabaseSync.prototype.close;
      const selected = new Set<DatabaseSync>();
      let foreignKeysAtClose: unknown;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
        this: DatabaseSync,
        sql,
      ) {
        if (sql === "BEGIN IMMEDIATE" && this.location() === pathname) {
          selected.add(this);
          expect(this.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
          if (fails) {
            throw new Error("synthetic Doctor BEGIN failure");
          }
        }
        originalExec.call(this, sql);
      });
      vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
        if (selected.has(this)) {
          foreignKeysAtClose = this.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
        }
        originalClose.call(this);
      });

      const repaired = repairOpenClawStateDatabaseSchema({ env });
      expect(repaired.warnings).toEqual(
        fails ? [expect.stringContaining("synthetic Doctor BEGIN failure")] : [],
      );
      expect([...selected].map((database) => database.isOpen)).toEqual([false]);
      expect(foreignKeysAtClose).toBe(0);
    },
  );
});
