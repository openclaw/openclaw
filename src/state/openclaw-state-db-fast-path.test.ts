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
    {
      name: "retains repair after successful rollback",
      rollbackFails: false,
      undefinedError: false,
      convergenceFails: false,
    },
    {
      name: "preserves the original error after native close",
      rollbackFails: true,
      undefinedError: false,
      convergenceFails: false,
    },
    {
      name: "preserves undefined rejection after native close",
      rollbackFails: true,
      undefinedError: true,
      convergenceFails: false,
    },
    {
      name: "restores foreign-key enforcement after failed schema convergence",
      rollbackFails: false,
      undefinedError: false,
      convergenceFails: true,
    },
  ])("$name", ({ rollbackFails, undefinedError, convergenceFails }) => {
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
    const events: Array<{ phase: "commit" | "rollback" | "close" | "fallback"; isOpen: boolean }> =
      [];
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
          events.push({ phase: "commit", isOpen: this.isOpen });
          // oxlint-disable-next-line typescript/only-throw-error -- The public opener must preserve an undefined rejection too.
          throw original;
        }
        if (injected && sql === "ROLLBACK") {
          events.push({ phase: "rollback", isOpen: this.isOpen });
          if (rollbackFails) {
            throw rollbackError;
          }
        }
        if (sql === "PRAGMA foreign_keys = OFF;") {
          events.push({ phase: "fallback", isOpen: this.isOpen });
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
        events.push({ phase: "close", isOpen: this.isOpen });
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
      expect(events).toEqual([
        { phase: "commit", isOpen: true },
        { phase: "rollback", isOpen: true },
        { phase: "fallback", isOpen: true },
        { phase: "close", isOpen: false },
      ]);
    } else if (rollbackFails) {
      expect(result.status).toBe("rejected");
      if (result.status !== "rejected") {
        throw new Error("Expected the failed native rollback to refuse opening");
      }
      expect(result.error).toBe(original);
      expect([...selected].map((database) => database.isOpen)).toEqual([false]);
      expect(events).toEqual([
        { phase: "commit", isOpen: true },
        { phase: "rollback", isOpen: true },
        { phase: "close", isOpen: false },
      ]);
    } else {
      expect(result.status).toBe("fulfilled");
      if (result.status !== "fulfilled") {
        throw new Error("Expected successful rollback to retain the schema repair fallback");
      }
      expect(result.database.db.isOpen).toBe(true);
      expect(result.database.db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(events).toEqual([
        { phase: "commit", isOpen: true },
        { phase: "rollback", isOpen: true },
        { phase: "fallback", isOpen: true },
      ]);
    }
  });

  it.each([false, true])(
    "settles Doctor's disabled foreign-key connection (failure=%s)",
    (fails) => {
      const env = { OPENCLAW_STATE_DIR: dirs.make("state-doctor-foreign-keys-") };
      const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
      closeOpenClawStateDatabaseForTest();
      const originalExec = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec")
        ?.value as ((this: DatabaseSync, sql: string) => void) | undefined;
      const originalClose = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "close")
        ?.value as ((this: DatabaseSync) => void) | undefined;
      if (!originalExec || !originalClose) {
        throw new Error("Native SQLite descriptors are unavailable");
      }
      const selected = new Set<DatabaseSync>();
      let foreignKeysAtClose: unknown;
      vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(
        function (this: DatabaseSync, sql) {
          if (sql === "BEGIN IMMEDIATE" && this.location() === pathname) {
            selected.add(this);
            expect(this.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
            if (fails) {
              throw new Error("synthetic Doctor BEGIN failure");
            }
          }
          originalExec.call(this, sql);
        },
      );
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
