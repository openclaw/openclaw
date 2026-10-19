import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  reconstructAgentDeletionJournal,
  recordAgentDeletionRecoveryHolds,
  resolveAgentDeletionRecoveryHolds,
} from "./agent-deletion-journal-recovery.js";
import {
  AGENT_DELETION_RECOVERY_SOURCE_KEY,
  AGENT_DELETION_RECONSTRUCTION_DESCRIPTION,
  readAgentDeletionMissingJournalHolds,
  readAgentDeletionRecoveryHolds,
  readReport,
  type RecoveryDatabase,
} from "./agent-deletion-journal-recovery.kernel.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const root = tempDirs.make("deletion-journal-provenance-");
  const database = {
    db: new DatabaseSync(":memory:"),
    path: path.join(root, "state", "openclaw.sqlite"),
  } satisfies RecoveryDatabase;
  database.db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  const target = (agentId: string) => ({
    agentId,
    path: path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite"),
  });
  return { database, target };
}

function transaction<T>(database: RecoveryDatabase, operation: () => T): T {
  database.db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.db.exec("COMMIT");
    return result;
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
}

function replaceReport(database: RecoveryDatabase, report: unknown) {
  database.db
    .prepare("UPDATE migration_sources SET report_json = ? WHERE source_key = ?")
    .run(JSON.stringify(report), AGENT_DELETION_RECOVERY_SOURCE_KEY);
}

it("records table absence only for reconstructed inventory and revokes quarantine targets", () => {
  const { database, target } = fixture();
  using db = database.db;
  const main = target("main");
  const other = target("other");
  db.exec("DROP TABLE agent_deletion_journal");
  transaction(database, () => reconstructAgentDeletionJournal(database, [main]));
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual([main]);

  transaction(database, () => reconstructAgentDeletionJournal(database, [other]));
  expect(readAgentDeletionRecoveryHolds(database)).toEqual([main]);
  transaction(database, () =>
    recordAgentDeletionRecoveryHolds(database, [other], {
      description:
        "Quarantined unusable agent deletion records; stores remain held for explicit recovery.",
    }),
  );
  expect(readAgentDeletionRecoveryHolds(database)).toEqual([main, other]);
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual([main]);

  transaction(database, () =>
    recordAgentDeletionRecoveryHolds(database, [main], { excludeMissingJournal: [main] }),
  );
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual([]);
});

it.each(["reconstruction", "quarantine"])(
  "%s never creates reserved holds and preserves legacy holds for verified Doctor recovery",
  (source) => {
    const { database, target } = fixture();
    using db = database.db;
    const main = target("main");
    const reserved = [target("openclaw"), target("crestodian")];
    if (source === "reconstruction") {
      db.exec("DROP TABLE agent_deletion_journal");
      transaction(database, () => reconstructAgentDeletionJournal(database, [main, ...reserved]));
    } else {
      transaction(database, () => recordAgentDeletionRecoveryHolds(database, [main, ...reserved]));
    }
    expect(readAgentDeletionRecoveryHolds(database)).toEqual([main]);
    expect(readAgentDeletionMissingJournalHolds(database)).toEqual(
      source === "reconstruction" ? [main] : [],
    );
    // Legacy persisted format predates reserved-agent exclusion.
    const report = readReport(database)!;
    replaceReport(database, { ...report, held: [...report.held, ...reserved] });
    transaction(database, () => recordAgentDeletionRecoveryHolds(database, reserved));
    expect(readAgentDeletionRecoveryHolds(database)).toEqual([main, ...reserved]);
  },
);

it("does not reclassify an existing quarantine hold when the journal is later lost", () => {
  const { database, target } = fixture();
  using db = database.db;
  const main = target("main");
  const other = target("other");
  transaction(database, () => recordAgentDeletionRecoveryHolds(database, [main]));
  db.exec("DROP TABLE agent_deletion_journal");
  transaction(database, () => reconstructAgentDeletionJournal(database, [main, other]));
  expect(readAgentDeletionRecoveryHolds(database)).toEqual([main, other]);
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual([other]);
});

it.each([
  { description: AGENT_DELETION_RECONSTRUCTION_DESCRIPTION, missing: true },
  {
    description:
      "Quarantined unusable agent deletion records; stores remain held for explicit recovery.",
    missing: false,
  },
  {
    description:
      "Preserved unusable agent deletion records in place; stores remain held for explicit recovery.",
    missing: false,
  },
])(
  "reads legacy missing-table provenance only from its exact description: $missing",
  ({ description, missing }) => {
    const { database, target } = fixture();
    using db = database.db;
    const main = target("main");
    transaction(database, () => recordAgentDeletionRecoveryHolds(database, [main]));
    const report = readReport({ db, path: database.path })!;
    delete report.missingJournal;
    replaceReport(database, { ...report, description });
    expect(readAgentDeletionMissingJournalHolds(database)).toEqual(missing ? [main] : []);
  },
);

it("resolves only selected provenance, preserves extra metadata and leaves immutable runs intact", () => {
  const { database, target } = fixture();
  using db = database.db;
  const main = target("main");
  const other = target("other");
  db.exec("DROP TABLE agent_deletion_journal");
  transaction(database, () => reconstructAgentDeletionJournal(database, [main, other]));
  const originalRuns = db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
  replaceReport(database, { ...readReport(database), backup: { path: "verified-backup" } });
  transaction(database, () => resolveAgentDeletionRecoveryHolds(database, "main", [main.path]));
  expect(readAgentDeletionRecoveryHolds(database)).toEqual([other]);
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual([other]);
  expect(readReport(database)?.backup).toEqual({ path: "verified-backup" });
  transaction(database, () => resolveAgentDeletionRecoveryHolds(database, "other", [other.path]));
  expect(readReport(database)?.missingJournal).toEqual([]);
  expect(readAgentDeletionMissingJournalHolds(database)).toEqual([]);
  expect(db.prepare("SELECT * FROM migration_runs ORDER BY id").all()).toEqual(originalRuns);
});

it("rejects malformed or unheld missing-table provenance", () => {
  const { database, target } = fixture();
  using db = database.db;
  transaction(database, () => recordAgentDeletionRecoveryHolds(database, [target("main")]));
  const report = readReport({ db, path: database.path })!;
  replaceReport(database, { ...report, missingJournal: "main" });
  expect(() => readAgentDeletionMissingJournalHolds(database)).toThrow(
    "Invalid missing-journal provenance",
  );
  replaceReport(database, { ...report, missingJournal: [target("other")] });
  expect(() => readAgentDeletionMissingJournalHolds(database)).toThrow("unheld agent database");
});
