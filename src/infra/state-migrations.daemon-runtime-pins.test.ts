import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeSqliteReadSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runCliProcessChild } from "../cli/cli-process-child.test-helpers.js";
import {
  type DaemonRuntimePinDatabase,
  resolveDaemonRuntimePinStorePath,
  withDaemonRuntimePinStore,
} from "../daemon/runtime-pin-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withDatabaseEngineSelection } from "./database-engine/context.js";
import { resolveDatabaseFamilyEngines } from "./database-engine/registry.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import {
  initializeFreshDaemonRuntimePinMigration,
  migrateDaemonRuntimePins,
} from "./state-migrations.daemon-runtime-pins.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type DaemonRuntimePinRow = DaemonRuntimePinDatabase["daemon_runtime_pins"];
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  env = { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("daemon-pin-migration-") };
});
afterEach(() => closeOpenClawStateDatabaseForTest());

const pin: DaemonRuntimePinRow = {
  state_key: `daemon-runtime-pin:${"a".repeat(64)}`,
  value_json: ' { "version": 1, "revision": "original", "runtime": "node" }\n',
  updated_at_ms: 1234,
};
function sourceRows(): DaemonRuntimePinRow[] {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      db
        .prepare("SELECT * FROM config_machine_state WHERE state_key LIKE 'daemon-runtime-pin:%'")
        .all() as DaemonRuntimePinRow[],
    { env },
  );
}
function targetRows(): DaemonRuntimePinRow[] | undefined {
  return withDaemonRuntimePinStore(
    env,
    false,
    (db) =>
      db
        .prepare("SELECT * FROM daemon_runtime_pins ORDER BY state_key")
        .all() as DaemonRuntimePinRow[],
  );
}
function receipt() {
  return withDaemonRuntimePinStore(env, false, (db) =>
    db
      .prepare(
        "SELECT source_state, phase, updated_at FROM daemon_runtime_pin_migration WHERE version = 1",
      )
      .get(),
  );
}
function seedSource(rows: DaemonRuntimePinRow[]): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const insert = db.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)");
      for (const row of rows) {
        insert.run(row.state_key, row.value_json, row.updated_at_ms);
      }
    },
    { env },
  );
}

describe("daemon runtime pin owner migration", () => {
  async function holdGatewayOwnership() {
    const owner = await acquireGatewayLock({ allowInTests: true, env, timeoutMs: 0 });
    if (!owner) {
      throw new Error("Expected Gateway state ownership");
    }
    return owner;
  }

  it("consumes the completed same-source receipt while the Gateway owns the profile", async () => {
    seedSource([pin]);
    await migrateDaemonRuntimePins(env);
    const completed = receipt();
    const owner = await holdGatewayOwnership();
    try {
      const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
      try {
        expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
        expect(observation.queries).toHaveLength(1);
      } finally {
        observation.restore();
      }
      expect(receipt()).toEqual(completed);
      owner.assertCurrent();
    } finally {
      await owner.release();
    }
    expect(sourceRows()).toEqual([]);
    expect(targetRows()).toEqual([pin]);
  });

  it("keeps pending migration blocked while the Gateway owns the profile", async () => {
    seedSource([pin]);
    const owner = await holdGatewayOwnership();
    try {
      const result = await migrateDaemonRuntimePins(env);
      expect(result.changes).toEqual([]);
      expect(result.warnings).toEqual([expect.stringContaining("Stop the Gateway")]);
      expect(result.warnings[0]).toContain("same state/config");
      expect(result.warnings[0]).toContain("openclaw doctor --fix");
      expect(receipt()).toBeUndefined();
      expect(targetRows()).toBeUndefined();
      owner.assertCurrent();
    } finally {
      await owner.release();
    }
    expect(sourceRows()).toEqual([pin]);
    expect((await migrateDaemonRuntimePins(env)).changes).toEqual([
      "Moved 1 daemon runtime pin(s) to local service intent.",
    ]);
  });

  it("does not write shared state after migration completes", async () => {
    seedSource([]);
    expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
    closeOpenClawStateDatabaseForTest();
    using writer = new DatabaseSync(resolveOpenClawStateSqlitePath(env));
    writer.exec("BEGIN IMMEDIATE");
    try {
      expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
      expect(writer.isTransaction).toBe(true);
    } finally {
      writer.exec("ROLLBACK");
    }
  });

  it("records complete custody for fresh installations without creating shared state", async () => {
    expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
    expect(fs.existsSync(resolveDaemonRuntimePinStorePath(env))).toBe(true);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
    expect(targetRows()).toEqual([]);
    expect(receipt()).toEqual({
      source_state: resolveOpenClawStateSqlitePath(env),
      phase: "complete",
      updated_at: expect.any(Number),
    });
  });

  it("resumes after a crash leaves the local store empty", async () => {
    const pathname = resolveDaemonRuntimePinStorePath(env);
    fs.mkdirSync(path.dirname(pathname), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pathname, "", { mode: 0o600 });

    expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
    expect(targetRows()).toEqual([]);
    expect(receipt()).toMatchObject({
      source_state: resolveOpenClawStateSqlitePath(env),
      phase: "complete",
    });
  });

  it("preserves the persisted unshipped receipt on a PostgreSQL restart", async () => {
    withDaemonRuntimePinStore(env, true, (db) =>
      db
        .prepare(
          "INSERT INTO daemon_runtime_pin_migration VALUES (1, 'none/unshipped', 'complete', 123)",
        )
        .run(),
    );
    const completed = receipt();
    const observation = observeSqliteReadSql(requireNodeSqlite().StatementSync.prototype);
    try {
      await withDatabaseEngineSelection(
        {
          effectiveEngines: resolveDatabaseFamilyEngines({ database: { engine: "postgres" } }),
          postgres: { connection: "postgres://unused", schemaPrefix: "pin_restart" },
        },
        async () => {
          expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
        },
      );
      expect(observation.queries).toHaveLength(1);
    } finally {
      observation.restore();
    }
    expect(receipt()).toEqual(completed);
    expect(fs.existsSync(resolveOpenClawStateSqlitePath(env))).toBe(false);
  });

  it("completes pre-pin released schemas without changing shared state", () => {
    const sourceState = resolveOpenClawStateSqlitePath(env);
    const original = gunzipSync(
      fs.readFileSync("test/fixtures/sqlite/openclaw-state-v2026.7.1-2.sqlite.gz"),
    );
    fs.mkdirSync(path.dirname(sourceState), { recursive: true });
    fs.writeFileSync(sourceState, original);

    initializeFreshDaemonRuntimePinMigration(env);

    expect(receipt()).toMatchObject({ source_state: sourceState, phase: "complete" });
    expect(fs.readFileSync(sourceState)).toEqual(original);
  });

  it("moves raw values and timestamps once, preserving malformed and stale intent", async () => {
    const rows = [
      pin,
      { ...pin, state_key: "daemon-runtime-pin:b", value_json: "{ malformed", updated_at_ms: 2 },
      { ...pin, state_key: "daemon-runtime-pin:c", value_json: '{"version":99}', updated_at_ms: 3 },
    ];
    seedSource([...rows, { ...pin, state_key: "unrelated.intent" }]);
    const result = await migrateDaemonRuntimePins(env);
    expect(result.warnings).toEqual([]);
    expect(result.changes).toEqual(["Moved 3 daemon runtime pin(s) to local service intent."]);
    expect(sourceRows()).toEqual([]);
    expect(targetRows()).toEqual(rows);
    expect(receipt()).toEqual({
      source_state: resolveOpenClawStateSqlitePath(env),
      phase: "complete",
      updated_at: expect.any(Number),
    });
    expect(
      runOpenClawStateWriteTransaction(
        ({ db }) =>
          db
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("unrelated.intent")?.value_json,
        { env },
      ),
    ).toBe(pin.value_json);
    expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
    expect(targetRows()).toEqual(rows);
  });

  it.each(["value_json", "updated_at_ms"] as const)(
    "retains both sources without partial copies when %s conflicts",
    async (field) => {
      const conflicting = {
        ...pin,
        ...(field === "value_json" ? { value_json: "different" } : { updated_at_ms: 9999 }),
      };
      const preceding = { ...pin, state_key: "daemon-runtime-pin:0" };
      seedSource([preceding, pin]);
      withDaemonRuntimePinStore(env, true, (db) => {
        db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(
          conflicting.state_key,
          conflicting.value_json,
          conflicting.updated_at_ms,
        );
        db.prepare("INSERT INTO daemon_runtime_pin_migration VALUES (1, ?, 'copied', 123)").run(
          resolveOpenClawStateSqlitePath(env),
        );
      });
      const originalReceipt = receipt();
      const result = await migrateDaemonRuntimePins(env);
      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toContain("migration conflict");
      expect(result.warnings.join("\n")).toContain("openclaw doctor --fix");
      expect(sourceRows()).toEqual([preceding, pin]);
      expect(targetRows()).toEqual([conflicting]);
      expect(receipt()).toEqual(originalReceipt);
    },
  );

  it("resumes after the target commits but source retirement fails", async () => {
    seedSource([pin]);
    runOpenClawStateWriteTransaction(
      ({ db }) =>
        db.exec(`CREATE TEMP TRIGGER interrupt_pin_retirement
        BEFORE DELETE ON config_machine_state
        WHEN OLD.state_key LIKE 'daemon-runtime-pin:%'
        BEGIN SELECT RAISE(ABORT, 'interrupted pin retirement'); END`),
      { env },
    );
    const interrupted = await migrateDaemonRuntimePins(env);
    expect(interrupted.changes).toEqual([]);
    expect(interrupted.warnings.join("\n")).toContain("interrupted pin retirement");
    expect(sourceRows()).toEqual([pin]);
    expect(targetRows()).toEqual([pin]);
    expect(receipt()).toEqual({
      source_state: resolveOpenClawStateSqlitePath(env),
      phase: "copied",
      updated_at: expect.any(Number),
    });
    // Reopening drops the interrupted connection's TEMP trigger, as a restart would.
    closeOpenClawStateDatabaseForTest();
    expect((await migrateDaemonRuntimePins(env)).warnings).toEqual([]);
    expect(sourceRows()).toEqual([]);
    expect(targetRows()).toEqual([pin]);
    expect(receipt()).toEqual({
      source_state: resolveOpenClawStateSqlitePath(env),
      phase: "complete",
      updated_at: expect.any(Number),
    });
  });

  it.skipIf(process.platform === "win32")(
    "resumes after SIGKILL between target commit and source retirement",
    async () => {
      seedSource([pin]);
      closeOpenClawStateDatabaseForTest();
      const script = `
        import { runOpenClawStateWriteTransaction } from ${JSON.stringify(new URL("../state/openclaw-state-db.ts", import.meta.url).href)};
        import { migrateDaemonRuntimePins } from ${JSON.stringify(new URL("./state-migrations.daemon-runtime-pins.ts", import.meta.url).href)};
        runOpenClawStateWriteTransaction(({ db }) => {
          db.function("interrupt_pin_retirement", () => process.kill(process.pid, "SIGKILL"));
          db.exec(\`CREATE TEMP TRIGGER interrupt_pin_retirement
            BEFORE DELETE ON config_machine_state
            WHEN OLD.state_key LIKE 'daemon-runtime-pin:%'
            BEGIN SELECT interrupt_pin_retirement(); END\`);
        });
        await migrateDaemonRuntimePins(process.env);
      `;
      const result = await runCliProcessChild({
        nodeArgs: ["--import", "./scripts/tsx.mjs", "--input-type=module", "--eval", script],
        env: {
          PATH: process.env.PATH,
          HOME: env.HOME,
          OPENCLAW_STATE_DIR: env.OPENCLAW_STATE_DIR,
          NODE_DISABLE_COMPILE_CACHE: "1",
        },
      });
      expect(result.signal, result.stderr).toBe("SIGKILL");
      expect(sourceRows()).toEqual([pin]);
      expect(targetRows()).toEqual([pin]);
      expect(receipt()).toMatchObject({ phase: "copied" });

      expect((await migrateDaemonRuntimePins(env)).warnings).toEqual([]);
      expect(sourceRows()).toEqual([]);
      expect(targetRows()).toEqual([pin]);
      expect(receipt()).toMatchObject({ phase: "complete" });
    },
  );

  it.each([false, true])(
    "retains an incomplete copy belonging to another source (source rows=%s)",
    async (hasRows) => {
      seedSource(hasRows ? [pin] : []);
      withDaemonRuntimePinStore(env, true, (db) => {
        db.prepare("INSERT INTO daemon_runtime_pins VALUES (?, ?, ?)").run(
          pin.state_key,
          pin.value_json,
          pin.updated_at_ms,
        );
        db.prepare("INSERT INTO daemon_runtime_pin_migration VALUES (1, ?, 'copied', 123)").run(
          path.join(path.dirname(resolveOpenClawStateSqlitePath(env)), "other-source.sqlite"),
        );
      });
      const originalReceipt = receipt();
      const result = await migrateDaemonRuntimePins(env);
      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toMatch(/source|receipt/i);
      expect(sourceRows()).toEqual(hasRows ? [pin] : []);
      expect(targetRows()).toEqual([pin]);
      expect(receipt()).toEqual(originalReceipt);
    },
  );
});
