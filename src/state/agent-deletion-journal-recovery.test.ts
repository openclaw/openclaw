import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import {
  reconstructAgentDeletionJournal as reconstruct,
  recordAgentDeletionRecoveryHolds as record,
  resolveAgentDeletionRecoveryHolds as resolve,
} from "./agent-deletion-journal-recovery.js";
import {
  AGENT_DELETION_RECOVERY_SOURCE_KEY as SOURCE_KEY,
  AGENT_DELETION_RECONSTRUCTION_DESCRIPTION as RECONSTRUCTION,
  readAgentDeletionMissingJournalHolds as missingHolds,
  readAgentDeletionRecoveryHolds as holds,
  readReport,
  type RecoveryDatabase,
} from "./agent-deletion-journal-recovery.kernel.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let database: RecoveryDatabase;
let root: string;
const target = (agentId: string) => ({
  agentId,
  path: path.join(root, "agents", agentId, "agent", "openclaw-agent.sqlite"),
});
let main: ReturnType<typeof target>;
let other: ReturnType<typeof target>;
beforeEach(() => {
  root = tempDirs.make("deletion-journal-provenance-");
  database = {
    db: new DatabaseSync(":memory:"),
    path: path.join(root, "state", "openclaw.sqlite"),
  };
  database.db.exec(OPENCLAW_STATE_SCHEMA_SQL);
  [main, other] = [target("main"), target("other")];
});
afterEach(() => database.db.close());

const transaction = (operation: () => unknown) =>
  runSqliteImmediateTransactionSync(database.db, operation);

function updateReport(patch: Record<string, unknown>, report = readReport(database)) {
  database.db
    .prepare("UPDATE migration_sources SET report_json = ? WHERE source_key = ?")
    .run(JSON.stringify({ ...report, ...patch }), SOURCE_KEY);
}
function expectHolds(held: ReturnType<typeof holds>, missing = held) {
  expect(holds(database)).toEqual(held);
  expect(missingHolds(database)).toEqual(missing);
}

it("records and revokes missing-journal provenance", () => {
  database.db.exec("DROP TABLE agent_deletion_journal");
  transaction(() => reconstruct(database, [main]));
  expect(missingHolds(database)).toEqual([main]);
  transaction(() => reconstruct(database, [other]));
  expect(holds(database)).toEqual([main]);
  transaction(() => record(database, [other], { description: quarantineDescription }));
  expectHolds([main, other], [main]);
  transaction(() => record(database, [main], { excludeMissingJournal: [main] }));
  expect(missingHolds(database)).toEqual([]);
});

it.each([true, false])("retains only legacy reserved holds (reconstruct: %s)", (reconstruction) => {
  const reserved = [target("openclaw"), target("crestodian")];
  if (reconstruction) {
    database.db.exec("DROP TABLE agent_deletion_journal");
    transaction(() => reconstruct(database, [main, ...reserved]));
  } else {
    transaction(() => record(database, [main, ...reserved]));
  }
  expectHolds([main], reconstruction ? [main] : []);
  // Legacy persisted format predates reserved-agent exclusion.
  updateReport({ held: [...readReport(database)!.held, ...reserved] });
  transaction(() => record(database, reserved));
  expect(holds(database)).toEqual([main, ...reserved]);
});

it("does not upgrade quarantine provenance after journal loss", () => {
  transaction(() => record(database, [main]));
  database.db.exec("DROP TABLE agent_deletion_journal");
  transaction(() => reconstruct(database, [main, other]));
  expectHolds([main, other], [other]);
});

const quarantineDescription =
  "Quarantined unusable agent deletion records; stores remain held for explicit recovery.";
it.each([
  [RECONSTRUCTION, true],
  [quarantineDescription, false],
] as const)("recognizes legacy reconstruction: %s", (description, missing) => {
  transaction(() => record(database, [main]));
  updateReport({ missingJournal: undefined, description });
  expect(missingHolds(database)).toEqual(missing ? [main] : []);
});

it("resolves selected holds without changing metadata or immutable runs", () => {
  database.db.exec("DROP TABLE agent_deletion_journal");
  transaction(() => reconstruct(database, [main, other]));
  const runs = () => database.db.prepare("SELECT * FROM migration_runs ORDER BY id").all();
  const originalRuns = runs();
  updateReport({ backup: { path: "verified-backup" } });
  transaction(() => resolve(database, "main", [main.path]));
  expectHolds([other]);
  expect(readReport(database)?.backup).toEqual({ path: "verified-backup" });
  transaction(() => resolve(database, "other", [other.path]));
  expect(readReport(database)?.missingJournal).toEqual([]);
  expect(missingHolds(database)).toEqual([]);
  expect(runs()).toEqual(originalRuns);
});

it("rejects malformed or unheld missing-table provenance", () => {
  transaction(() => record(database, [main]));
  const report = readReport(database);
  updateReport({ missingJournal: "main" }, report);
  expect(() => missingHolds(database)).toThrow("Invalid missing-journal provenance");
  updateReport({ missingJournal: [other] }, report);
  expect(() => missingHolds(database)).toThrow("unheld agent database");
});
