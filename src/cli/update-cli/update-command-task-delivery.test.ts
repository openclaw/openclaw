import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { acquireFileLockSync } from "../../infra/file-lock-manager.js";
import { parseGatewayLockPayload } from "../../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../../infra/gateway-state-owner.js";
import { createUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { createUnsafeIndexDrift } from "../../state/sqlite-index-drift.test-support.js";
import { admitUpdateCommandRun, completeUpdateCommandRun } from "./update-command-run.js";

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: async () => null }),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
});

function seededOrphans() {
  const root = dirs.make("update-task-delivery-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(root, "openclaw.json"));
  for (const key of [
    "OPENCLAW_UPDATE_RUN_ID",
    "OPENCLAW_UPDATE_RUN_HANDOFF",
    "OPENCLAW_POST_CORE_UPDATE",
    "OPENCLAW_SUPERVISOR_MODE",
  ]) {
    vi.stubEnv(key, undefined);
  }
  const env = { ...process.env };
  const filename = resolveOpenClawStateSqlitePath(env);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION}; PRAGMA foreign_keys = OFF;`);
  db.prepare("INSERT INTO schema_meta VALUES ('primary','global',?,NULL,'2026.9.4',1,1)").run(
    OPENCLAW_STATE_SCHEMA_VERSION,
  );
  db.exec(`INSERT INTO task_runs
    (task_id,runtime,owner_key,scope_kind,task,status,delivery_status,notify_policy,created_at)
    VALUES ('kept-task','subagent','fixture','session','keep','completed','delivered','always',1);
    INSERT INTO task_delivery_state (task_id) VALUES ('kept-task');`);
  const rows = Array.from({ length: 18 }, (_, index) => ({
    task_id: `missing-task-${index}`,
    requester_origin_json: '{ "channel": "synthetic" }',
    last_notified_event_at: index,
  }));
  const insert = db.prepare("INSERT INTO task_delivery_state VALUES (?, ?, ?)");
  for (const row of rows) {
    insert.run(row.task_id, row.requester_origin_json, row.last_notified_event_at);
  }
  expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
  db.close();
  return {
    root,
    env,
    filename,
    rows,
    createRun: () => createUpdateRun({ trigger: "cli" }, { env }),
    exec: (sql: string) => inspect(filename, (connection) => connection.exec(sql)),
    all: (sql: string, source = filename) =>
      inspect(source, (connection) => connection.prepare(sql).all()),
    count: (table: string) => queryOne(filename, `SELECT count(*) AS count FROM ${table}`),
  };
}

function inspect<T>(filename: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(filename);
  try {
    return run(db);
  } finally {
    db.close();
  }
}
const queryOne = (filename: string, sql: string) =>
  inspect(filename, (db) => db.prepare(sql).get());

function recoveryDirectories(filename: string) {
  return fs
    .readdirSync(path.dirname(filename))
    .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
}

function expectUnadmitted(f: ReturnType<typeof seededOrphans>) {
  expect(f.all("PRAGMA foreign_key_check")).toHaveLength(18);
  expect(f.count("update_runs")).toEqual({ count: 0 });
}

it("keeps repairable task-delivery state unchanged during update preview", async () => {
  const f = seededOrphans();
  await expect(
    admitUpdateCommandRun({ opts: { dryRun: true }, root: f.root }).then(() => "admitted"),
  ).rejects.toThrow(/repairable[\s\S]*openclaw doctor --fix/iu);
  expectUnadmitted(f);
  expect(recoveryDirectories(f.filename)).toEqual([]);
});

it("admits cascade-owned task-delivery orphans with preservation and a durable recovery record", async () => {
  const f = seededOrphans();
  const run = await admitUpdateCommandRun({ opts: {}, root: f.root });
  const directories = recoveryDirectories(f.filename);
  expect(directories).toHaveLength(1);
  const directory = path.join(path.dirname(f.filename), directories[0]!);
  const exported: unknown[] = fs
    .readFileSync(path.join(directory, "orphan-rows.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(exported).toEqual(
    f.rows.map((row) =>
      expect.objectContaining({
        ...row,
        last_notified_event_at: String(row.last_notified_event_at),
      }),
    ),
  );
  expect(f.all("PRAGMA foreign_key_check", path.join(directory, "database.sqlite"))).toHaveLength(
    18,
  );
  expect(f.all("SELECT task_id FROM task_delivery_state")).toEqual([{ task_id: "kept-task" }]);
  expect(f.all("PRAGMA foreign_key_check")).toEqual([]);
  expect(queryOne(f.filename, "PRAGMA integrity_check")).toEqual({ integrity_check: "ok" });
  expect(f.count("update_runs")).toEqual({ count: 1 });
  completeUpdateCommandRun({ status: "ok", mode: "npm", durationMs: 1, steps: [] }, run);
  const record = getUpdateRun(run.runId, { env: f.env });
  expect(record?.status).toBe("succeeded");
  const recovery = record?.steps.find((step) => step.step === "task-delivery-recovery");
  expect(recovery).toMatchObject({
    status: "completed",
    detail: expect.stringContaining("18 orphan task delivery rows"),
  });
  expect(recovery?.detail).toContain(directories[0]);
});

it.each([
  ["non-cascade", /foreign_key_check failed/, 0],
  ["structural", /integrity_check failed/, 0],
  ["dependent", /foreign_key_check failed/, undefined],
  ["ledger trigger", /unknown_ledger_trigger/, 1],
] as const)(
  "refuses %s damage without changing ledger or task rows",
  (damage, error, recoveryCount) => {
    const f = seededOrphans();
    if (damage === "non-cascade") {
      f.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE unrelated_parent (id TEXT PRIMARY KEY);
      CREATE TABLE unrelated_child (id TEXT REFERENCES unrelated_parent(id));
      INSERT INTO unrelated_child VALUES ('missing');`);
    } else if (damage === "structural") {
      createUnsafeIndexDrift(f.filename);
    } else if (damage === "dependent") {
      f.exec(`CREATE TABLE dependent (
    task_id TEXT REFERENCES task_delivery_state(task_id) ON DELETE CASCADE);
    INSERT INTO dependent VALUES ('missing-task-0');`);
    } else {
      f.exec(`CREATE TRIGGER unknown_ledger_trigger
    BEFORE INSERT ON update_runs BEGIN SELECT RAISE(ABORT, 'reject ledger insert'); END;`);
    }
    expect(f.createRun).toThrow(error);
    if (damage === "non-cascade" || damage === "structural") {
      expect(f.count("task_delivery_state")).toEqual({ count: 19 });
    }
    expect(f.count("update_runs")).toEqual({ count: 0 });
    if (recoveryCount !== undefined) {
      expect(recoveryDirectories(f.filename)).toHaveLength(recoveryCount);
    }
    if (damage === "dependent") {
      expect(f.all("SELECT * FROM dependent")).toEqual([{ task_id: "missing-task-0" }]);
    }
    if (damage === "dependent" || damage === "ledger trigger") {
      expect(f.all("PRAGMA foreign_key_check")).toHaveLength(18);
    }
  },
);

it("reports repairable orphans and Doctor next action for foreign-gateway admission", () => {
  const f = seededOrphans();
  const anchor = acquireGatewayStateOwner({ databasePath: f.filename });
  anchor.release();
  // Register no local root: recovery must not borrow the foreign Gateway's schema authority.
  const owner = acquireFileLockSync(anchor.path, {
    lockPath: anchor.path,
    retry: { retries: 0 },
    payload: () => ({
      pid: process.pid,
      ownerId: randomUUID(),
      createdAt: new Date().toISOString(),
      configPath: path.join(f.root, "openclaw.json"),
      role: "gateway",
    }),
    parsePayload: parseGatewayLockPayload,
  });
  try {
    expect(f.createRun).toThrow(/repairable[\s\S]*openclaw doctor --fix/iu);
    expectUnadmitted(f);
  } finally {
    owner?.release();
  }
});
