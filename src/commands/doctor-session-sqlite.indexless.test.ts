import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import { loadTranscriptEventsSync } from "../config/sessions/session-accessor.sqlite-read.js";
import * as sessionTargets from "../config/sessions/targets.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import { resolveTargetSqlitePath } from "../infra/session-sqlite-migration-readers.js";
import { reconstructAgentDeletionJournal } from "../state/agent-deletion-journal-recovery.js";
import { readAgentDatabaseDeletionSnapshot } from "../state/agent-deletion-journal.read.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { countBlockingSessionSqliteIssues } from "./doctor-session-sqlite-types.js";
import {
  jsonl,
  messageEvent,
  seedRetainedSource,
  migrationManifest,
} from "./doctor-session-sqlite.fixtures.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { expectMissing } from "./doctor-session-sqlite.publication-spies.test-support.js";
import { writeState } from "./doctor-session-sqlite.test-support.js";

it("receipts indexless configured history and archives retired history while a plugin is pending", async () => {
  await withOpenClawTestState({ label: "indexless-deferred-fleet" }, async (state) => {
    const f = await seedRetainedSource(state, "default", "codex");
    const { cfg, storePath } = f;
    cfg.agents = { entries: { main: {}, active: {} } };
    const originalIndex = fs.readFileSync(storePath);
    const sources = new Map<string, string>();
    for (const agentId of ["active", "retired", "trajectory-only"]) {
      const directory = state.sessionsDir(agentId);
      fs.mkdirSync(directory, { recursive: true });
      const bytes = jsonl(
        { type: "session", version: 3, id: `${agentId}-history` },
        messageEvent(`${agentId}-message`, "user", `Preserve ${agentId} history`),
      );
      const source = path.join(
        directory,
        `${agentId}-history${agentId === "trajectory-only" ? ".trajectory" : ""}.jsonl`,
      );
      fs.writeFileSync(source, bytes);
      sources.set(source, bytes);
    }
    const discovery = vi.spyOn(sessionTargets, "resolveAllAgentSessionStoreCandidateTargetsSync");
    let report;
    try {
      report = await f.run();
      expect(discovery).toHaveBeenCalledTimes(1);
    } finally {
      discovery.mockRestore();
    }
    expect(report.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0)).toBe(
      true,
    );
    expect(fs.readFileSync(storePath)).toEqual(originalIndex);
    const active = report.targets.find((target) => target.agentId === "active")!;
    expect(active.issues).toContainEqual(
      expect.objectContaining({ code: "retained_plugin_source_index_rebuilt" }),
    );
    const receipt = f.readReceipt(active);
    expect(receipt?.sources.map((source) => source.path)).toEqual([
      path.join(state.sessionsDir("active"), "active-history.jsonl"),
    ]);
    expect(fs.existsSync(active.storePath)).toBe(false);
    const activeScope = {
      agentId: "active",
      env: state.env,
      storePath: active.storePath,
      sessionId: "active-history",
      sessionKey: "agent:active:recovered:active-history",
    };
    expect(loadExactSessionEntry(activeScope)?.entry.sessionId).toBe("active-history");
    const events = loadTranscriptEventsSync(activeScope);
    expect(events).toHaveLength(2);
    const manifest = migrationManifest(report);
    for (const agentId of ["retired", "trajectory-only"]) {
      const target = manifest.targets.find((candidate) => candidate.agentId === agentId)!;
      expect(target.completedMoves).toHaveLength(1);
      const move = target.completedMoves[0]!;
      expect(move.artifact).toMatchObject({
        classification: "protected",
        disposal: { state: "retained" },
      });
      expect(fs.existsSync(move.sourcePath)).toBe(false);
      expect(fs.readFileSync(move.archivePath, "utf8")).toBe(sources.get(move.sourcePath));
      expect(fs.existsSync(target.storePath)).toBe(false);
    }
    const trajectoryStore = path.join(state.sessionsDir("trajectory-only"), "sessions.json");
    expectMissing(
      resolveTargetSqlitePath(
        { agentId: "trajectory-only", storePath: trajectoryStore },
        state.env,
      ),
    );
    expect(f.assertReady).not.toThrow();
    const newIndex = JSON.stringify({
      "agent:active:unimported": { sessionId: "unimported", updatedAt: 999 },
    });
    fs.writeFileSync(active.storePath, newIndex);
    const retried = await f.run();
    expect(retried.totals.importedEntries).toBe(0);
    expect(
      loadExactSessionEntry({ ...activeScope, sessionKey: "agent:active:unimported" }),
    ).toBeUndefined();
    const conflictingIndex = migrationManifest(retried)
      .targets.find((target) => target.agentId === "active")!
      .completedMoves.find((move) => move.kind === "legacy-store")!;
    expect(conflictingIndex.artifact?.classification).toBe("protected");
    expect(fs.readFileSync(conflictingIndex.archivePath, "utf8")).toBe(newIndex);
    expect(loadTranscriptEventsSync(activeScope)).toEqual(events);
    await recordDeferredPluginMigrations({
      env: state.env,
      pending: [],
      resolvedPluginIds: ["codex"],
    });
    const settled = await f.run();
    const activeArchive = settled.targets.find(
      (target) => target.agentId === "active",
    )!.archivedTranscriptFiles;
    expect(activeArchive).toHaveLength(1);
    expect(fs.readFileSync(activeArchive[0]!, "utf8")).toBe(
      sources.get(path.join(state.sessionsDir("active"), "active-history.jsonl")),
    );
    expect(loadTranscriptEventsSync(activeScope)).toEqual(events);
    expect(fs.existsSync(storePath)).toBe(false);
  });
});

it.each(["missing", "reconstructed-then-missing"] as const)(
  "preserves conflicting retained sources while deletion history is %s",
  async (history) => {
    await withOpenClawTestState({ label: `r16-recover-${history}` }, async (state) => {
      const f = await seedRetainedSource(state);
      const { cfg, storePath } = f;
      const imported = await f.run();
      expect(imported.totals.importedEntries).toBe(2);
      const sqlitePath = imported.targets[0]?.sqlitePath;
      expect(sqlitePath).toBeTypeOf("string");
      if (!sqlitePath) {
        throw new Error("The initial import did not report its canonical database");
      }
      const transcript = f.file("legacy-kept.jsonl");
      const changed = fs
        .readFileSync(transcript, "utf8")
        .replace('"content":"kept"', '"content":"conflict-after-hold"');
      fs.writeFileSync(transcript, changed);
      const indexBefore = fs.readFileSync(storePath);
      await closeOpenClawAgentDatabasesAsync();
      runOpenClawStateWriteTransaction(
        (database) => {
          database.db.exec("DROP TABLE agent_deletion_journal");
          if (history !== "missing") {
            reconstructAgentDeletionJournal(database, [{ agentId: "main", path: sqlitePath }]);
            database.db.exec("DROP TABLE agent_deletion_journal");
          }
        },
        { env: state.env },
      );
      expect(readAgentDatabaseDeletionSnapshot(state.env)?.retainedDeletions).toMatchObject({
        status: "unavailable",
        cause: "missing",
      });
      if (history !== "missing") {
        const allAgents = await f.run();
        expect(allAgents.targets).toEqual([]);
        expect(fs.readFileSync(transcript, "utf8")).toBe(changed);
        expect(fs.readFileSync(storePath)).toEqual(indexBefore);
      }
      for (const mode of ["recover", "import"] as const) {
        const recovered = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          agent: "main",
          mode,
        });
        expect(recovered.targets.flatMap((target) => target.issues)).toContainEqual({
          code: "plugin_migration_source_retained",
          message: expect.stringContaining(`store held for agent main database ${sqlitePath}`),
        });
        expect(recovered.targets.flatMap((target) => target.issues)).toContainEqual({
          code: "plugin_migration_source_retained",
          message: expect.stringContaining("openclaw doctor --fix"),
        });
        expect(
          recovered.targets.every((target) => countBlockingSessionSqliteIssues(target) === 0),
        ).toBe(true);
        expect(fs.existsSync(transcript)).toBe(true);
        expect(fs.readFileSync(transcript, "utf8")).toBe(changed);
        expect(fs.readFileSync(storePath)).toEqual(indexBefore);
        expect(recovered.targets.flatMap((target) => target.archivedTranscriptFiles)).toEqual([]);
      }
    });
  },
);

it("holds an existing unconfigured database before importing legacy sessions with unknown history", async () => {
  await withOpenClawTestState({ label: "existing-database-unknown-history" }, async (state) => {
    openOpenClawStateDatabase({ env: state.env });
    const sessionsDir = state.sessionsDir("retained");
    const agentDir = state.agentDir("retained");
    fs.mkdirSync(sessionsDir, { recursive: true });
    const sqlitePath = path.join(agentDir, "openclaw-agent.sqlite");
    const database = openOpenClawAgentDatabase({
      agentId: "retained",
      path: sqlitePath,
      env: state.env,
    });
    database.db.exec(
      "CREATE TABLE retained_content (value TEXT); INSERT INTO retained_content VALUES ('keep');",
    );
    await closeOpenClawAgentDatabasesAsync();
    const storePath = path.join(sessionsDir, "sessions.json");
    const transcriptPath = path.join(sessionsDir, "legacy-kept.jsonl");
    fs.writeFileSync(
      storePath,
      '{"agent:retained:kept":{"sessionId":"legacy-kept","sessionFile":"legacy-kept.jsonl","updatedAt":20}}',
    );
    fs.writeFileSync(
      transcriptPath,
      jsonl(
        { type: "session", version: 3, id: "legacy-kept" },
        messageEvent("kept-message", "user", "keep"),
      ),
    );
    const before = new Map(
      [sqlitePath, storePath, transcriptPath].map((file) => [file, fs.readFileSync(file)]),
    );
    writeState(state.env, ["DROP TABLE agent_deletion_journal"]);
    const report = await runDoctorSessionSqlite({
      cfg: { agents: { entries: { main: {} } } },
      env: state.env,
      agent: "retained",
      mode: "import",
    });
    expect(report.targets.flatMap((target) => target.issues)).toContainEqual({
      code: "plugin_migration_source_retained",
      message: expect.stringContaining("store held for agent retained database " + sqlitePath),
    });
    expect(report.totals.importedEntries).toBe(0);
    expect(report.targets.flatMap((target) => target.archivedTranscriptFiles)).toEqual([]);
    for (const [file, bytes] of before) {
      expect(fs.readFileSync(file)).toEqual(bytes);
    }
  });
});
