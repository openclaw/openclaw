import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import { listTranscriptArchivesFromDatabase } from "./session-accessor.sqlite-archive-read.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function insertArchive(
  db: DatabaseSync,
  [archiveName, sessionId, sessionKey, createdAt]: [string, string, string, number],
  blob: Uint8Array = new Uint8Array(1),
) {
  db.prepare(
    `INSERT INTO session_transcript_archives
       (session_id, generation, session_key, reason, encoding, archive_blob, archive_sha256, archive_name, created_at)
     VALUES (?, 'g', ?, 'deleted', 'zstd', ?, ?, ?, ?)`,
  ).run(sessionId, sessionKey, blob, "0".repeat(64), archiveName, createdAt);
}

describe("SQLite archive inventory", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    ensureSessionTranscriptArchiveSchema(db);
    for (const row of [
      ["late.jsonl", "late", "agent:main:late", 30],
      ["early-b.jsonl", "early-b", "agent:main:early-b", 10],
      ["foreign.jsonl", "foreign", "agent:other:foreign", 5],
      ["early-a.jsonl", "early-a", "agent:main:early-a", 10],
    ] as const) {
      insertArchive(db, [...row]);
    }
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
  it.runIf(fs.existsSync("/proc/self/io"))(
    "lists archive metadata without reading the transcript blobs stored beside it",
    () => {
      const file = path.join(tempDirs.make("openclaw-archive-inventory-"), "agent.sqlite");
      const writer = new DatabaseSync(file);
      ensureSessionTranscriptArchiveSchema(writer);
      const names = Array.from({ length: 64 }, (_, index) => `s${index}.jsonl.deleted.zst`);
      names.forEach((name, index) =>
        insertArchive(
          writer,
          [name, `s${index}`, `agent:main:s${index}`, index],
          new Uint8Array(256 * 1024).fill(index),
        ),
      );
      writer.close();
      const blobBytes = names.length * 256 * 1024;
      const readChars = () =>
        Number(/^rchar: (\d+)$/m.exec(fs.readFileSync("/proc/self/io", "utf8"))![1]);
      // A fresh connection starts with an empty page cache, so every page read is a pread.
      const reader = new DatabaseSync(file, { readOnly: true });
      try {
        for (const [selectors, archiveNames] of [
          [[], names],
          [["s3"], []],
        ] as const) {
          const before = readChars();
          const archives = listTranscriptArchivesFromDatabase(
            { db: reader, agentId: "main" },
            undefined,
            selectors,
            archiveNames,
          );
          expect(readChars() - before).toBeLessThan(blobBytes / 32);
          expect(archives.length).toBe(selectors.length ? 1 : names.length);
        }
      } finally {
        clearNodeSqliteKyselyCacheForDatabase(reader);
        reader.close();
      }
    },
  );
});
