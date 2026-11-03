import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { listTranscriptArchivesFromDatabase } from "./session-accessor.sqlite-archive-read.js";

describe("SQLite archive inventory", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE session_transcript_archives (
        archive_name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO session_transcript_archives VALUES
        ('late.jsonl', 'late', 'agent:main:late', 30),
        ('early-b.jsonl', 'early-b', 'agent:main:early-b', 10),
        ('foreign.jsonl', 'foreign', 'agent:other:foreign', 5),
        ('early-a.jsonl', 'early-a', 'agent:main:early-a', 10);
    `);
  });

  afterEach(() => {
    clearNodeSqliteKyselyCacheForDatabase(db);
    db.close();
  });

  it.each(["archive names", "session selectors"] as const)(
    "reads large %s without losing matches, ordering, or agent isolation",
    (selection) => {
      // Exceed even the 250,000-bind SQLite build; selectors occur in two IN operands.
      const values = Array.from(
        { length: selection === "archive names" ? 250_001 : 125_001 },
        (_, index) => `missing-${index}`,
      );
      const selectors = selection === "session selectors" ? values : [];
      const archiveNames = selection === "archive names" ? values : [];
      const read = (logicalAgentId?: string) =>
        listTranscriptArchivesFromDatabase(
          { db, agentId: "main" },
          logicalAgentId,
          selectors,
          archiveNames,
        );
      expect(read()).toEqual([]);
      values[0] = selection === "archive names" ? "late.jsonl" : "late";
      values[1] = selection === "archive names" ? "early-b.jsonl" : "agent:main:early-b";
      values[2] = selection === "archive names" ? "early-a.jsonl" : "early-a";
      values[3] = selection === "archive names" ? "foreign.jsonl" : "agent:other:foreign";
      values[4] = values[0]!;
      const main = [
        {
          archiveName: "early-a.jsonl",
          sessionId: "early-a",
          sessionKey: "agent:main:early-a",
          createdAt: 10,
          agentId: "main",
        },
        {
          archiveName: "early-b.jsonl",
          sessionId: "early-b",
          sessionKey: "agent:main:early-b",
          createdAt: 10,
          agentId: "main",
        },
        {
          archiveName: "late.jsonl",
          sessionId: "late",
          sessionKey: "agent:main:late",
          createdAt: 30,
          agentId: "main",
        },
      ];
      expect(read()).toEqual([
        {
          archiveName: "foreign.jsonl",
          sessionId: "foreign",
          sessionKey: "agent:other:foreign",
          createdAt: 5,
          agentId: "other",
        },
        ...main,
      ]);
      expect(read("main")).toEqual(main);
    },
  );
});
