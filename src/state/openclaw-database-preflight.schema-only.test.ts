import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  closeDatabases,
  openRawDatabase,
  rejectSnapshot,
} from "./database-preflight-fixtures.test-support.js";
import { openOpenClawAgentDatabase, OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  withArtifactPreservingStateReads,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabases();
});

it("upgrades the subagent authority format without rewriting rows and refuses schema-24 targets", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("subagent-authority-format-") };
  const pathname = openOpenClawStateDatabase({ env }).path;
  await closeOpenClawStateDatabaseAsync();
  const payload = JSON.stringify({
    runId: "interrupted-child",
    operatorRecoverySource: {
      version: 1,
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "parent-session",
      lifecycleRevision: "parent-lifecycle",
      sourceRunId: "parent-turn",
      snapshot: {
        profileId: "original-operator",
        scopes: ["operator.write"],
        assignedRole: null,
        githubLogin: null,
        grant: null,
        aliasBindingIds: [],
        authPolicy: {
          generation: "",
          grantGeneration: "original-grant",
          role: "operator",
          authMethod: "token",
        },
        controlUiAdmin: false,
        localOperator: false,
        sourceIngress: "internal",
      },
    },
  });
  const catalogSql = "SELECT type, name, sql FROM sqlite_schema ORDER BY type, name";
  let catalog;
  {
    using fixture = openRawDatabase(pathname);
    fixture.exec(`PRAGMA user_version = 24;
      UPDATE schema_meta SET schema_version = 24 WHERE meta_key = 'primary';
      UPDATE config_machine_state SET value_json = '24'
        WHERE state_key = 'state.schema.contentVersion';`);
    fixture
      .prepare(`INSERT INTO subagent_runs
      (run_id, child_session_key, requester_session_key, created_at, payload_json)
      VALUES ('interrupted-child', 'agent:main:subagent:child', 'agent:main:main', 1, ?)`)
      .run(payload);
    catalog = fixture.prepare(catalogSql).all();
  }
  // A prior process's file must acquire fresh physical admission, not cached version facts.
  fs.renameSync(pathname, `${pathname}.v24`);
  fs.copyFileSync(`${pathname}.v24`, pathname);
  const { db } = openOpenClawStateDatabase({ env });
  expect(db.prepare("PRAGMA user_version").get()).toEqual({
    user_version: OPENCLAW_STATE_SCHEMA_VERSION,
  });
  expect(
    db.prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'").get(),
  ).toEqual({ schema_version: OPENCLAW_STATE_SCHEMA_VERSION });
  expect(
    db.prepare("SELECT payload_json FROM subagent_runs WHERE run_id = 'interrupted-child'").get(),
  ).toEqual({ payload_json: payload });
  expect(db.prepare(catalogSql).all()).toEqual(catalog);
  await closeOpenClawStateDatabaseAsync();
  expect(
    await preflightOpenClawDatabaseSchemas({
      env,
      scope: "state",
      supportedVersions: { state: 24, agent: OPENCLAW_AGENT_SCHEMA_VERSION },
    }),
  ).toMatchObject({
    incompatible: [
      {
        kind: "state",
        path: pathname,
        foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
        supportedVersion: 24,
      },
    ],
    indeterminate: [],
  });
});

it("keeps readiness on the admitted shared-state snapshot and observes changes in the next admission", async () => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("schema-admitted-snapshot-") };
  const state = openOpenClawStateDatabase({ env });
  const inspect = () =>
    preflightOpenClawDatabaseSchemas({
      env,
      scope: "state",
      requireStartupMigrationReadiness: true,
    });
  try {
    await withArtifactPreservingStateReads(() =>
      withOpenClawStateDatabaseReadSnapshot(
        async () => {
          state.db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
          expect(await inspect()).toEqual({ incompatible: [], indeterminate: [] });
        },
        { env },
      ),
    );
    expect(await inspect()).toMatchObject({
      incompatible: [
        { kind: "state", path: state.path, foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1 },
      ],
      indeterminate: [],
    });
  } finally {
    state.db.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
  }
});

it.each(["DELETE", "WAL"])(
  "checks committed shared-state metadata without snapshot space (%s)",
  async (journalMode) => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("state-schema-only-") };
    const pathname = openOpenClawStateDatabase({ env }).path;
    closeOpenClawStateDatabaseForTest();
    using writer = openRawDatabase(pathname);
    writer.exec(`PRAGMA journal_mode=${journalMode}; PRAGMA wal_autocheckpoint=0;`);
    rejectSnapshot(pathname, "No space for a shared-state snapshot", true);
    const inspect = () =>
      preflightOpenClawDatabaseSchemas({
        env,
        scope: "state",
        preserveSourceArtifacts: false,
        verifyCurrentSchemaShape: true,
      });
    expect(await inspect()).toEqual({ incompatible: [], indeterminate: [] });
    writer.exec("BEGIN IMMEDIATE; PRAGMA user_version=999;");
    try {
      expect(await inspect()).toEqual({ incompatible: [], indeterminate: [] });
      expect(writer.isTransaction).toBe(true);
      expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
    } finally {
      writer.exec("ROLLBACK;");
    }
    writer.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION + 1};`);
    expect(await inspect()).toMatchObject({
      incompatible: [
        { kind: "state", path: pathname, foundVersion: OPENCLAW_STATE_SCHEMA_VERSION + 1 },
      ],
      indeterminate: [],
    });
    writer.exec(`PRAGMA user_version=${OPENCLAW_STATE_SCHEMA_VERSION}; DROP TABLE schema_meta;`);
    expect(await inspect()).toMatchObject({
      incompatible: [],
      indeterminate: [{ kind: "state", path: pathname }],
    });
  },
);

it("checks fresh metadata without space for an agent snapshot", async () => {
  const env = {
    OPENCLAW_STATE_DIR: tempDirs.make("schema-only-preflight-"),
  };
  const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
  closeDatabases();
  using writer = openRawDatabase(agentPath);
  writer.exec("PRAGMA journal_mode=DELETE; PRAGMA wal_autocheckpoint=0;");
  writer
    .prepare("UPDATE schema_meta SET app_version='inspection-fixture' WHERE meta_key='primary'")
    .run();
  rejectSnapshot(agentPath, "No space for a full agent database snapshot", true);
  const config = { agents: { entries: { worker: {} } } };
  const ready = (operation: "doctor" | "gateway-restart" | "gateway-startup") =>
    assertOpenClawDatabasesReady({
      env,
      config,
      operation,
      configuredAgentDatabaseTargets: [{ agentId: "worker", path: agentPath }],
    });
  const inspect = (verifyCurrentSchemaShape: boolean) =>
    preflightOpenClawDatabaseSchemas({
      env,
      verifyCurrentSchemaShape,
      agentAdmissionConfig: config,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    });
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
  writer.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION + 1};`);
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      await inspect(verifyCurrentSchemaShape),
      `shape=${verifyCurrentSchemaShape}`,
    ).toMatchObject({
      incompatible: [
        {
          kind: "agent",
          path: agentPath,
          foundVersion: OPENCLAW_AGENT_SCHEMA_VERSION + 1,
          writerAppVersion: "inspection-fixture",
        },
      ],
      indeterminate: [],
    });
  }
  writer.exec(`PRAGMA user_version=${OPENCLAW_AGENT_SCHEMA_VERSION};`);
  writer.prepare("UPDATE schema_meta SET agent_id = ? WHERE meta_key = 'primary'").run("foreign");
  for (const verifyCurrentSchemaShape of [false, true]) {
    expect(
      (await inspect(verifyCurrentSchemaShape)).agentRefusals,
      `shape=${verifyCurrentSchemaShape}`,
    ).toEqual([
      expect.objectContaining({
        agentId: "worker",
        code: "agent-database-ownership-mismatch",
      }),
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
        ? [
            {
              kind: "agent",
              path: agentPath,
              reason: expect.stringContaining("idx_agent_cache_expiry"),
            },
          ]
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
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("schema-owned-snapshot-") };
    const agentPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    for (const agentId of ["sibling", "queued"]) {
      openOpenClawAgentDatabase({ agentId, env });
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
        preflightOpenClawDatabaseSchemas({
          env,
          preserveSourceArtifacts: true,
          verifyCurrentSchemaShape: mode !== "header",
          requireStartupMigrationReadiness: mode === "startup",
          signal: controller.signal,
          onAgentInspection,
          supportedVersions: {
            state: OPENCLAW_STATE_SCHEMA_VERSION,
            agent: OPENCLAW_AGENT_SCHEMA_VERSION,
          },
        });
      return mode === "startup" ? withAgentDatabaseStartupAdmission(run) : run();
    };
    expect(await inspect()).toEqual({ incompatible: [], indeterminate: [] });
    if (cleanupFailure === "false") {
      cleanup.mockReturnValue(false);
    } else {
      cleanup.mockImplementation(() => {
        throw rejectedCleanup;
      });
    }
    onAgentInspection.mockClear();
    expect(await inspect()).toEqual({
      incompatible: [],
      indeterminate:
        mode === "startup"
          ? []
          : [
              {
                kind: "agent",
                path: agentPath,
                reason: expect.stringContaining("snapshot cleanup failed"),
              },
            ],
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
        : {}),
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
