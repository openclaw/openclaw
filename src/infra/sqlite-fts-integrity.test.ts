import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { OPENCLAW_AGENT_FTS_SCHEMAS } from "../state/openclaw-agent-fts-schema.js";
import { installSqliteFtsTokenizerMismatch } from "./sqlite-index-corruption.test-support.js";
import { repairDoctorSqliteIndexCorruption } from "./sqlite-index-recovery.js";
import {
  classifySqliteFtsIntegrityFindings,
  repairSqliteIndexCorruption,
} from "./sqlite-index-schema.js";

const roots = useAutoCleanupTempDirTracker(afterEach);

function fixture() {
  const pathname = path.join(roots.make("fts-repair-"), "agent.sqlite");
  {
    using db = new DatabaseSync(pathname);
    // Extract every canonical virtual table, including the lazy memory variants.
    const schemas = OPENCLAW_AGENT_FTS_SCHEMAS.join("\n");
    for (const match of schemas.matchAll(/CREATE VIRTUAL TABLE[^;]+;/gu)) {
      if (!match[0].includes("content =")) {
        db.exec(match[0]);
      }
    }
    db.exec("INSERT INTO session_transcript_fts(text) VALUES ('ab'||char(65534)||'cd')");
    db.exec("INSERT INTO memory_index_chunks_fts(text) VALUES ('ab'||char(65534)||'cd')");
  }
  installSqliteFtsTokenizerMismatch(pathname, "session_transcript_fts");
  installSqliteFtsTokenizerMismatch(pathname, "memory_index_chunks_fts");
  return pathname;
}

it("backs up and rebuilds only canonical FTS indexes without changing content", () => {
  const pathname = fixture();
  using db = new DatabaseSync(pathname);
  const findings = db.prepare("PRAGMA integrity_check").all();
  expect(findings).toEqual([
    { integrity_check: "malformed inverted index for FTS5 table main.memory_index_chunks_fts" },
    { integrity_check: "malformed inverted index for FTS5 table main.session_transcript_fts" },
  ]);
  const rows = db.prepare("SELECT * FROM session_transcript_fts").all();
  expect(
    classifySqliteFtsIntegrityFindings(
      db,
      findings.map((row) => row.integrity_check),
      OPENCLAW_AGENT_FTS_SCHEMAS,
    ),
  ).toEqual(["memory_index_chunks_fts", "session_transcript_fts"]);
  const result = repairDoctorSqliteIndexCorruption(db, pathname, {
    label: "agent main",
    assertCurrent: () => {},
    ftsSchemas: OPENCLAW_AGENT_FTS_SCHEMAS,
  });
  const backupPath = expectDefined(result[0], "backup diagnostic").replace(
    "Saved pre-repair SQLite backup: ",
    "",
  );
  expect(fs.existsSync(backupPath)).toBe(true);
  using backup = new DatabaseSync(backupPath, { readOnly: true });
  expect(backup.prepare("PRAGMA integrity_check").all()).toEqual(findings);
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  expect(db.prepare("SELECT * FROM session_transcript_fts").all()).toEqual(rows);
  expect(db.prepare("SELECT text FROM memory_index_chunks_fts").all()).toEqual([
    { text: "ab\ufffecd" },
  ]);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM session_transcript_fts WHERE session_transcript_fts MATCH ?",
      )
      .get('"ab\ufffecd"'),
  ).toEqual({ n: 1 });
});

it.each(["unknown", "drifted", "mixed"])(
  "does not classify %s FTS findings as derived-only damage",
  (kind) => {
    const pathname = fixture();
    using db = new DatabaseSync(pathname);
    const findings = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => row.integrity_check);
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
    expect(
      classifySqliteFtsIntegrityFindings(db, findings, OPENCLAW_AGENT_FTS_SCHEMAS),
    ).toBeUndefined();
  },
);

it("rolls an FTS rebuild back when commit authority is lost", () => {
  const pathname = fixture();
  using db = new DatabaseSync(pathname);
  const findings = db.prepare("PRAGMA integrity_check").all();
  const backup = vi.fn();
  expect(() =>
    repairSqliteIndexCorruption(db, pathname, {
      ftsSchemas: OPENCLAW_AGENT_FTS_SCHEMAS,
      backup,
      assertCurrent: () => {
        throw new Error("maintenance lost");
      },
    }),
  ).toThrow("maintenance lost");
  expect(backup).toHaveBeenCalledOnce();
  expect(db.prepare("PRAGMA integrity_check").all()).toEqual(findings);
});
