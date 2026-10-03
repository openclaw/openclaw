import fs from "node:fs";
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
  it.each([
    "destination",
    "shared-state",
    "intact",
    "malformed-own-paths",
    "malformed-sibling-paths",
  ] as const)("holds legacy sources with unavailable or deleted ownership: %s", async (history) => {
    const orphaned = history === "destination" || history === "shared-state";
    const agentId = orphaned ? "main" : "retired";
    const store = createLegacyStore({ agentDirName: agentId });
    const sqlitePath = resolveTargetSqlitePath({ agentId, storePath: store.storePath }, store.env);
    const originals = [store.storePath, store.transcriptPath].map((file) => fs.readFileSync(file));
    const walPath =
      history === "destination"
        ? `${sqlitePath}-wal`
        : path.join(store.stateDir, "state", "openclaw.sqlite-wal");
    const wal = Buffer.from("unverified orphaned WAL bytes");
    if (orphaned) {
      fs.mkdirSync(path.dirname(walPath), { recursive: true });
      fs.writeFileSync(walPath, wal);
    } else {
      beginAgentDeletionJournal(
        {
          agentId,
          operationId: "retained-legacy-only",
          agentDir: path.dirname(sqlitePath),
          workspaceDir: path.join(store.stateDir, "workspace-retired"),
          sessionsDir: store.sessionDir,
          deleteFiles: false,
        },
        { env: store.env },
      );
      runOpenClawStateWriteTransaction(
        (database) => {
          completeAgentDeletionJournalInDatabase(database, agentId, "retained-legacy-only");
          if (history === "malformed-own-paths") {
            database.db
              .prepare(
                "UPDATE agent_deletion_journal SET database_paths_json = ? WHERE agent_id = ?",
              )
              .run("{}", agentId);
          }
        },
        { env: store.env },
      );
      if (history === "malformed-sibling-paths") {
        seedUnreadableSiblingDeletion(store);
      }
    }
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { main: {} } },
      ...(orphaned ? { session: { store: store.storePath } } : {}),
    };
    const options = { cfg, env: store.env, mode: "import" as const };
    expect(fs.existsSync(sqlitePath)).toBe(false);
    const imported = runDoctorSessionSqlite({ ...options, allAgents: true });
    if (history === "shared-state") {
      await expect(imported).rejects.toThrow("is unavailable");
    } else {
      expect((await imported).targets).toEqual([]);
      expect([store.storePath, store.transcriptPath].map((file) => fs.readFileSync(file))).toEqual(
        originals,
      );
      expect(fs.existsSync(sqlitePath)).toBe(false);
      if (orphaned) {
        expect(() =>
          assertSessionStoreMigrationComplete({ cfg, env: store.env, operation: "doctor" }),
        ).toThrow("Legacy session store requires migration");
      }
      for (const selection of [{ agent: agentId }, { store: store.storePath }]) {
        const explicit = await runDoctorSessionSqlite({ ...options, ...selection });
        expect(explicit.totals.importedEntries).toBe(0);
        expect(explicit.targets.flatMap((target) => target.issues)).toContainEqual({
          code: "plugin_migration_source_retained",
          message: expect.stringContaining(
            `store held for agent ${agentId} database ${sqlitePath}`,
          ),
        });
        expect(
          [store.storePath, store.transcriptPath].map((file) => fs.readFileSync(file)),
        ).toEqual(originals);
        expect(fs.existsSync(sqlitePath)).toBe(false);
      }
    }
    expect([store.storePath, store.transcriptPath].map((file) => fs.readFileSync(file))).toEqual(
      originals,
    );
    expect(fs.existsSync(sqlitePath)).toBe(false);
    if (orphaned) {
      expect(fs.readFileSync(walPath)).toEqual(wal);
    }
  });

  it.each(["ordinary", "unreadable-sibling", "missing-transcript"] as const)(
    "imports explicit legacy entries with %s sources",
    async (kind) => {
      const missing = kind === "missing-transcript";
      const agentId = missing ? "main" : "codex-proof";
      const store = createLegacyStore({ agentDirName: agentId });
      if (kind === "unreadable-sibling") {
        seedUnreadableSiblingDeletion(store);
      }
      if (missing) {
        fs.rmSync(store.transcriptPath);
      }
      const report = await importLegacyStore(store);
      expect(report.targets[0]?.agentId).toBe(agentId);
      expect(report.totals).toMatchObject({
        importedEntries: 1,
        importedTranscriptEvents: missing ? 0 : 2,
        issues: missing ? 1 : 0,
        sqliteEntries: 1,
      });
      const scope = {
        agentId,
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        storePath: store.storePath,
      };
      const events = loadTranscriptEventsSync(scope);
      if (missing) {
        expect(report.targets[0]?.issues[0]).toMatchObject({
          code: "transcript_missing",
          sessionKey: scope.sessionKey,
        });
        expect(loadExactSessionEntry(scope)?.entry.sessionId).toBe("session-1");
        expect(events).toEqual([]);
      } else {
        expect(events).toHaveLength(2);
      }
    },
  );

  it("uses configured fixed-store ownership for an explicitly selected former global store", async () => {
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
        "agent:main:voice:opaque": { sessionId: "opaque-session", updatedAt: 40 },
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

    const agents = { ownership: "explicit" as const, entries: { main: {}, ops: {} } };
    const ignored = await runDoctorSessionSqlite({
      allAgents: true,
      cfg: { agents },
      env,
      mode: "dry-run",
    });
    expect(ignored.targets).toEqual([]);
    expect(fs.existsSync(storePath)).toBe(true);

    const cfg = { agents, session: { store: storePath } };
    const report = await runDoctorSessionSqlite({
      allAgents: true,
      cfg,
      env,
      mode: "import",
    });

    expect(report.targets.map((target) => target.agentId)).toEqual(["main", "ops"]);
    expect(report.totals).toMatchObject({
      archivedLegacyStoreFiles: 1,
      importedEntries: 3,
      importedTranscriptEvents: 2,
      legacyEntries: 3,
      sqliteEntries: 3,
    });
    for (const [agentId, sessionId] of [
      ["main", "main-会議"],
      ["ops", "ops-session"],
    ] as const) {
      const readScope = { agentId, env, storePath };
      expect(
        loadExactSessionEntry({
          ...readScope,
          sessionKey: `agent:${agentId}:main`,
        })?.entry.sessionId,
      ).toBe(sessionId);
      expect(
        loadExactSessionEntry({
          ...readScope,
          sessionKey: `agent:${agentId}:voice:opaque`,
        })?.entry.sessionId,
      ).toBe(agentId === "main" ? "opaque-session" : undefined);
    }
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "main-session.jsonl"))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, "ops-session.jsonl"))).toBe(false);
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
      if (allAgents) {
        fs.writeFileSync(orphanTranscriptPath, '{"type":"event","id":"orphan"}\n', { mode: 0o600 });
      }

      const report = await runDoctorSessionSqlite({
        ...(allAgents ? { allAgents: true } : { agent: "main" }),
        cfg: {
          agents: { list: [{ default: true, id: "main" }, { id: "work" }] },
          session: { store: storePath },
        },
        env,
        mode: "import",
      });

      const readScope = { env, storePath };
      expect(
        loadExactSessionEntry({ ...readScope, agentId: "main", sessionKey: "agent:main:main" })
          ?.entry.sessionId,
      ).toBe("main-session");
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
        for (const file of [storePath, mainTranscriptPath, workTranscriptPath]) {
          expect(fs.existsSync(file)).toBe(true);
        }
        expect(
          loadExactSessionEntry({ ...readScope, agentId: "work", sessionKey: "agent:work:main" }),
        ).toBeUndefined();
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
      for (const target of readMigrationManifest(report.migrationRun?.manifestPath).targets) {
        expect(target.completedMoves.some((move) => move.kind === "legacy-store")).toBe(true);
      }
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
    },
  );

  it.each(["active", "corrupt"] as const)(
    "reports %s SQLite transcript scan outcomes",
    async (kind) => {
      const store = createLegacyStore();
      if (kind === "corrupt") {
        const sqlitePath = path.join(
          store.stateDir,
          "agents",
          "main",
          "agent",
          "openclaw-agent.sqlite",
        );
        fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
        fs.writeFileSync(sqlitePath, "not a sqlite database\n", { mode: 0o600 });
      } else {
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
      }
      const report = await runDoctorSessionSqlite({
        env: store.env,
        mode: "inspect",
        store: store.storePath,
      });

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
