import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { tryAcquireExclusiveSqliteCoordinator } from "../../infra/sqlite-coordinator.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
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
  vi.stubEnv("OPENCLAW_UPDATE_RUN_ID", undefined);
  vi.stubEnv("OPENCLAW_UPDATE_RUN_HANDOFF", undefined);
  vi.stubEnv("OPENCLAW_POST_CORE_UPDATE", undefined);
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", undefined);
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
  return { root, env, filename, rows };
}

function inspect<T>(filename: string, run: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(filename);
  try {
    return run(db);
  } finally {
    db.close();
  }
}

it("keeps repairable task-delivery state unchanged during update preview", async () => {
  const f = seededOrphans();
  await expect(
    admitUpdateCommandRun({ opts: { dryRun: true }, root: f.root }).then(() => "admitted"),
  ).rejects.toThrow(/repairable[\s\S]*openclaw doctor --fix/iu);
  inspect(f.filename, (db) => {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
    expect(db.prepare("SELECT count(*) AS count FROM update_runs").get()).toEqual({ count: 0 });
  });
  expect(
    fs
      .readdirSync(path.dirname(f.filename))
      .filter((name) => name.startsWith("openclaw-task-delivery-recovery-")),
  ).toEqual([]);
});

it("admits cascade-owned task-delivery orphans with preservation and a durable recovery record", async () => {
  const f = seededOrphans();
  const run = await admitUpdateCommandRun({ opts: {}, root: f.root });
  const directories = fs
    .readdirSync(path.dirname(f.filename))
    .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
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
  inspect(path.join(directory, "database.sqlite"), (db) => {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
  });
  inspect(f.filename, (db) => {
    expect(db.prepare("SELECT task_id FROM task_delivery_state").all()).toEqual([
      { task_id: "kept-task" },
    ]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.prepare("SELECT count(*) AS count FROM update_runs").get()).toEqual({ count: 1 });
  });
  completeUpdateCommandRun({ status: "ok", mode: "npm", durationMs: 1, steps: [] }, run);
  const record = getUpdateRun(run.runId, { env: f.env });
  expect(record?.status).toBe("succeeded");
  expect(record?.steps).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        step: "task-delivery-recovery",
        status: "completed",
        detail: expect.stringContaining(`18 orphan task delivery rows`),
      }),
    ]),
  );
  expect(record?.steps.find((step) => step.step === "task-delivery-recovery")?.detail).toContain(
    directories[0],
  );
});

it.each([
  { name: "step count", count: 130, prefix: "progress:", detail: undefined },
  { name: "diagnostic bytes", count: 30, prefix: "progress:", detail: "界".repeat(1_024) },
  { name: "retained step bytes", count: 30, prefix: "finalize:", detail: "界".repeat(1_024) },
])(
  "retains the recovery receipt across the $name limit and database reopen",
  ({ count, prefix, detail }) => {
    const f = seededOrphans();
    const options = { env: f.env };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const directories = fs
      .readdirSync(path.dirname(f.filename))
      .filter((name) => name.startsWith("openclaw-task-delivery-recovery-"));
    expect(directories).toHaveLength(1);
    for (let index = 0; index < count; index++) {
      recordUpdateRunStep(
        run.runId,
        { step: `${prefix}${index}`, status: "completed", detail },
        options,
      );
    }
    closeOpenClawStateDatabaseForTest();
    const persisted = getUpdateRun(run.runId, options)!;
    const receipt = persisted.steps.find((step) => step.step === "task-delivery-recovery");
    expect(receipt).toMatchObject({
      status: "completed",
      detail: expect.stringContaining("18 orphan task delivery rows"),
    });
    expect(receipt?.detail).toContain(directories[0]);
    expect(persisted.steps.length).toBeLessThanOrEqual(128);
    expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
  },
);

it.each(["non-cascade", "structural"] as const)(
  "refuses %s damage without admission or recovery",
  (damage) => {
    const f = seededOrphans();
    if (damage === "non-cascade") {
      inspect(f.filename, (db) =>
        db.exec(`PRAGMA foreign_keys = OFF;
      CREATE TABLE unrelated_parent (id TEXT PRIMARY KEY);
      CREATE TABLE unrelated_child (id TEXT REFERENCES unrelated_parent(id));
      INSERT INTO unrelated_child VALUES ('missing');`),
      );
    } else {
      createUnsafeIndexDrift(f.filename);
    }
    expect(() => createUpdateRun({ trigger: "cli" }, { env: f.env })).toThrow(
      damage === "non-cascade" ? /foreign_key_check failed/ : /integrity_check failed/,
    );
    inspect(f.filename, (db) => {
      expect(db.prepare("SELECT count(*) AS count FROM task_delivery_state").get()).toEqual({
        count: 19,
      });
      expect(db.prepare("SELECT count(*) AS count FROM update_runs").get()).toEqual({ count: 0 });
    });
    expect(
      fs
        .readdirSync(path.dirname(f.filename))
        .filter((name) => name.startsWith("openclaw-task-delivery-recovery-")),
    ).toEqual([]);
  },
);

it.each(["read-only", "foreign-gateway"] as const)(
  "reports repairable orphans and Doctor next action for %s admission",
  (blocker) => {
    const f = seededOrphans();
    const anchor = acquireGatewayLifecycleCoordinator({ databasePath: f.filename });
    anchor.release();
    const owner =
      blocker === "foreign-gateway" ? tryAcquireExclusiveSqliteCoordinator(anchor.path) : undefined;
    if (blocker === "foreign-gateway" && !owner) {
      throw new Error("Fixture Gateway lease unavailable");
    }
    try {
      expect(() =>
        createUpdateRun({ trigger: "cli" }, { env: f.env, readOnly: blocker === "read-only" }),
      ).toThrow(/repairable[\s\S]*openclaw doctor --fix/iu);
      inspect(f.filename, (db) => {
        expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
        expect(db.prepare("SELECT count(*) AS count FROM update_runs").get()).toEqual({ count: 0 });
      });
    } finally {
      owner?.release();
    }
  },
);

it.each(["CASCADE", "SET NULL"])(
  "preserves inbound %s dependents when recovery is refused",
  (action) => {
    const f = seededOrphans();
    inspect(f.filename, (db) =>
      db.exec(`CREATE TABLE dependent (
    task_id TEXT REFERENCES task_delivery_state(task_id) ON DELETE ${action});
    INSERT INTO dependent VALUES ('missing-task-0');`),
    );
    expect(() => createUpdateRun({ trigger: "cli" }, { env: f.env })).toThrow(
      /foreign_key_check failed/,
    );
    inspect(f.filename, (db) => {
      expect(db.prepare("SELECT * FROM dependent").all()).toEqual([{ task_id: "missing-task-0" }]);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
      expect(db.prepare("SELECT count(*) AS count FROM update_runs").get()).toEqual({ count: 0 });
    });
  },
);

it("rolls back recovered rows when ledger schema refuses admission", () => {
  const f = seededOrphans();
  inspect(f.filename, (db) =>
    db.exec(`CREATE TRIGGER unknown_ledger_trigger
    BEFORE INSERT ON update_runs BEGIN SELECT RAISE(ABORT, 'reject ledger insert'); END;`),
  );
  expect(() => createUpdateRun({ trigger: "cli" }, { env: f.env })).toThrow(
    /unknown_ledger_trigger/,
  );
  inspect(f.filename, (db) => {
    expect(db.prepare("PRAGMA foreign_key_check").all()).toHaveLength(18);
    expect(db.prepare("SELECT count(*) AS count FROM update_runs").get()).toEqual({ count: 0 });
  });
  expect(
    fs
      .readdirSync(path.dirname(f.filename))
      .filter((name) => name.startsWith("openclaw-task-delivery-recovery-")),
  ).toHaveLength(1);
});
