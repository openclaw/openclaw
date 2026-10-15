import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  type DaemonRuntimePinDatabase,
  resolveDaemonRuntimePinStorePath,
  withDaemonRuntimePinStore,
} from "../daemon/runtime-pin-store.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { migrateDaemonRuntimePins } from "./state-migrations.daemon-runtime-pins.js";

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
  it("keeps fresh installations free of migration artifacts", async () => {
    expect(await migrateDaemonRuntimePins(env)).toEqual({ changes: [], warnings: [] });
    expect(fs.existsSync(resolveDaemonRuntimePinStorePath(env))).toBe(false);
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
      });
      const result = await migrateDaemonRuntimePins(env);
      expect(result.changes).toEqual([]);
      expect(result.warnings.join("\n")).toContain("migration conflict");
      expect(result.warnings.join("\n")).toContain("openclaw doctor --fix");
      expect(sourceRows()).toEqual([preceding, pin]);
      expect(targetRows()).toEqual([conflicting]);
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
    runOpenClawStateWriteTransaction(({ db }) => db.exec("DROP TRIGGER interrupt_pin_retirement"), {
      env,
    });
    expect((await migrateDaemonRuntimePins(env)).warnings).toEqual([]);
    expect(sourceRows()).toEqual([]);
    expect(targetRows()).toEqual([pin]);
  });
});
