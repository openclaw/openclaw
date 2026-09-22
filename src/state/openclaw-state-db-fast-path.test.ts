import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
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
    },
    {
      name: "preserves the original error after native close",
      rollbackFails: true,
      undefinedError: false,
    },
    {
      name: "preserves undefined rejection after native close",
      rollbackFails: true,
      undefinedError: true,
    },
  ])("$name", ({ rollbackFails, undefinedError }) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-fast-path-settlement-") };
    const pathname = realpathSync(openOpenClawStateDatabase({ env }).path);
    closeOpenClawStateDatabaseForTest();
    const original = undefinedError ? undefined : new Error("synthetic fast-path COMMIT failure");
    const rollbackError = new Error("synthetic fast-path ROLLBACK failure");
    // oxlint-disable-next-line typescript/unbound-method -- Fault injection forwards the native method with its exact database receiver.
    const exec = DatabaseSync.prototype.exec;
    // oxlint-disable-next-line typescript/unbound-method -- Native close is called with its exact database receiver below.
    const close = DatabaseSync.prototype.close;
    const events: Array<{ phase: "commit" | "rollback" | "close" | "fallback"; isOpen: boolean }> =
      [];
    const selected = new Set<DatabaseSync>();
    let injected = false;
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
      }
      Reflect.apply(exec, this, [sql]);
    });
    vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
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
    if (rollbackFails) {
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
      expect(events).toEqual([
        { phase: "commit", isOpen: true },
        { phase: "rollback", isOpen: true },
        { phase: "fallback", isOpen: true },
      ]);
    }
  });
});
