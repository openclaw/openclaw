import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { installSqliteFtsTokenizerMismatch } from "../infra/sqlite-index-corruption.test-support.js";
import { migrateLegacyMediaPersistence } from "../infra/state-migrations.media-persistence.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "../state/openclaw-agent-db-lease.js";
import * as agentDb from "../state/openclaw-agent-db.js";
import {
  readPersistedQuarantineRow,
  seedOpenClawDatabaseQuarantine,
} from "../state/openclaw-quarantine-store.test-support.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { runDoctorSessionSqlite } from "./doctor-session-sqlite.js";
import { useDoctorSessionSqliteTestFixture } from "./doctor-session-sqlite.test-support.js";

const { createImportedStoreForCompaction } = useDoctorSessionSqliteTestFixture();

it.each(["fix", "recover"])(
  "Doctor %s repairs FTS-only quarantine in place, preserving sessions and external content",
  async (mode) => {
    const { sqlitePath, store } = await createImportedStoreForCompaction();
    await agentDb.closeOpenClawAgentDatabasesAsync();
    invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(sqlitePath);
    let transcriptRows: unknown[];
    {
      using db = new DatabaseSync(sqlitePath);
      db.exec("INSERT INTO session_transcript_fts(text) VALUES ('ab'||char(65534)||'cd')");
      db.exec(`INSERT INTO standing_intents
      (id, description, trigger_keywords, status, expires_at, max_fires, created_at)
      VALUES ('fts-test', 'preserve', 'ab'||char(65534)||'cd', 'armed', 100, 1, 1)`);
      transcriptRows = db.prepare("SELECT * FROM transcript_events").all();
    }
    installSqliteFtsTokenizerMismatch(sqlitePath, "session_transcript_fts");
    installSqliteFtsTokenizerMismatch(sqlitePath, "standing_intents_fts");
    const open = () => agentDb.openOpenClawAgentDatabase({ agentId: "main", env: store.env });
    // Physical FTS corruption belongs to explicit verification, not runtime admission.
    const maintenance = createOpenClawDatabaseMaintenanceScope({ sqliteIntegrityCheck: "full" });
    expect(() => maintenance.run(open)).toThrow(/openclaw doctor --fix/);
    await maintenance.close();
    // Released builds persisted this refusal; the current opener also latches it in memory.
    seedOpenClawDatabaseQuarantine({
      env: store.env,
      kind: "agent",
      path: sqlitePath,
      reason: "malformed inverted index for FTS5 table main.session_transcript_fts",
    });
    expect(readPersistedQuarantineRow(sqlitePath, { env: store.env })).toBeDefined();
    if (mode === "recover") {
      const report = await runDoctorSessionSqlite({ env: store.env, store: store.storePath, mode });
      expect(report.totals.issues).toBe(0);
      expect(report.targets[0]?.corruptRecovery).toBeUndefined();
    } else {
      const report = await migrateLegacyMediaPersistence({ env: store.env });
      expect(report.warnings).toEqual([]);
      expect(
        report.changes.some((line) => line.includes("Rebuilt corrupt agent main SQLite indexes")),
      ).toBe(true);
    }
    expect(
      fs.readdirSync(path.dirname(sqlitePath)).some((name) => name.includes(".corrupt-")),
    ).toBe(false);
    expect(readPersistedQuarantineRow(sqlitePath, { env: store.env })).toBeUndefined();
    using db = new DatabaseSync(sqlitePath);
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.prepare("SELECT * FROM transcript_events").all()).toEqual(transcriptRows);
    expect(db.prepare("SELECT trigger_keywords FROM standing_intents").all()).toEqual([
      { trigger_keywords: "ab\ufffecd" },
    ]);
    expect(
      db.prepare("SELECT text FROM session_transcript_fts WHERE text=?").all("ab\ufffecd"),
    ).toEqual([{ text: "ab\ufffecd" }]);
    expect(open().db.isOpen).toBe(true);
  },
);
