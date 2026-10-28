import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { needsOpenClawStateDatabaseSchemaRepair } from "./openclaw-state-db-fast-path.js";
import {
  ensureGitHubPublicationSchema,
  ensureSecretStoreSchema,
} from "./openclaw-state-db-schema-additive.js";
import * as state from "./openclaw-state-db.js";
import {
  restorePreTemplateStateIdentifiersForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

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

it("detects and completes startup columns in present lazy tables", async () => {
  const env = { OPENCLAW_STATE_DIR: dirs.make("state-lazy-startup-") };
  const opened = state.openOpenClawStateDatabase({ env });
  ensureSecretStoreSchema(opened.db);
  const pathname = opened.path;
  await state.closeOpenClawStateDatabaseAsync();
  {
    using database = new DatabaseSync(pathname);
    database.exec("ALTER TABLE secret_store_entries DROP COLUMN allowed_hosts");
  }
  expect(needsOpenClawStateDatabaseSchemaRepair(pathname)).toBe(true);
  const repaired = state.openOpenClawStateDatabase({ env });
  expect(repaired.db.prepare("SELECT allowed_hosts FROM secret_store_entries").all()).toEqual([]);
  expect(
    repaired.db
      .prepare("SELECT name FROM sqlite_schema WHERE name = 'user_profile_identities'")
      .get(),
  ).toBeUndefined();
  expect(needsOpenClawStateDatabaseSchemaRepair(pathname)).toBe(false);
});

it.each([
  { table: "secret_store_entries", column: "allowed_hosts" },
  { table: "github_publication_requests", column: "draft" },
])(
  "finishes $table column $column repair alongside a bounded version upgrade",
  async ({ table, column }) => {
    const env = { OPENCLAW_STATE_DIR: dirs.make("state-bounded-lazy-repair-") };
    const opened = state.openOpenClawStateDatabase({ env });
    ensureSecretStoreSchema(opened.db);
    ensureGitHubPublicationSchema(opened.db);
    const pathname = opened.path;
    await state.closeOpenClawStateDatabaseAsync();
    {
      using database = new DatabaseSync(pathname);
      restorePreTemplateStateIdentifiersForTest(database);
      database.exec(
        "PRAGMA user_version = 35; UPDATE schema_meta SET schema_version = 35 WHERE meta_key = 'primary'",
      );
      database.exec("ALTER TABLE " + table + " DROP COLUMN " + column);
    }
    await withStateMigrationBackupForTest({ env }, () => {
      expect(state.repairOpenClawStateDatabaseSchema({ env }).warnings).toEqual([]);
    });
    const repaired = state.openOpenClawStateDatabase({ env });
    expect(repaired.db.prepare("SELECT " + column + " FROM " + table).all()).toEqual([]);
    expect(repaired.db.prepare("PRAGMA user_version").get()?.user_version).toBe(
      OPENCLAW_STATE_SCHEMA_VERSION,
    );
    expect(
      repaired.db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name = 'github_personal_publication_requests'",
        )
        .get(),
    ).toBeUndefined();
  },
);
