import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readSelectedSessionEntryRows } from "../config/sessions/session-accessor.sqlite-entry-select.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  readSqliteCleanCloseSeal,
  writeSqliteCleanCloseSeal,
} from "../infra/sqlite-clean-close-seal.js";
import {
  revokeSqliteDatabaseAdmissionsForPath,
  retireSqliteDatabaseAdmissionForPath,
  readSqliteDatabaseCleanClose,
} from "../infra/sqlite-database-admission.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import * as integrityWorker from "../infra/sqlite-integrity-worker.js";
import * as integrity from "../infra/sqlite-integrity.js";
import * as snapshots from "../infra/sqlite-snapshot-source.js";
import { VERSION } from "../version.js";
import { readAgentDatabaseAdmissionRefusal } from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import {
  supportedVersions,
  closeDatabases,
  databaseFixture,
  agentConfig,
  expectFiles,
  openRawDatabase,
  rejectSnapshot,
} from "./database-preflight-fixtures.test-support.js";
import {
  openOpenClawAgentDatabaseReadOnly,
  withFreshOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "./openclaw-agent-db-readonly-open.js";
import {
  closeOpenClawAgentDatabaseByPath,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { snapshotPreflightSourceManifest } from "./openclaw-database-preflight.test-support.js";
import { sqliteDatabaseSealSchemaFor } from "./openclaw-database-seal-schema.js";
import {
  closeOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  closeDatabases();
});

function transcriptRows(reader: OpenClawAgentReadOnlyDatabase) {
  return readSelectedSessionEntryRows(reader, ["synthetic"], "full", undefined, {
    includeRowTranscriptProjection: true,
  });
}

it("cold-loads a compatible storage seal without validation SQL or snapshots", async () => {
  const fixture = databaseFixture(tempDirs.make("openclaw-clean-startup-"));
  const { path: agentPath } = fixture.agent();
  closeOpenClawAgentDatabaseByPath(agentPath);
  closeOpenClawStateDatabase();
  expect(readSqliteDatabaseCleanClose(agentPath)).toBe(true);
  expectFiles([`${agentPath}-wal`, `${agentPath}-shm`], false);
  retireSqliteDatabaseAdmissionForPath(agentPath);
  const before = fs.readFileSync(agentPath);
  const validate = vi.spyOn(integrity, "assertSqliteIntegrity");
  rejectSnapshot(agentPath, "No space for a full agent database snapshot");
  const onAgentInspection = vi.fn();
  await expect(
    fixture.ready(undefined, "gateway-startup", { onAgentInspection }),
  ).resolves.toBeUndefined();
  expect(onAgentInspection).toHaveBeenLastCalledWith(
    expect.objectContaining({ schemaSnapshotCount: 0, schemaProcessCount: 0 }),
  );
  expect(validate).not.toHaveBeenCalled();
  expect(fs.readFileSync(agentPath)).toEqual(before);
  expect(readSqliteDatabaseCleanClose(agentPath)).toBe(true);
});

it.each(["legacy", "malformed", "unknown-policy"])(
  "runs full agent admission for a %s seal",
  async (kind) => {
    const fixture = databaseFixture(tempDirs.make("openclaw-invalid-seal-"));
    const { path: agentPath } = fixture.agent();
    closeDatabases();
    const file = fs.statSync(agentPath, { bigint: true });
    const seal = readSqliteCleanCloseSeal(agentPath, file)!;
    if (kind === "malformed") {
      fs.writeFileSync(`${agentPath}.seal`, "{torn");
    } else {
      const identity =
        kind === "legacy"
          ? createHash("sha256")
              .update(JSON.stringify([2, VERSION, "agent"]))
              .update(OPENCLAW_AGENT_SCHEMA_SQL)
              .digest("hex")
          : "unknown-policy";
      expect(
        writeSqliteCleanCloseSeal(agentPath, identity, file, {
          ...seal,
          identity:
            kind === "legacy"
              ? undefined
              : { ...sqliteDatabaseSealSchemaFor("agent")!.identity, policy: -1 },
        }),
      ).toBe(true);
    }
    retireSqliteDatabaseAdmissionForPath(agentPath);
    expect(readSqliteDatabaseCleanClose(agentPath)).toBe(false);
    fixture.state();
    const check = vi.spyOn(integrityWorker, "runSqliteIntegrityCheckInWorkerSync");
    fixture.agent();
    expect(check.mock.calls.filter(([input]) => input.databaseLabel === agentPath)).toHaveLength(1);
  },
);

it("admits every previously sealed same-version agent before transcript readers run", async () => {
  const fixture = databaseFixture(tempDirs.make("startup-additive-seal-"));
  const { env } = fixture;
  const ids = ["claude", "codex", "openclaw", "node-livetest", "roboclaw-x"];
  const agents = ids.map((agentId) => ({ agentId, path: fixture.agent(agentId).path }));
  closeDatabases();
  for (const agent of agents) {
    const identity = sqliteDatabaseSealSchemaFor("agent")!.schemaIdentity;
    const seal = readSqliteCleanCloseSeal(agent.path, fs.statSync(agent.path, { bigint: true }))!;
    expect(seal).toBeDefined();
    revokeSqliteDatabaseAdmissionsForPath(agent.path);
    const old = new (requireNodeSqlite().DatabaseSync)(agent.path);
    old.exec(`
      ALTER TABLE session_windows DROP COLUMN row_transcript_json;
      ALTER TABLE session_windows DROP COLUMN row_transcript_updated_at;
      PRAGMA wal_checkpoint(TRUNCATE);
    `);
    const tableSql = old
      .prepare("SELECT sql FROM sqlite_schema WHERE name='session_windows'")
      .get()!.sql;
    const schemaVersion = old.prepare("PRAGMA schema_version").get()!.schema_version;
    old.close();
    retireSqliteDatabaseAdmissionForPath(agent.path);
    // Previous-build completed facts describe the actual older catalog. Keep the
    // current identity too: a matching hash alone must not bless missing columns.
    const facts = JSON.parse(String(seal.facts), (key, value) => {
      if (key === "tableSql" && value?.sealType === "map") {
        value.entries = value.entries.map(([name, sql]: [string, string]) => [
          name,
          name === "session_windows" ? tableSql : sql,
        ]);
      }
      if (value?.tableSql) {
        value.schemaVersion = schemaVersion;
      }
      return value;
    });
    expect(
      writeSqliteCleanCloseSeal(agent.path, identity, fs.statSync(agent.path, { bigint: true }), {
        verifiedAt: seal.verifiedAt,
        facts: JSON.stringify(facts),
      }),
    ).toBe(true);
    expect(() => withFreshOpenClawAgentDatabaseReadOnly(transcriptRows, { ...agent, env })).toThrow(
      "requires writable startup admission before session reads",
    );
    expect(readSqliteDatabaseCleanClose(agent.path)).toBe(false);
  }
  const config = agentConfig(ids, "claude");
  await withAgentDatabaseStartupAdmission(async (admission) => {
    await expect(fixture.ready(config)).resolves.toBeUndefined();
    const owner = admission.adopt();
    try {
      for (const { agentId } of agents) {
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })?.code).toBe(
          "agent-database-inspection-pending",
        );
      }
      admission.activate({
        isCurrent: () => true,
        preparationReady: Promise.resolve(),
        openAgent: async ({ agentId, paths, assertCurrent }) => {
          for (const pathname of paths) {
            await withOpenClawAgentDatabaseAsync(
              { agentId, path: pathname, env },
              () => {},
              assertCurrent,
            );
          }
        },
        migrateAgent: async ({ agentId, paths }) => {
          for (const pathname of paths) {
            expect(
              withFreshOpenClawAgentDatabaseReadOnly(transcriptRows, {
                agentId,
                path: pathname,
                env,
              }),
            ).toEqual({ found: true, value: [] });
          }
        },
        publishAgent: async () => {},
      });
      await admission.pendingPreparation;
      for (const { agentId } of agents) {
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
      }
    } finally {
      await owner.stop();
    }
  });
});

it("prioritizes newer schema refusal over missing same-version reader columns", () => {
  const fixture = databaseFixture(tempDirs.make("startup-newer-additive-"));
  const agent = fixture.agent();
  closeDatabases();
  revokeSqliteDatabaseAdmissionsForPath(agent.path);
  using writer = new (requireNodeSqlite().DatabaseSync)(agent.path);
  const version = Number(writer.prepare("PRAGMA user_version").get()!.user_version);
  writer.exec(
    `ALTER TABLE session_windows DROP COLUMN row_transcript_json; PRAGMA user_version=${version + 1};`,
  );
  expect(() =>
    openOpenClawAgentDatabaseReadOnly({ agentId: "main", path: agent.path, env: fixture.env }),
  ).toThrow(/newer schema version/iu);
});

it("reads a replacement database's committed WAL after loading the old clean seal", async () => {
  const fixture = databaseFixture(tempDirs.make("openclaw-startup-replaced-seal-"));
  const { path: statePath } = fixture.state();
  await closeOpenClawStateDatabaseAsync();
  const replacementPath = `${statePath}.replacement`;
  const archivedPath = `${statePath}.previous`;
  const sqlite = requireNodeSqlite();
  {
    using source = openRawDatabase(statePath, { readOnly: true });
    await sqlite.backup(source, replacementPath);
  }
  expect(readSqliteDatabaseCleanClose(statePath)).toBe(true);

  // Move complete SQLite families; the old seal intentionally stays at the live path.
  for (const file of resolveSqliteDatabaseFilePaths(statePath)) {
    if (fs.existsSync(file)) {
      fs.renameSync(file, `${archivedPath}${file.slice(statePath.length)}`);
    }
  }
  for (const file of resolveSqliteDatabaseFilePaths(replacementPath)) {
    if (fs.existsSync(file)) {
      fs.renameSync(file, `${statePath}${file.slice(replacementPath.length)}`);
    }
  }

  using replacement = openRawDatabase(statePath);
  replacement.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA wal_autocheckpoint=0;
      PRAGMA user_version=${supportedVersions.state + 1};
    `);
  expect(fs.statSync(`${statePath}-wal`).size).toBeGreaterThan(0);

  await expect(fixture.ready()).rejects.toMatchObject({
    name: "OpenClawDatabaseSchemaPreflightError",
    incompatibleDatabases: [
      expect.objectContaining({
        kind: "state",
        path: statePath,
        foundVersion: supportedVersions.state + 1,
        supportedVersion: supportedVersions.state,
      }),
    ],
  });
});

it.each(["DELETE", "WAL", "closed WAL"])(
  "freshly checks startup integrity off the main thread and preserves %s source artifacts",
  async (mode) => {
    const stateDir = tempDirs.make("openclaw-startup-integrity-");
    const fixture = databaseFixture(stateDir);
    const agentPath = path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite");
    fixture.agent("main", agentPath);
    closeDatabases();
    // These raw writers model unclean external mutation, outside the lease owner.
    revokeSqliteDatabaseAdmissionsForPath(agentPath);
    const { DatabaseSync } = requireNodeSqlite();
    const writer = mode === "closed WAL" ? undefined : new DatabaseSync(agentPath);
    writer?.exec(`PRAGMA journal_mode=${mode}; PRAGMA wal_autocheckpoint=0;`);
    const prepare = snapshots.prepareSqliteReadOnlyLocation;
    vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation((pathname, options) => {
      if (pathname === agentPath && mode !== "closed WAL") {
        throw new Error("No space for a full agent database snapshot");
      }
      return prepare(pathname, options);
    });
    const check = integrity.assertSqliteIntegrity;
    const mainThreadAgentChecks: string[] = [];
    vi.spyOn(integrity, "assertSqliteIntegrity").mockImplementation((database, label) => {
      if (label === agentPath) {
        mainThreadAgentChecks.push(label);
      }
      return check(database, label);
    });
    try {
      for (const damaged of [false, true]) {
        if (damaged) {
          const mutation = writer ?? new DatabaseSync(agentPath);
          try {
            mutation.exec(
              `PRAGMA foreign_keys = OFF; CREATE TABLE integrity_probe_parent(id INTEGER ${mode === "DELETE" ? "" : "PRIMARY KEY"}); CREATE TABLE integrity_probe_child(parent_id INTEGER REFERENCES integrity_probe_parent(id)); INSERT INTO integrity_probe_child VALUES (42);`,
            );
          } finally {
            if (!writer) {
              mutation.close();
            }
          }
        }
        const before = snapshotPreflightSourceManifest(
          stateDir,
          mode === "WAL" ? agentPath : undefined,
        );
        const readiness = fixture.ready();
        if (damaged) {
          await expect(readiness).rejects.toMatchObject({
            name: "SqliteIntegrityError",
            message: expect.stringContaining(`foreign_key_check failed for ${agentPath}`),
            ...(mode === "DELETE"
              ? {
                  cause: {
                    code: "ERR_SQLITE_ERROR",
                    errcode: 1,
                    message: expect.stringContaining("foreign key mismatch"),
                  },
                }
              : {}),
          });
        } else {
          await expect(readiness).resolves.toBeUndefined();
        }
        expect(mainThreadAgentChecks).toEqual([]);
        expect(
          snapshotPreflightSourceManifest(stateDir, mode === "WAL" ? agentPath : undefined),
        ).toEqual(before);
      }
    } finally {
      writer?.close();
    }
  },
);

it("isolates a corrupt foreign secondary before reporting its integrity failure", async () => {
  const fixture = databaseFixture(tempDirs.make("openclaw-startup-foreign-"));
  const agentPath = fixture.agent("worker").path;
  closeDatabases();
  using writer = openRawDatabase(agentPath);
  writer.exec(
    "PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=OFF; UPDATE schema_meta SET agent_id='foreign'; CREATE TABLE probe_parent(id INTEGER PRIMARY KEY); CREATE TABLE probe_child(parent_id REFERENCES probe_parent(id)); INSERT INTO probe_child VALUES (42);",
  );
  await expect(fixture.ready(agentConfig(["main", "worker"], "main"))).resolves.toBeUndefined();
  expect(readAgentDatabaseAdmissionRefusal("worker", { env: fixture.env })).toMatchObject({
    embeddedOwnerId: "foreign",
  });
});

it("names the failing state database when startup admission hits a corrupted store", async () => {
  const fixture = databaseFixture(tempDirs.make("startup-state-corruption-"));
  fixture.state();
  closeDatabases();
  fs.writeFileSync(fixture.statePath, "corrupted store bytes");
  const admission = fixture.ready({}, "gateway-startup");
  await expect(admission).rejects.toMatchObject({
    code: "ERR_SQLITE_ERROR",
    message: expect.stringContaining(fixture.statePath),
  });
  await expect(admission).rejects.toThrow(/not a database|disk image is malformed/iu);
});
