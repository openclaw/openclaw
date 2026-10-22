import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_FTS_SCHEMAS as schemas } from "../state/openclaw-agent-fts-schema.js";
import { installSqliteFtsTokenizerMismatch } from "./sqlite-index-corruption.test-support.js";
import { repairDoctorSqliteIndexCorruption as repairDoctor } from "./sqlite-index-recovery.js";
import {
  classifySqliteFtsIntegrityFindings as classify,
  repairSqliteIndexCorruption as repair,
} from "./sqlite-index-schema.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const tables = ["memory_index_chunks_fts", "session_transcript_fts"];
const all = (db: DatabaseSync, sql = "PRAGMA integrity_check") => db.prepare(sql).all();

function fixture() {
  const pathname = path.join(roots.make("fts-repair-"), "agent.sqlite");
  {
    using db = new DatabaseSync(pathname);
    // Extract every canonical virtual table, including the lazy memory variants.
    for (const match of schemas.join("\n").matchAll(/CREATE VIRTUAL TABLE[^;]+;/gu)) {
      if (!match[0].includes("content =")) {
        db.exec(match[0]);
      }
    }
    for (const table of tables) {
      db.exec(`INSERT INTO ${table}(text) VALUES ('ab'||char(65534)||'cd')`);
    }
  }
  for (const table of tables) {
    installSqliteFtsTokenizerMismatch(pathname, table);
  }
  return pathname;
}

it("backs up and rebuilds only canonical FTS indexes without changing content", () => {
  const pathname = fixture();
  using db = new DatabaseSync(pathname);
  const findings = all(db);
  expect(findings).toEqual(
    tables.map((table) => ({
      integrity_check: `malformed inverted index for FTS5 table main.${table}`,
    })),
  );
  const rows = all(db, "SELECT * FROM session_transcript_fts");
  const messages = findings.map((row) => row.integrity_check);
  expect(classify(db, messages, schemas)).toEqual(tables);
  const result = repairDoctor(db, pathname, {
    label: "agent main",
    assertCurrent: () => {},
    ftsSchemas: schemas,
  });
  const backupPath = expectDefined(result[0], "backup diagnostic").replace(
    "Saved pre-repair SQLite backup: ",
    "",
  );
  using backup = new DatabaseSync(backupPath, { readOnly: true });
  expect(all(backup)).toEqual(findings);
  expect(all(db)).toEqual([{ integrity_check: "ok" }]);
  expect(all(db, "SELECT * FROM session_transcript_fts")).toEqual(rows);
  expect(all(db, "SELECT text FROM memory_index_chunks_fts")).toEqual([{ text: "ab\ufffecd" }]);
  const matches = db.prepare(
    "SELECT count(*) AS n FROM session_transcript_fts WHERE session_transcript_fts MATCH ?",
  );
  expect(matches.get('"ab\ufffecd"')).toEqual({ n: 1 });
});

it.each(["unknown", "drifted", "mixed"])(
  "does not classify %s FTS findings as derived-only damage",
  (kind) => {
    const pathname = fixture();
    using db = new DatabaseSync(pathname);
    const findings = all(db).map((row) => row.integrity_check);
    if (kind === "unknown") {
      findings.push("malformed inverted index for FTS5 table main.unowned");
    } else if (kind === "mixed") {
      findings.push("row 1 missing from index idx_data");
    } else {
      db.enableDefensive?.(false);
      db.exec("PRAGMA writable_schema=ON");
      db.prepare(
        "UPDATE sqlite_schema SET sql=replace(sql, 'text,', 'other,') WHERE name='session_transcript_fts'",
      ).run();
    }
    expect(classify(db, findings, schemas)).toBeUndefined();
  },
);

it("rolls an FTS rebuild back when commit authority is lost", () => {
  const pathname = fixture();
  using db = new DatabaseSync(pathname);
  const findings = all(db);
  const backup = vi.fn();
  expect(() =>
    repair(db, pathname, {
      ftsSchemas: schemas,
      backup,
      assertCurrent: () => {
        throw new Error("maintenance lost");
      },
    }),
  ).toThrow("maintenance lost");
  expect(backup).toHaveBeenCalledOnce();
  expect(all(db)).toEqual(findings);
});
