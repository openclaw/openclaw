import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SqliteReadOnlyInspectionContentionError } from "../infra/sqlite-readonly-worker-protocol.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  compatible,
  databaseFixture,
  supportedVersions,
  versionRow,
  failureRow,
  closeDatabases,
  openRawDatabase,
  rejectSnapshot,
} from "./database-preflight-fixtures.test-support.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "./openclaw-state-db.js";
import {
  addPreCutoverClientCredentialTablesForTest,
  withStateMigrationBackupForTest,
} from "./openclaw-state-schema.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabases();
});

it.each([
  {
    name: "retryable snapshot contention",
    error: new SqliteReadOnlyInspectionContentionError("snapshot did not stabilize"),
    guidance: "Wait a moment for write activity to settle, then retry the inspection.",
    restore: false,
  },
  {
    name: "database corruption",
    error: new Error("database disk image is malformed"),
    guidance: "Stop OpenClaw processes, then restore the affected database from a verified backup.",
    restore: true,
  },
])(
  "keeps Doctor's refusal and gives the next step for $name",
  async ({ error, guidance, restore }) => {
    const fixture = databaseFixture(tempDirs.make("doctor-readiness-guidance-"));
    fixture.state();
    closeDatabases();
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockRejectedValueOnce(error);

    const failure = await fixture.doctor().catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: expect.stringContaining("Doctor could not complete repair"),
    });
    expect(failure).toMatchObject({ message: expect.stringContaining(error.message) });
    expect(failure).toMatchObject({ message: expect.stringContaining(guidance) });
    if (!restore) {
      expect(failure).toMatchObject({ message: expect.not.stringContaining("restore") });
    }
  },
);

it("keeps retry and restore guidance with their affected agent databases", async () => {
  const fixture = databaseFixture(tempDirs.make("doctor-mixed-readiness-"));
  const busy = fixture.agent("busy");
  const corrupt = fixture.agent("corrupt");
  closeDatabases();
  const prepare = snapshots.prepareSqliteReadOnlyLocation;
  vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation((source, options) => {
    if (source === busy.path) {
      throw new SqliteReadOnlyInspectionContentionError("snapshot did not stabilize");
    }
    if (source === corrupt.path) {
      throw new Error("database disk image is malformed");
    }
    return prepare(source, options);
  });

  await expect(
    withArtifactPreservingStateReads(() => fixture.doctor(), { agentDatabases: true }),
  ).rejects.toThrow(
    `Doctor could not complete repair because persisted database readiness could not be verified:\nagent ${busy.path}: snapshot did not stabilize Wait a moment for write activity to settle, then retry the inspection.\nagent ${corrupt.path}: database disk image is malformed Stop OpenClaw processes, then restore the affected database from a verified backup.`,
  );
});

it("upgrades captured subagent authority state without rewriting rows and refuses schema-24 targets", async () => {
  const fixture = databaseFixture(tempDirs.make("subagent-authority-format-"));
  const pathname = fixture.state().path;
  await closeOpenClawStateDatabaseAsync();
  const payload = JSON.stringify({
    runId: "interrupted-child",
    operatorRecoverySource: {
      version: 1,
      snapshot: { profileId: "original-operator", scopes: ["operator.write"] },
    },
  });
  const catalogSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
  let catalog;
  {
    using writer = openRawDatabase(pathname);
    catalog = writer.prepare(catalogSql).all();
    addPreCutoverClientCredentialTablesForTest(writer);
    writer.exec(`PRAGMA user_version = 24;
      UPDATE schema_meta SET schema_version = 24 WHERE meta_key = 'primary';
      UPDATE config_machine_state SET value_json = '24'
        WHERE state_key = 'state.schema.contentVersion';`);
    writer
      .prepare(`INSERT INTO subagent_runs
      (run_id, child_session_key, requester_session_key, created_at, payload_json)
      VALUES ('interrupted-child', 'agent:main:subagent:child', 'agent:main:main', 1, ?)`)
      .run(payload);
  }
  // A prior process's file must acquire fresh physical admission, not cached version facts.
  fs.renameSync(pathname, `${pathname}.v24`);
  fs.copyFileSync(`${pathname}.v24`, pathname);
  await withStateMigrationBackupForTest({ env: fixture.env }, () => fixture.state());
  const { db } = fixture.state();
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: supportedVersions.state,
  });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: supportedVersions.state });
  expect(
    db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = 'interrupted-child'").get(),
  ).toEqual({ payload_json: payload });
  expect(db.prepare(catalogSql).all()).toEqual(catalog);
  await closeOpenClawStateDatabaseAsync();
  expect(
    await fixture.inspect({
      scope: "state",
      supportedVersions: { state: 24, agent: supportedVersions.agent },
    }),
  ).toMatchObject({
    incompatible: [versionRow("state", pathname, supportedVersions.state, 24)],
    indeterminate: [],
  });
});

it("keeps readiness on the admitted shared-state snapshot and observes changes in the next admission", async () => {
  const fixture = databaseFixture(tempDirs.make("schema-admitted-snapshot-"));
  const state = fixture.state();
  const inspect = () => fixture.inspect({ scope: "state", requireStartupMigrationReadiness: true });
  try {
    await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(
        async () => {
          state.db.exec(`PRAGMA user_version = ${supportedVersions.state + 1};`);
          expect(await inspect()).toEqual(compatible);
        },
        { env: fixture.env },
      ),
    );
    expect(await inspect()).toMatchObject({
      incompatible: [versionRow("state", state.path, supportedVersions.state + 1)],
      indeterminate: [],
    });
  } finally {
    state.db.exec(`PRAGMA user_version = ${supportedVersions.state};`);
  }
});

it.each(["DELETE", "WAL"])(
  "checks committed shared-state metadata without snapshot space (%s)",
  async (journalMode) => {
    const fixture = databaseFixture(tempDirs.make("state-schema-only-"));
    const pathname = fixture.state().path;
    closeOpenClawStateDatabaseForTest();
    using writer = openRawDatabase(pathname);
    writer.exec(`PRAGMA journal_mode=${journalMode}; PRAGMA wal_autocheckpoint=0;`);
    rejectSnapshot(pathname, "No space for a shared-state snapshot", true);
    const inspect = () =>
      fixture.inspect({
        scope: "state",
        preserveSourceArtifacts: false,
        verifyCurrentSchemaShape: true,
      });
    expect(await inspect()).toEqual(compatible);
    writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=999;");
    try {
      expect(await inspect()).toEqual(compatible);
      expect(writer.isTransaction).toBe(true);
      expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
    } finally {
      writer.exec("ROLLBACK;");
    }
    writer.exec(`PRAGMA user_version=${supportedVersions.state + 1};`);
    expect(await inspect()).toMatchObject({
      incompatible: [versionRow("state", pathname, supportedVersions.state + 1)],
      indeterminate: [],
    });
    writer.exec(`PRAGMA user_version=${supportedVersions.state}; DROP TABLE schema_meta;`);
    expect(await inspect()).toMatchObject({
      incompatible: [],
      indeterminate: [{ kind: "state", path: pathname }],
    });
  },
);

it("checks fresh metadata without space for an agent snapshot", async () => {
  const fixture = databaseFixture(tempDirs.make("schema-only-preflight-"));
  const agentPath = fixture.agent("worker").path;
  closeDatabases();
  using writer = openRawDatabase(agentPath);
  writer.exec("PRAGMA journal_mode=DELETE; PRAGMA wal_autocheckpoint=0;");
  writer
    .prepare("UPDATE schema_meta SET app_version='inspection-fixture' WHERE meta_key='primary'")
    .run();
  rejectSnapshot(agentPath, "No space for a full agent database snapshot", true);
  const config = { agents: { entries: { worker: {} } } };
  const ready = (operation: "doctor" | "gateway-restart" | "gateway-startup") =>
    operation === "doctor"
      ? fixture.doctor([{ agentId: "worker", path: agentPath }], config)
      : fixture.ready(config, operation);
  const inspect = (verifyCurrentSchemaShape: boolean) =>
    fixture.inspect({ verifyCurrentSchemaShape, agentAdmissionConfig: config, supportedVersions });
  await expect(ready("doctor")).resolves.toBeUndefined();
  await expect(ready("gateway-restart")).resolves.toBeUndefined();
  await expect(ready("gateway-startup")).resolves.toBeUndefined();
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(await inspect(verifyCurrentSchemaShape), `shape=${verifyCurrentSchemaShape}`).toEqual({
      incompatible: [],
      indeterminate: [],
    });
  }
  writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=999;");
  try {
    await expect(ready("doctor")).resolves.toBeUndefined();
    expect(writer.isTransaction).toBe(true);
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
  } finally {
    writer.exec("ROLLBACK;");
  }
  writer.exec(`PRAGMA user_version=${supportedVersions.agent + 1};`);
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      await inspect(verifyCurrentSchemaShape),
      `shape=${verifyCurrentSchemaShape}`,
    ).toMatchObject({
      incompatible: [
        {
          ...versionRow("agent", agentPath, supportedVersions.agent + 1),
          writerAppVersion: "inspection-fixture",
        },
      ],
      indeterminate: [],
    });
  }
  writer.exec(`PRAGMA user_version=${supportedVersions.agent};`);
  writer.prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'").run("foreign");
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      (await inspect(verifyCurrentSchemaShape)).agentRefusals,
      `shape=${verifyCurrentSchemaShape}`,
    ).toEqual([
      expect.objectContaining({ agentId: "worker", code: "agent-database-ownership-mismatch" }),
    ]);
  }
  await expect(ready("doctor")).rejects.toThrow("belongs to agent foreign");
  await expect(ready("gateway-restart")).rejects.toThrow("belongs to agent foreign");
  await expect(ready("gateway-startup")).rejects.toThrow("belongs to agent foreign");
  writer.prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'").run("worker");
  writer.exec("DROP INDEX idx_agent_cache_expiry;");
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      await inspect(verifyCurrentSchemaShape),
      `shape=${verifyCurrentSchemaShape}`,
    ).toMatchObject({
      incompatible: [],
      indeterminate: verifyCurrentSchemaShape
        ? [failureRow("agent", agentPath, expect.stringContaining("idx_agent_cache_expiry"))]
        : [],
    });
  }
  writer.exec("ALTER TABLE schema_meta RENAME COLUMN agent_id TO retired_agent_id;");
  expect(await inspect(false), "shape=false").toMatchObject({
    incompatible: [],
    indeterminate: [expect.objectContaining({ kind: "agent", path: agentPath })],
  });
});

it.each([
  { mode: "header", cleanupFailure: "false" },
  { mode: "startup", cleanupFailure: "reject" },
] as const)(
  "finishes sibling inspections after private snapshot cleanup $cleanupFailure ($mode)",
  async ({ mode, cleanupFailure }) => {
    const fixture = databaseFixture(tempDirs.make("schema-owned-snapshot-"));
    const agentPath = fixture.agent("worker").path;
    for (const agentId of ["sibling", "queued"]) {
      fixture.agent(agentId);
    }
    closeDatabases();
    const snapshotPath = path.join(tempDirs.make("schema-owned-copy-"), "snapshot.sqlite");
    fs.copyFileSync(agentPath, snapshotPath);
    const cleanup = vi.fn(() => true);
    const controller = new AbortController();
    const onAgentInspection = vi.fn();
    const rejectedCleanup = new Error("snapshot cleanup failed: fixture removal rejected");
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
      async (pathname, options) => {
        if (path.resolve(pathname) !== agentPath) {
          return prepare(pathname, options);
        }
        return { location: snapshotPath, cleanup, cleanupAsync: async () => cleanup() };
      },
    );
    const inspect = () => {
      const run = () =>
        fixture.inspect({
          preserveSourceArtifacts: true,
          verifyCurrentSchemaShape: mode !== "header",
          requireStartupMigrationReadiness: mode === "startup",
          signal: controller.signal,
          onAgentInspection,
          supportedVersions,
        });
      return mode === "startup" ? withAgentDatabaseStartupAdmission(run) : run();
    };
    expect(await inspect()).toEqual(compatible);
    if (cleanupFailure === "false") {
      cleanup.mockReturnValue(false);
    } else {
      cleanup.mockImplementation(() => {
        throw rejectedCleanup;
      });
    }
    onAgentInspection.mockClear();
    expect(await inspect()).toEqual({
      ...compatible,
      ...(mode === "startup"
        ? {
            agentRefusals: [
              expect.objectContaining({
                agentId: "worker",
                paths: [agentPath],
                code: "agent-database-inspection-failed",
                reason: expect.stringContaining("snapshot cleanup failed"),
              }),
            ],
          }
        : {
            indeterminate: [
              failureRow("agent", agentPath, expect.stringContaining("snapshot cleanup failed")),
            ],
          }),
    });
    expect(onAgentInspection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ schemaInspectionCount: 3 }),
    );
    if (cleanupFailure === "reject") {
      const cancelled = new Error("caller stopped during cleanup");
      cleanup.mockImplementation(() => {
        controller.abort(cancelled);
        throw rejectedCleanup;
      });
      await expect(inspect()).rejects.toBe(cancelled);
    }
    expect(cleanup).toHaveBeenCalledTimes(cleanupFailure === "reject" ? 3 : 2);
  },
);
