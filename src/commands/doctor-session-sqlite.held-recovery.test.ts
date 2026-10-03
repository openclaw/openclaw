import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
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
import { seedDeferredPluginSessionSource } from "./doctor-session-sqlite.deferred-plugin.test-support.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";

it.each(["missing", "reconstructed-held", "reconstructed-then-missing"] as const)(
  "preserves conflicting retained sources while deletion history is %s",
  async (history) => {
    await withOpenClawTestState({ label: `r16-recover-${history}` }, async (state) => {
      const { cfg, storePath } = await seedDeferredPluginSessionSource(state, "default");
      const imported = await runDoctorSessionSqlite({
        cfg,
        env: state.env,
        allAgents: true,
        mode: "import",
      });
      expect(imported.totals.importedEntries).toBe(2);
      const sqlitePath = imported.targets[0]?.sqlitePath;
      expect(sqlitePath).toBeTypeOf("string");
      if (!sqlitePath) {
        throw new Error("The initial import did not report its canonical database");
      }
      const transcript = path.join(path.dirname(storePath), "legacy-kept.jsonl");
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
            if (history === "reconstructed-then-missing") {
              database.db.exec("DROP TABLE agent_deletion_journal");
            }
          }
        },
        { env: state.env },
      );
      expect(readAgentDatabaseDeletionSnapshot(state.env)?.retainedDeletions).toMatchObject(
        history === "reconstructed-held"
          ? { status: "present", held: [{ agentId: "main", path: sqlitePath }] }
          : { status: "unavailable", cause: "missing" },
      );
      if (history !== "missing") {
        const allAgents = await runDoctorSessionSqlite({
          cfg,
          env: state.env,
          allAgents: true,
          mode: "import",
        });
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
    fs.mkdirSync(agentDir, { recursive: true });
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
      JSON.stringify({
        "agent:retained:kept": {
          sessionId: "legacy-kept",
          sessionFile: "legacy-kept.jsonl",
          updatedAt: 20,
        },
      }),
    );
    fs.writeFileSync(
      transcriptPath,
      [
        { type: "session", version: 3, id: "legacy-kept" },
        {
          type: "message",
          id: "kept-message",
          parentId: null,
          message: { role: "user", content: "keep" },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const before = new Map(
      [sqlitePath, storePath, transcriptPath].map((file) => [file, fs.readFileSync(file)]),
    );
    runOpenClawStateWriteTransaction(
      (stateDatabase) => {
        stateDatabase.db.exec("DROP TABLE agent_deletion_journal");
      },
      { env: state.env },
    );
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
