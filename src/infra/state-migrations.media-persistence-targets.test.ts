import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournal,
} from "../state/agent-deletion-journal.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawRegisteredAgentDatabases,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { assertOpenClawDatabasesReady } from "../state/openclaw-database-preflight.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];
const PREVIOUS_VERSION = 16;
const RETAINED_NOTICE = (databasePath: string, agentId: string) =>
  `Held retained database ${databasePath} for deleted agent ${agentId}; restore that agent from backup or move this database out of the active state directory, then rerun openclaw doctor --fix.`;

function createLegacyAgentDatabase(params: {
  agentId?: string;
  env: NodeJS.ProcessEnv;
  path?: string;
  version?: number;
}): string {
  const agentId = params.agentId ?? "main";
  const opened = openOpenClawAgentDatabase({
    agentId,
    env: params.env,
    ...(params.path ? { path: params.path } : {}),
  });
  const databasePath = opened.path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  try {
    const version = params.version ?? PREVIOUS_VERSION;
    if (version === PREVIOUS_VERSION) {
      database.exec("DROP TABLE session_participants");
    }
    database.exec(`PRAGMA user_version = ${version};`);
    database
      .prepare("UPDATE schema_meta SET schema_version = ? WHERE meta_key = 'primary'")
      .run(version);
  } finally {
    database.close();
  }
  return databasePath;
}

function readUserVersion(databasePath: string): number {
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  } finally {
    database.close();
  }
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("media persistence migration targets", () => {
  it("skips a retained database after its agent deletion completes", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-retained-deletion-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "retired";
    const operationId = "retained-deletion";
    const databasePath = createLegacyAgentDatabase({ agentId, env });
    const agentDir = path.dirname(databasePath);
    beginAgentDeletionJournal(
      {
        agentId,
        operationId,
        agentDir,
        workspaceDir: path.join(stateDir, "workspaces", agentId),
        sessionsDir: path.join(agentDir, "sessions"),
        databasePaths: [databasePath],
        deleteFiles: false,
      },
      { env },
    );
    expect(completeAgentDeletionJournal(agentId, operationId, { env })).toBe(true);
    unregisterOpenClawAgentDatabase({ agentId, env, path: databasePath });

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(result.notices).toEqual([RETAINED_NOTICE(databasePath, agentId)]);
    expect(readUserVersion(databasePath)).toBe(PREVIOUS_VERSION);
  });

  it("migrates a retained path claimed by a surviving configured owner", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-retained-surviving-owner-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "retired", "agent", "openclaw-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "survivor", env, path: databasePath });
    const operationId = "retained-surviving-owner";
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId,
        agentDir: path.dirname(databasePath),
        workspaceDir: path.join(stateDir, "workspaces", "retired"),
        sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
        databasePaths: [databasePath],
        deleteFiles: false,
      },
      { env },
    );
    expect(completeAgentDeletionJournal("retired", operationId, { env })).toBe(true);

    const result = await migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "survivor", path: databasePath }],
      env,
    });

    expect(result.warnings).toEqual([]);
    expect(result.notices).toBeUndefined();
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "survivor", path: databasePath })]);
  });

  it("migrates a surviving registered owner through a hardlink to a retained path", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-retained-hardlink-owner-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const retainedPath = path.join(stateDir, "agents", "retired", "agent", "openclaw-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "survivor", env, path: retainedPath });
    unregisterOpenClawAgentDatabase({ agentId: "survivor", env, path: retainedPath });
    const survivingPath = path.join(stateDir, "stores", "survivor.sqlite");
    fs.mkdirSync(path.dirname(survivingPath), { recursive: true });
    fs.linkSync(retainedPath, survivingPath);
    registerOpenClawAgentDatabase({
      agentId: "survivor",
      env,
      path: survivingPath,
      schemaVersion: PREVIOUS_VERSION,
    });
    const operationId = "retained-hardlink-owner";
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId,
        agentDir: path.dirname(retainedPath),
        workspaceDir: path.join(stateDir, "workspaces", "retired"),
        sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
        databasePaths: [retainedPath],
        deleteFiles: false,
      },
      { env },
    );
    expect(completeAgentDeletionJournal("retired", operationId, { env })).toBe(true);

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(result.notices).toBeUndefined();
    expect(readUserVersion(retainedPath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(readUserVersion(survivingPath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it("holds an unowned database when deletion journal history is unavailable", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-missing-deletion-history-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyAgentDatabase({ agentId: "unknown", env });
    const state = openOpenClawStateDatabase({ env });
    state.db.exec("DROP TABLE agent_deletion_journal");
    closeOpenClawStateDatabaseForTest();

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([
      expect.stringContaining("Agent database maintenance deferred"),
    ]);
    expect(readUserVersion(databasePath)).toBe(PREVIOUS_VERSION);
  });

  it("holds an unowned database when retained deletion history is malformed", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-malformed-deletion-history-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const agentId = "unknown";
    const operationId = "malformed-deletion-history";
    const databasePath = createLegacyAgentDatabase({ agentId, env });
    beginAgentDeletionJournal(
      {
        agentId,
        operationId,
        agentDir: path.dirname(databasePath),
        workspaceDir: path.join(stateDir, "workspaces", agentId),
        sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
        databasePaths: [databasePath],
        deleteFiles: false,
      },
      { env },
    );
    expect(completeAgentDeletionJournal(agentId, operationId, { env })).toBe(true);
    const state = openOpenClawStateDatabase({ env });
    state.db
      .prepare("UPDATE agent_deletion_journal SET database_paths_json = ? WHERE agent_id = ?")
      .run("{}", agentId);
    closeOpenClawStateDatabaseForTest();

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toContain(
      `Skipped unowned agent database ${databasePath}; deletion journal history is unavailable.`,
    );
    expect(readUserVersion(databasePath)).toBe(PREVIOUS_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId, path: databasePath })]);
  });

  it("migrates a configured active database when deletion history is malformed", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-malformed-active-history-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyAgentDatabase({ agentId: "active", env });
    beginAgentDeletionJournal(
      {
        agentId: "retired",
        operationId: "malformed-active-history",
        agentDir: path.join(stateDir, "agents", "retired", "agent"),
        workspaceDir: path.join(stateDir, "workspaces", "retired"),
        sessionsDir: path.join(stateDir, "agents", "retired", "sessions"),
        databasePaths: [path.join(stateDir, "agents", "retired", "agent.sqlite")],
        deleteFiles: false,
      },
      { env },
    );
    expect(completeAgentDeletionJournal("retired", "malformed-active-history", { env })).toBe(true);
    const state = openOpenClawStateDatabase({ env });
    state.db
      .prepare("UPDATE agent_deletion_journal SET database_paths_json = ? WHERE agent_id = ?")
      .run("{}", "retired");
    closeOpenClawStateDatabaseForTest();

    const result = await migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "active", path: databasePath }],
      env,
    });

    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Could not read retained agent deletion history"),
      ]),
    );
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it.each([PREVIOUS_VERSION, 18])(
    "rechecks deletion ownership before version %i database writes",
    async (version) => {
      const stateDir = fs.realpathSync.native(
        makeTempDir(tempDirs, "media-persistence-deletion-race-"),
      );
      const env = { OPENCLAW_STATE_DIR: stateDir };
      const agentId = "retired-during-migration";
      const operationId = "retired-during-migration";
      const databasePath = createLegacyAgentDatabase({ agentId, env, version });
      const bytesBefore = fs.readFileSync(databasePath);
      let deletionCompleted = false;

      const result = await migrateLegacyMediaPersistence({
        env,
        hooks: {
          beforeDatabaseWrite: () => {
            if (deletionCompleted) {
              return;
            }
            beginAgentDeletionJournal(
              {
                agentId,
                operationId,
                agentDir: path.dirname(databasePath),
                workspaceDir: path.join(stateDir, "workspaces", agentId),
                sessionsDir: path.join(stateDir, "agents", agentId, "sessions"),
                databasePaths: [databasePath],
                deleteFiles: false,
              },
              { env },
            );
            expect(completeAgentDeletionJournal(agentId, operationId, { env })).toBe(true);
            deletionCompleted = true;
          },
        },
      });

      expect(result.warnings).toEqual([]);
      expect(result.notices).toEqual([RETAINED_NOTICE(databasePath, agentId)]);
      expect(fs.readFileSync(databasePath)).toEqual(bytesBefore);
      expect(readUserVersion(databasePath)).toBe(version);
      expect(
        listOpenClawRegisteredAgentDatabases({
          env,
          includeIncompatibleSchemaVersions: true,
        }),
      ).toEqual([expect.objectContaining({ agentId, path: databasePath })]);
    },
  );

  it("upgrades an active version 18 database through the same write boundary", async () => {
    const stateDir = fs.realpathSync.native(makeTempDir(tempDirs, "media-persistence-active-v18-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyAgentDatabase({ agentId: "active", env, version: 18 });

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(result.notices).toBeUndefined();
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
  });

  it("migrates and registers an unregistered default-layout agent database", async () => {
    const stateDir = fs.realpathSync.native(makeTempDir(tempDirs, "media-persistence-disk-scan-"));
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = createLegacyAgentDatabase({ env });
    unregisterOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([
      expect.objectContaining({
        agentId: "main",
        path: databasePath,
        schemaVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
    ]);
  });

  it("prefers a renamed configured owner over the default-layout directory name", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-renamed-owner-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "oldname", "agent", "openclaw-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "renamed", env, path: databasePath });
    unregisterOpenClawAgentDatabase({ agentId: "renamed", env, path: databasePath });

    const result = await migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "renamed", path: databasePath }],
      env,
    });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "renamed", path: databasePath })]);
  });

  it("prefers a recorded owner over the default-layout directory name", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-recorded-owner-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(stateDir, "agents", "dirname", "agent", "openclaw-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "recorded", env, path: databasePath });

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "recorded", path: databasePath })]);
  });

  it("preserves filesystem traversal for registered paths containing dot-dot segments", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-symlink-path-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const symlinkTarget = path.join(stateDir, "external", "subdir");
    fs.mkdirSync(symlinkTarget, { recursive: true });
    fs.symlinkSync(symlinkTarget, path.join(stateDir, "link"), "dir");
    const filesystemPath = path.join(stateDir, "external", "x", "openclaw-agent.sqlite");
    const lexicalPath = path.join(stateDir, "x", "openclaw-agent.sqlite");
    createLegacyAgentDatabase({ env, path: filesystemPath });
    createLegacyAgentDatabase({ env, path: lexicalPath });
    unregisterOpenClawAgentDatabase({ agentId: "main", env, path: filesystemPath });
    unregisterOpenClawAgentDatabase({ agentId: "main", env, path: lexicalPath });
    const registeredPath = `${path.join(stateDir, "link")}${path.sep}..${path.sep}x${path.sep}openclaw-agent.sqlite`;
    expect(fs.realpathSync.native(registeredPath)).toBe(filesystemPath);
    expect(path.resolve(registeredPath)).toBe(lexicalPath);
    registerOpenClawAgentDatabase({
      agentId: "main",
      env,
      path: registeredPath,
      schemaVersion: PREVIOUS_VERSION,
    });

    expect(() =>
      assertOpenClawDatabasesReady({
        env,
        operation: "doctor",
        configuredAgentDatabaseTargets: [],
      }),
    ).toThrow(/uses schema version 16/);
    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(filesystemPath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(readUserVersion(lexicalPath)).toBe(PREVIOUS_VERSION);
    expect(() =>
      assertOpenClawDatabasesReady({
        env,
        operation: "doctor",
        configuredAgentDatabaseTargets: [],
      }),
    ).not.toThrow();
  });

  it("unregisters foreign registry paths without touching their databases", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-active-state-"),
    );
    const foreignStateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-foreign-state-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(
      foreignStateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    createLegacyAgentDatabase({ env, path: databasePath });
    const beforeBytes = fs.readFileSync(databasePath);
    const beforeMtimeMs = fs.statSync(databasePath).mtimeMs;

    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.warnings).toContain(
      `Skipped foreign agent database ${databasePath}; it is outside the active state directory and is not a configured session store.`,
    );
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);
    expect(fs.readFileSync(databasePath)).toEqual(beforeBytes);
    expect(fs.statSync(databasePath).mtimeMs).toBe(beforeMtimeMs);
  });

  it("migrates a configured out-of-tree session store", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-custom-active-"),
    );
    const customRoot = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-custom-store-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const storePath = resolveSessionStorePathCore(
      path.join(customRoot, "{agentId}", "sessions.json"),
      {
        agentId: "main",
        env,
      },
    );
    const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, {
      agentId: "main",
      defaultAgentId: "main",
      env,
    }).path;
    createLegacyAgentDatabase({ env, path: databasePath });
    unregisterOpenClawAgentDatabase({ agentId: "main", env, path: databasePath });
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);

    const result = await migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "main", path: databasePath }],
      env,
    });

    expect(result.warnings).toEqual([]);
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "main", path: databasePath })]);
  });

  it("prefers the configured owner over a stale registry owner for the same path", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-stale-owner-active-"),
    );
    const customRoot = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-stale-owner-store-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const databasePath = path.join(customRoot, "openclaw-agent.sqlite");
    createLegacyAgentDatabase({ agentId: "new", env, path: databasePath });
    unregisterOpenClawAgentDatabase({ agentId: "new", env, path: databasePath });
    registerOpenClawAgentDatabase({
      agentId: "old",
      env,
      path: databasePath,
      schemaVersion: PREVIOUS_VERSION,
    });

    expect(() =>
      assertOpenClawDatabasesReady({
        env,
        operation: "doctor",
        configuredAgentDatabaseTargets: [{ agentId: "new", path: databasePath }],
      }),
    ).toThrow(/uses schema version 16/);
    expect(
      listOpenClawRegisteredAgentDatabases({ env, includeIncompatibleSchemaVersions: true }),
    ).toEqual([expect.objectContaining({ agentId: "old", path: databasePath })]);
    const result = await migrateLegacyMediaPersistence({
      configuredAgentDatabaseTargets: [{ agentId: "new", path: databasePath }],
      env,
    });

    expect(result.warnings).toContain(
      `Skipped foreign agent database ${databasePath}; it is outside the active state directory and is not a configured session store.`,
    );
    expect(readUserVersion(databasePath)).toBe(OPENCLAW_AGENT_SCHEMA_VERSION);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([expect.objectContaining({ agentId: "new", path: databasePath })]);
  });

  it("prunes missing and archived registry entries before migration", async () => {
    const stateDir = fs.realpathSync.native(
      makeTempDir(tempDirs, "media-persistence-registry-hygiene-"),
    );
    const env = { OPENCLAW_STATE_DIR: stateDir };
    const missingPath = path.join(stateDir, "agents", "missing", "agent", "openclaw-agent.sqlite");
    const archivedPath = path.join(stateDir, "imports", "archived", "openclaw-agent.sqlite");
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.writeFileSync(archivedPath, "archived fixture");
    const state = openOpenClawStateDatabase({ env });
    const insert = state.db.prepare(
      "INSERT INTO agent_databases(agent_id,path,schema_version,last_seen_at,size_bytes) VALUES(?,?,?,?,?)",
    );
    insert.run("missing", missingPath, OPENCLAW_AGENT_SCHEMA_VERSION, 1, null);
    insert.run("archived", archivedPath, 8, 1, null);

    expect(() =>
      assertOpenClawDatabasesReady({
        env,
        operation: "doctor",
        configuredAgentDatabaseTargets: [],
      }),
    ).not.toThrow();
    expect(
      state.db.prepare("SELECT agent_id FROM agent_databases ORDER BY agent_id").all(),
    ).toEqual([{ agent_id: "archived" }, { agent_id: "missing" }]);
    const result = await migrateLegacyMediaPersistence({ env });

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Removed missing agent database registry entry"),
        expect.stringContaining("Removed archived or transient agent database registry entry"),
      ]),
    );
    expect(result.warnings).toContain(`Skipped missing registered agent database ${missingPath}.`);
    expect(
      listOpenClawRegisteredAgentDatabases({
        env,
        includeIncompatibleSchemaVersions: true,
      }),
    ).toEqual([]);
  });
});
