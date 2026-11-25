import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import {
  listTranscriptArchiveIdentitiesFromDatabase,
  listTranscriptArchivesFromDatabase,
} from "./session-accessor.sqlite-archive-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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

  // /proc/self/io counts every pread SQLite issues, including page-cache hits.
  it.runIf(fs.existsSync("/proc/self/io"))("lists usage identities without reading blobs", () => {
    const file = path.join(tempDirs.make("openclaw-archive-inventory-"), "agent.sqlite");
    const writer = new DatabaseSync(file);
    ensureSessionTranscriptArchiveSchema(writer);
    const names = Array.from({ length: 64 }, (_, index) => `s${index}.jsonl.deleted.zst`);
    const insert = writer.prepare(
      `INSERT INTO session_transcript_archives (session_id, generation, session_key, reason,
         encoding, archive_blob, archive_sha256, archive_name, created_at)
       VALUES (?, 'g', ?, 'deleted', 'zstd', ?, ?, ?, ?)`,
    );
    names.forEach((name, index) =>
      insert.run(
        `s${index}`,
        `agent:main:s${index}`,
        new Uint8Array(256 * 1024),
        "0".repeat(64),
        name,
        index,
      ),
    );
    writer.close();
    const reader = new DatabaseSync(file, { readOnly: true });
    const readBytes = () =>
      Number(/^rchar: (\d+)$/m.exec(fs.readFileSync("/proc/self/io", "utf8"))![1]);
    try {
      const before = readBytes();
      const archives = listTranscriptArchiveIdentitiesFromDatabase(
        { db: reader, agentId: "main" },
        names,
      );
      expect(readBytes() - before).toBeLessThan((names.length * 256 * 1024) / 32);
      expect(archives).toContainEqual({
        archiveName: names[3],
        sessionId: "s3",
        sessionKey: "agent:main:s3",
        agentId: "main",
      });
      expect(archives).toHaveLength(names.length);
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(reader);
      reader.close();
    }
  });
});
