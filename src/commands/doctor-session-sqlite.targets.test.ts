import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadExactSessionEntry as readEntry,
  upsertSessionEntryCore as upsertEntry,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync as readEvents } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete as assertMigrated } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { completeAgentDeletionJournalInDatabase } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest as closeDatabases,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { beginAgentDeletionJournal } from "../test-utils/agent-deletion-journal.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import {
  writeJson,
  writePrivateFile,
  runStoreDoctor,
  sessionScope,
  expectPresent,
  jsonl,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  expectMissing,
  expectFiles,
  snapshotFiles,
} from "./doctor-session-sqlite.publication-spies.test-support.js";
import { sessionSqlFixture } from "./doctor-session-sqlite.sql.test-support.js";
import {
  importLegacyStore,
  readMigrationManifest as readManifest,
  useDoctorSessionSqliteTestFixture,
  type TestStore,
} from "./doctor-session-sqlite.test-support.js";

const { autoCleanupTempDirs, createLegacyStore } = useDoctorSessionSqliteTestFixture();

function databasePath(store: TestStore, agentId = "main") {
  return resolveTargetSqlitePath({ agentId, storePath: store.storePath }, store.env);
}

function seedDeletedAgent(store: TestStore, agentId: string, malformed = false) {
  const operationId = `retained-${agentId}`;
  beginAgentDeletionJournal(
    {
      agentId,
      operationId,
      agentDir: path.join(store.stateDir, "agents", agentId, "agent"),
      workspaceDir: path.join(store.stateDir, `workspace-${agentId}`),
      sessionsDir: path.join(store.stateDir, "agents", agentId, "sessions"),
      deleteFiles: false,
    },
    { env: store.env },
  );
  runOpenClawStateWriteTransaction(
    (database) => {
      completeAgentDeletionJournalInDatabase(database, agentId, operationId);
      if (malformed) {
        const sql = sessionSqlFixture(database.db);
        sql`UPDATE agent_deletion_journal SET database_paths_json = '{}' WHERE agent_id = ${agentId}`.run();
      }
    },
    { env: store.env },
  );
}

function importOptions(store: TestStore, custom = false) {
  const cfg: OpenClawConfig = {
    agents: { ownership: "explicit", entries: { main: {} } },
    ...(custom ? { session: { store: store.storePath } } : {}),
  };
  return { cfg, env: store.env, mode: "import" as const };
}

function sourceSnapshot(store: TestStore) {
  return snapshotFiles([store.storePath, store.transcriptPath]);
}

async function expectHeldSelections(
  store: TestStore,
  options: ReturnType<typeof importOptions>,
  sqlitePath: string,
  agent = "main",
) {
  const originals = sourceSnapshot(store);
  for (const selection of [{ agent }, { store: store.storePath }]) {
    const explicit = await runDoctorSessionSqlite({ ...options, ...selection });
    expect(explicit.totals.importedEntries).toBe(0);
    expect(explicit.targets.flatMap((target) => target.issues)).toContainEqual({
      code: "plugin_migration_source_retained",
      message: expect.stringContaining(`store held for agent ${agent} database ${sqlitePath}`),
    });
    expect(sourceSnapshot(store)).toEqual(originals);
    expectMissing(sqlitePath);
  }
}

describe("runDoctorSessionSqlite", () => {
  it.each(["destination", "shared-state"] as const)(
    "preserves legacy sources and orphaned WAL for an unavailable %s database",
    async (owner) => {
      const store = createLegacyStore();
      const sqlitePath = databasePath(store);
      const originals = sourceSnapshot(store);
      const walPath =
        owner === "destination"
          ? `${sqlitePath}-wal`
          : path.join(store.stateDir, "state", "openclaw.sqlite-wal");
      const wal = Buffer.from("unverified orphaned WAL bytes");
      fs.mkdirSync(path.dirname(walPath), { recursive: true });
      fs.writeFileSync(walPath, wal);
      const options = importOptions(store, true);
      expectMissing(sqlitePath);
      const imported = runDoctorSessionSqlite({ ...options, allAgents: true });
      if (owner === "shared-state") {
        await expect(imported).rejects.toThrow("is unavailable");
      } else {
        expect((await imported).targets).toEqual([]);
        expect(() =>
          assertMigrated({ cfg: options.cfg, env: store.env, operation: "doctor" }),
        ).toThrow("Legacy session store requires migration");
        await expectHeldSelections(store, options, sqlitePath);
      }
      expect(sourceSnapshot(store)).toEqual(originals);
      expectMissing(sqlitePath);
      expectFiles(wal, walPath);
    },
  );

  it("holds deleted ownership despite unreadable sibling deletion history", async () => {
    const store = createLegacyStore({ agentDirName: "retired" });
    const sqlitePath = databasePath(store, "retired");
    const originals = sourceSnapshot(store);

    seedDeletedAgent(store, "retired");
    seedDeletedAgent(store, "malformed-sibling", true);

    const options = importOptions(store);
    expectMissing(sqlitePath);
    const imported = runDoctorSessionSqlite({ ...options, allAgents: true });

    expect((await imported).targets).toEqual([]);
    expect(sourceSnapshot(store)).toEqual(originals);
    expectMissing(sqlitePath);
    await expectHeldSelections(store, options, sqlitePath, "retired");
  });

  it("imports explicit entries despite unreadable sibling deletion history", async () => {
    const store = createLegacyStore({ agentDirName: "codex-proof" });

    seedDeletedAgent(store, "malformed-sibling", true);

    const report = await importLegacyStore(store);
    expect(report.targets[0]?.agentId).toBe("codex-proof");
    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 2,
      issues: 0,
      sqliteEntries: 1,
    });
    expect(readEvents(sessionScope(store, "codex-proof"))).toHaveLength(2);
  });

  it.each([
    { internal: false, allAgents: false },
    { internal: true, allAgents: true },
    { internal: false, allAgents: true },
  ])(
    "imports shared stores with selected owners (internal=$internal, allAgents=$allAgents)",
    async ({ internal, allAgents }) => {
      const tempDir = autoCleanupTempDirs.make("openclaw-doctor-session-sqlite-");
      const stateDir = path.join(tempDir, "state");
      const sessionDir = path.join(internal ? stateDir : tempDir, "shared-session-store");
      const storePath = path.join(sessionDir, "sessions.json");
      const file = (name: string) => path.join(sessionDir, `${name}.jsonl`);
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      fs.mkdirSync(sessionDir, { recursive: true });
      const entries = Object.fromEntries(
        ["main", "work"].map((agentId, index) => {
          const sessionId = `${agentId}-session`;
          const sessionFile = `${sessionId}.jsonl`;
          writePrivateFile(file(sessionId), jsonl({ type: "session", sessionId }));
          return [`agent:${agentId}:main`, { sessionFile, sessionId, updatedAt: 20 + index * 10 }];
        }),
      );
      writeJson(storePath, entries, 2);
      if (allAgents) {
        writePrivateFile(file("orphan"), '{"type":"event","id":"orphan"}\n');
      }

      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, work: {} },
        },
        session: { store: storePath },
      };
      const report = await runDoctorSessionSqlite({
        ...(allAgents ? { allAgents: true } : { agent: "main" }),
        cfg,
        env,
        mode: "import",
      });

      const entry = (agentId: string) =>
        readEntry({ env, storePath, agentId, sessionKey: `agent:${agentId}:main` });
      expect(entry("main")?.entry.sessionId).toBe("main-session");
      if (!allAgents) {
        expect(report.totals).toMatchObject({
          archivedLegacyStoreFiles: 0,
          archivedTranscriptFiles: 0,
          importedEntries: 1,
          issues: 2,
        });
        expect(report.targets[0]?.issues).toMatchObject([
          { code: "transcript_archive_deferred", sessionKey: "agent:main:main" },
          { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
        ]);
        expectPresent(storePath, file("main-session"), file("work-session"));
        expect(entry("work")).toBeUndefined();
        return;
      }
      expect(report.targets.map((target) => target.agentId)).toEqual(["main", "work"]);
      expect(report.totals).toMatchObject({
        archivedLegacyStoreFiles: 1,
        archivedTranscriptFiles: 2,
        archivedUnreferencedJsonlFiles: 1,
        importedEntries: 2,
        importedTranscriptEvents: 2,
        issues: 0,
        sqliteEntries: 2,
      });
      expect(report.totals).toHaveProperty("reclaimedBytes");
      for (const target of readManifest(report.migrationRun?.manifestPath).targets) {
        expect(target.completedMoves.some((move) => move.kind === "legacy-store")).toBe(true);
      }
      expect(entry("work")?.entry.sessionId).toBe("work-session");
      expectMissing(file("main-session"), file("work-session"), file("orphan"));
      closeDatabases();
      const preview = inspectSessionSqliteRecovery({ cfg, env });
      const cleanup = await retireSessionSqliteRecovery({
        env,
        preview,
        readConfig: async () => cfg,
        confirm: async () => true,
      });
      expect(cleanup.totals.removedFiles).toBe(internal ? 3 : 0);
      expect(cleanup.artifacts.filter((item) => item.outcome === "protected")).toHaveLength(
        internal ? 1 : 4,
      );
    },
  );

  it.each(["active", "corrupt"] as const)(
    "reports %s SQLite transcript scan outcomes",
    async (kind) => {
      const store = createLegacyStore();
      if (kind === "corrupt") {
        const sqlitePath = databasePath(store);
        fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
        writePrivateFile(sqlitePath, "not a sqlite database\n");
      } else {
        await importLegacyStore(store);
        writePrivateFile(store.transcriptPath, '{"type":"event","id":"heartbeat"}\n');
        await upsertEntry(sessionScope(store), {
          sessionFile: "session-1.jsonl",
          sessionId: "session-1",
          updatedAt: 3000,
        });
        for (const suffix of ["zeta", "alpha"]) {
          writePrivateFile(path.join(store.sessionDir, `${suffix}.jsonl`), '{"type":"event"}\n');
          await upsertEntry(
            { ...sessionScope(store), sessionKey: `agent:main:${suffix}` },
            {
              sessionId: `${suffix}-session`,
              skillsSnapshot: {
                prompt: "active-transcript-scan".repeat(16 * 1024),
                skills: [],
              },
              updatedAt: 3000,
            },
          );
        }
        const database = openOpenClawAgentDatabase({
          agentId: "main",
          env: store.env,
          path: databasePath(store),
        });
        const sql = sessionSqlFixture(database.db);
        for (const suffix of ["zeta", "alpha"]) {
          sql`UPDATE session_nodes SET entry_json = json_set(entry_json, '$.sessionFile', ${`${suffix}.jsonl`}) WHERE session_key = ${`agent:main:${suffix}`}`.run();
        }
        sql`UPDATE session_nodes SET entry_valid = 1`.run();
      }
      const report = await runStoreDoctor(store, "inspect");

      if (kind === "corrupt") {
        expect(report.totals.issues).toBe(2);
        expect(report.targets[0]?.issues.map((issue) => issue.code)).toEqual([
          "sqlite_corrupt",
          "sqlite_active_transcript_scan_failed",
        ]);
      } else {
        expect(report.targets[0]?.issues).toMatchObject([
          { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:alpha" },
          { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
          { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:zeta" },
        ]);
        expect(report.targets[0]?.issues[1]?.message).toContain("session-1.jsonl");
      }
    },
  );
});
