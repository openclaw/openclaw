import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadExactSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import { assertSessionStoreMigrationComplete } from "../config/sessions/startup-migration.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import {
  beginAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
} from "../state/agent-deletion-journal.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { inspectSessionSqliteRecovery } from "./doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "./doctor-session-sqlite-retirement.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import {
  importLegacyStore,
  readMigrationManifest,
  useDoctorSessionSqliteTestFixture,
  type TestStore,
} from "./doctor-session-sqlite.test-support.js";

const { autoCleanupTempDirs, createLegacyStore } = useDoctorSessionSqliteTestFixture();

function seedUnreadableSiblingDeletion(store: TestStore): void {
  const agentId = "malformed-sibling";
  const operationId = "retained-malformed-sibling";
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
      database.db
        .prepare("UPDATE agent_deletion_journal SET database_paths_json = ? WHERE agent_id = ?")
        .run("{}", agentId);
    },
    { env: store.env },
  );
}

describe("runDoctorSessionSqlite", () => {
  it.each(["destination", "shared-state"])(
    "holds a top-level legacy import with %s orphaned WAL history",
    async (location) => {
      const stateDir = fs.realpathSync.native(
        autoCleanupTempDirs.make("doctor-held-legacy-store-"),
      );
      const storePath = path.join(stateDir, "sessions", "sessions.json");
      const sqlitePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
      const walPath =
        location === "destination"
          ? `${sqlitePath}-wal`
          : path.join(stateDir, "state", "openclaw.sqlite-wal");
      const legacy = JSON.stringify({ "agent:main:main": { sessionId: "held", updatedAt: 1 } });
      const wal = Buffer.from("unverified orphaned WAL bytes");
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
      fs.mkdirSync(path.dirname(walPath), { recursive: true });
      fs.writeFileSync(storePath, legacy);
      fs.writeFileSync(walPath, wal);
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {} } },
      };
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

      const imported = runDoctorSessionSqlite({
        allAgents: true,
        cfg,
        env,
        mode: "import",
      });

      if (location === "shared-state") {
        await expect(imported).rejects.toThrow("is unavailable");
      } else {
        expect((await imported).targets).toEqual([]);
        expect(() =>
          assertSessionStoreMigrationComplete({ cfg, env, operation: "doctor" }),
        ).toThrow("Legacy session store requires migration");
        const agentStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
        fs.mkdirSync(path.dirname(agentStorePath), { recursive: true });
        fs.writeFileSync(agentStorePath, legacy);
        for (const selection of [{ agent: "main" }, { store: agentStorePath }]) {
          const explicit = await runDoctorSessionSqlite({
            ...selection,
            cfg,
            env,
            mode: "import",
          });
          expect(explicit.totals.importedEntries).toBe(0);
          expect(explicit.targets.flatMap((target) => target.issues)).toContainEqual({
            code: "plugin_migration_source_retained",
            message: expect.stringContaining(`store held for agent main database ${sqlitePath}`),
          });
          expect(fs.readFileSync(agentStorePath, "utf8")).toBe(legacy);
        }
      }
      expect(fs.readFileSync(storePath, "utf8")).toBe(legacy);
      expect(fs.readFileSync(walPath)).toEqual(wal);
      expect(fs.existsSync(sqlitePath)).toBe(false);
    },
  );

  it.each(["intact", "malformed-own-paths", "malformed-sibling-paths"] as const)(
    "holds deleted legacy files when the retained agent database is absent (journal: %s)",
    async (history) => {
      const store = createLegacyStore({ agentDirName: "retired" });
      const sqlitePath = resolveTargetSqlitePath(
        { agentId: "retired", storePath: store.storePath },
        store.env,
      );
      const before = [store.storePath, store.transcriptPath].map((file) => fs.readFileSync(file));
      beginAgentDeletionJournal(
        {
          agentId: "retired",
          operationId: "retained-legacy-only",
          agentDir: path.dirname(sqlitePath),
          workspaceDir: path.join(store.stateDir, "workspace-retired"),
          sessionsDir: store.sessionDir,
          deleteFiles: false,
        },
        { env: store.env },
      );
      runOpenClawStateWriteTransaction(
        (database) =>
          completeAgentDeletionJournalInDatabase(database, "retired", "retained-legacy-only"),
        { env: store.env },
      );
      if (history === "malformed-own-paths") {
        runOpenClawStateWriteTransaction(
          (database) => {
            database.db
              .prepare(
                "UPDATE agent_deletion_journal SET database_paths_json = ? WHERE agent_id = ?",
              )
              .run("{}", "retired");
          },
          { env: store.env },
        );
      } else if (history === "malformed-sibling-paths") {
        seedUnreadableSiblingDeletion(store);
      }
      expect(fs.existsSync(sqlitePath)).toBe(false);

      const report = await runDoctorSessionSqlite({
        allAgents: true,
        cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
        env: store.env,
        mode: "import",
      });

      expect(report.targets).toEqual([]);
      expect([store.storePath, store.transcriptPath].map((file) => fs.readFileSync(file))).toEqual(
        before,
      );
      expect(fs.existsSync(sqlitePath)).toBe(false);
      for (const selection of [{ agent: "retired" }, { store: store.storePath }]) {
        const explicit = await runDoctorSessionSqlite({
          ...selection,
          cfg: { agents: { ownership: "explicit", entries: { main: {} } } },
          env: store.env,
          mode: "import",
        });
        expect(explicit.totals.importedEntries).toBe(0);
        expect(explicit.targets.flatMap((target) => target.issues)).toContainEqual({
          code: "plugin_migration_source_retained",
          message: expect.stringContaining(`store held for agent retired database ${sqlitePath}`),
        });
        expect(
          [store.storePath, store.transcriptPath].map((file) => fs.readFileSync(file)),
        ).toEqual(before);
        expect(fs.existsSync(sqlitePath)).toBe(false);
      }
    },
  );

  it.each([false, true])(
    "imports explicit stores into the agent database owned by the path (unreadable sibling: %s)",
    async (unreadableSibling) => {
      const store = createLegacyStore({ agentDirName: "codex-proof" });
      if (unreadableSibling) {
        seedUnreadableSiblingDeletion(store);
      }

      const report = await importLegacyStore(store);

      expect(report.targets[0]?.agentId).toBe("codex-proof");
      expect(report.totals).toMatchObject({
        importedEntries: 1,
        importedTranscriptEvents: 2,
        issues: 0,
        sqliteEntries: 1,
      });
      expect(
        loadTranscriptEventsSync({
          agentId: "codex-proof",
          sessionId: "session-1",
          sessionKey: "agent:main:main",
          storePath: store.storePath,
        }),
      ).toHaveLength(2);
    },
  );

  it("imports legacy entries even when their transcript sidecar is missing", async () => {
    const store = createLegacyStore();
    fs.rmSync(store.transcriptPath);

    const report = await importLegacyStore(store);

    expect(report.totals).toMatchObject({
      importedEntries: 1,
      importedTranscriptEvents: 0,
      issues: 1,
      sqliteEntries: 1,
    });
    expect(report.targets[0]?.issues[0]).toMatchObject({
      code: "transcript_missing",
      sessionKey: "agent:main:main",
    });
    expect(
      loadExactSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      })?.entry.sessionId,
    ).toBe("session-1");
    expect(
      loadTranscriptEventsSync({
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      }),
    ).toEqual([]);
  });

  it("keeps a shared legacy store intact when importing only one agent", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
    try {
      const stateDir = path.join(tempDir, "state");
      const sessionDir = path.join(tempDir, "shared-session-store");
      const storePath = path.join(sessionDir, "sessions.json");
      const mainTranscriptPath = path.join(sessionDir, "main-session.jsonl");
      const workTranscriptPath = path.join(sessionDir, "work-session.jsonl");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": {
            sessionFile: "main-session.jsonl",
            sessionId: "main-session",
            updatedAt: 20,
          },
          "agent:work:main": {
            sessionFile: "work-session.jsonl",
            sessionId: "work-session",
            updatedAt: 30,
          },
        }),
        { mode: 0o600 },
      );
      fs.writeFileSync(mainTranscriptPath, '{"type":"session","sessionId":"main-session"}\n');
      fs.writeFileSync(workTranscriptPath, '{"type":"session","sessionId":"work-session"}\n');

      const report = await runDoctorSessionSqlite({
        agent: "main",
        cfg: {
          agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
          session: { store: storePath },
        },
        env,
        mode: "import",
      });

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
      expect(fs.existsSync(storePath)).toBe(true);
      expect(fs.existsSync(mainTranscriptPath)).toBe(true);
      expect(fs.existsSync(workTranscriptPath)).toBe(true);
      const readScope = { env, storePath };
      expect(
        loadExactSessionEntry({
          ...readScope,
          agentId: "main",
          sessionKey: "agent:main:main",
        })?.entry.sessionId,
      ).toBe("main-session");
      expect(
        loadExactSessionEntry({
          ...readScope,
          agentId: "work",
          sessionKey: "agent:work:main",
        }),
      ).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("partitions the retired top-level store without guessing unscoped ownership", async () => {
    const stateDir = autoCleanupTempDirs.make("openclaw-doctor-retired-sessions-");
    const sessionDir = path.join(stateDir, "sessions");
    const storePath = path.join(sessionDir, "sessions.json");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionFile: "/retired/home/.openclaw/sessions/main-session.jsonl",
          sessionId: "main-会議",
          updatedAt: 20,
        },
        "agent:ops:main": {
          sessionFile: "ops-session.jsonl",
          sessionId: "ops-session",
          updatedAt: 30,
        },
        "voice:ambiguous": { sessionId: "ambiguous-session", updatedAt: 40 },
      }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(sessionDir, "main-session.jsonl"),
      '{"type":"session","sessionId":"main-会議"}\n',
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(sessionDir, "ops-session.jsonl"),
      '{"type":"session","sessionId":"ops-session"}\n',
      { mode: 0o600 },
    );

    const cfg = {
      agents: { ownership: "explicit" as const, entries: { main: {}, ops: {} } },
    };
    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });

    expect(report.targets.map((target) => target.agentId)).toEqual(["main", "ops"]);
    expect(report.totals).toMatchObject({
      archivedLegacyStoreFiles: 0,
      importedEntries: 2,
      importedTranscriptEvents: 2,
      legacyEntries: 2,
      sqliteEntries: 2,
    });
    for (const [agentId, sessionId] of [
      ["main", "main-会議"],
      ["ops", "ops-session"],
    ] as const) {
      const agentStorePath = path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
      const readScope = { agentId, env, storePath: agentStorePath };
      expect(
        loadExactSessionEntry({
          ...readScope,
          sessionKey: `agent:${agentId}:main`,
        })?.entry.sessionId,
      ).toBe(sessionId);
      expect(
        loadExactSessionEntry({
          ...readScope,
          sessionKey: "voice:ambiguous",
        }),
      ).toBeUndefined();
    }
    expect(fs.existsSync(storePath)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "main-session.jsonl"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "ops-session.jsonl"))).toBe(true);

    const owned = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: {
        ...cfg,
        agents: { ...cfg.agents, defaults: { sessionStore: { agentId: "main" } } },
      },
      env,
      mode: "import",
    });
    expect(owned.totals.archivedLegacyStoreFiles).toBe(1);
    expect(owned.totals.importedEntries).toBe(3);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it.each([true, false])(
    "imports shared custom stores and respects cleanup ownership (internal=%s)",
    async (internal) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-session-sqlite-"));
      try {
        const stateDir = path.join(tempDir, "state");
        const sessionDir = path.join(internal ? stateDir : tempDir, "shared-session-store");
        const storePath = path.join(sessionDir, "sessions.json");
        const mainTranscriptPath = path.join(sessionDir, "main-session.jsonl");
        const workTranscriptPath = path.join(sessionDir, "work-session.jsonl");
        const orphanTranscriptPath = path.join(sessionDir, "orphan.jsonl");
        const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        fs.mkdirSync(sessionDir, { recursive: true });
        fs.writeFileSync(
          storePath,
          JSON.stringify(
            {
              "agent:main:main": {
                sessionFile: "main-session.jsonl",
                sessionId: "main-session",
                updatedAt: 20,
              },
              "agent:work:main": {
                sessionFile: "work-session.jsonl",
                sessionId: "work-session",
                updatedAt: 30,
              },
            },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        fs.writeFileSync(mainTranscriptPath, '{"type":"session","sessionId":"main-session"}\n', {
          mode: 0o600,
        });
        fs.writeFileSync(workTranscriptPath, '{"type":"session","sessionId":"work-session"}\n', {
          mode: 0o600,
        });
        fs.writeFileSync(orphanTranscriptPath, '{"type":"event","id":"orphan"}\n', { mode: 0o600 });

        const report = await runDoctorSessionSqlite({
          allAgents: true,
          cfg: {
            agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
            session: { store: storePath },
          },
          env,
          mode: "import",
        });

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
        for (const target of readMigrationManifest(report.migrationRun?.manifestPath).targets) {
          expect(target.completedMoves.some((move) => move.kind === "legacy-store")).toBe(true);
        }
        const readScope = { env, storePath };
        expect(
          loadExactSessionEntry({
            ...readScope,
            agentId: "main",
            sessionKey: "agent:main:main",
          })?.entry.sessionId,
        ).toBe("main-session");
        expect(
          loadExactSessionEntry({
            ...readScope,
            agentId: "work",
            sessionKey: "agent:work:main",
          })?.entry.sessionId,
        ).toBe("work-session");
        expect(fs.existsSync(mainTranscriptPath)).toBe(false);
        expect(fs.existsSync(workTranscriptPath)).toBe(false);
        expect(fs.existsSync(orphanTranscriptPath)).toBe(false);
        closeOpenClawAgentDatabasesForTest();
        const cfg = { agents: { entries: { main: {}, work: {} } }, session: { store: storePath } };
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
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("reports active JSONL files left beside SQLite-backed sessions", async () => {
    const store = createLegacyStore();

    await importLegacyStore(store);
    fs.writeFileSync(store.transcriptPath, '{"type":"event","id":"heartbeat"}\n', {
      mode: 0o600,
    });
    await upsertSessionEntryCore(
      {
        agentId: "main",
        env: store.env,
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      },
      {
        sessionFile: "session-1.jsonl",
        sessionId: "session-1",
        updatedAt: 3000,
      },
    );
    for (const suffix of ["zeta", "alpha"]) {
      fs.writeFileSync(path.join(store.sessionDir, `${suffix}.jsonl`), '{"type":"event"}\n', {
        mode: 0o600,
      });
      await upsertSessionEntryCore(
        {
          agentId: "main",
          env: store.env,
          sessionKey: `agent:main:${suffix}`,
          storePath: store.storePath,
        },
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
      path: resolveTargetSqlitePath({ agentId: "main", storePath: store.storePath }),
    });
    for (const suffix of ["zeta", "alpha"]) {
      database.db
        .prepare(
          "UPDATE session_nodes SET entry_json = json_set(entry_json, '$.sessionFile', ?) WHERE session_key = ?",
        )
        .run(`${suffix}.jsonl`, `agent:main:${suffix}`);
    }
    database.db.prepare("UPDATE session_nodes SET entry_valid = 1").run();

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.targets[0]?.issues).toMatchObject([
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:alpha" },
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:main" },
      { code: "active_sqlite_transcript_jsonl", sessionKey: "agent:main:zeta" },
    ]);
    expect(report.targets[0]?.issues[1]?.message).toContain("session-1.jsonl");
  });

  it("reports active JSONL scan failures without aborting inspect", async () => {
    const store = createLegacyStore();
    const sqlitePath = path.join(
      store.stateDir,
      "agents",
      "main",
      "agent",
      "openclaw-agent.sqlite",
    );
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
    fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });

    const report = await runDoctorSessionSqlite({
      env: store.env,
      mode: "inspect",
      store: store.storePath,
    });

    expect(report.totals.issues).toBe(2);
    expect(report.targets[0]?.issues.map((issue) => issue.code)).toEqual([
      "sqlite_corrupt",
      "sqlite_active_transcript_scan_failed",
    ]);
  });
});
