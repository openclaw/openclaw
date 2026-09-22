import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupManagedOutgoingMediaRecords } from "./managed-image-attachments.js";
import {
  claimManagedImageRecordCleanupIfCurrent,
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
} from "./managed-image-record-store.js";

// End-to-end, real-SQLite regression for the global media GC fail-safe:
// when the session store cannot be read (here: session_nodes dropped), the
// sweep must keep every managed record and its bytes instead of concluding
// the owning messages are gone.

let stateDir: string;

function seedManagedRecord(
  attachmentId: string,
  overrides: Partial<Omit<ManagedImageRecord, "attachmentId" | "original">> = {},
) {
  const filename = `${attachmentId}-cat-full.png`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, filename);
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.writeFileSync(originalPath, "original-image");
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey: "agent:main:main",
      agentId: "main",
      messageId: "msg-1",
      createdAt: new Date().toISOString(),
      alt: "Cat",
      ...overrides,
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId: filename,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: "image/png",
        width: 1024,
        height: 768,
        sizeBytes: "original-image".length,
        filename: "cat.png",
      },
    },
    stateDir,
  );
  return originalPath;
}

function dropSessionNodes() {
  const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE session_nodes;");
  database.close();
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "gc-availability-"));
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("cleanupManagedOutgoingMediaRecords availability fail-safe", () => {
  it("keeps records and bytes when session_nodes is missing", async () => {
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    openOpenClawAgentDatabase(options);
    const originalPath = seedManagedRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    dropSessionNodes();

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingMediaRecords({ stateDir }),
    );

    expect(result.deletedRecordCount).toBe(0);
    expect(readManagedImageRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stateDir)).not.toBeNull();
    expect(fs.existsSync(originalPath)).toBe(true);
  });

  it("still deletes dereferenced records when the store is healthy", async () => {
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    openOpenClawAgentDatabase(options);
    const originalPath = seedManagedRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingMediaRecords({ stateDir }),
    );

    expect(result.deletedRecordCount).toBe(1);
    expect(readManagedImageRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", stateDir)).toBeNull();
    expect(fs.existsSync(originalPath)).toBe(false);
  });
  it.each(["original_width", "original_height", "original_size_bytes"])(
    "keeps records and orphan files when %s cannot be decoded safely",
    async (column) => {
      const originalPath = seedManagedRecord("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
      const orphanPath = path.join(path.dirname(originalPath), "old-orphan.png");
      fs.writeFileSync(orphanPath, "orphan-image");
      fs.utimesSync(orphanPath, 0, 0);
      const database = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      database.db.exec(`UPDATE managed_outgoing_image_records SET ${column} = 9007199254740992`);

      await expect(
        withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
          cleanupManagedOutgoingMediaRecords({ stateDir }),
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(fs.readFileSync(originalPath, "utf8")).toBe("original-image");
      expect(fs.readFileSync(orphanPath, "utf8")).toBe("orphan-image");
      expect(
        database.db.prepare("SELECT cleanup_pending FROM managed_outgoing_image_records").all(),
      ).toEqual([{ cleanup_pending: 0 }]);
    },
  );

  it("keeps other agents' claimed and unclaimed bytes without rereading full metadata", async () => {
    openOpenClawAgentDatabase({ agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } });
    const metadata = "synthetic-alt ".repeat(1024);
    const survivorIds = [
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ] as const;
    const survivors = survivorIds.map((attachmentId, index) =>
      seedManagedRecord(attachmentId, {
        agentId: index === 0 ? "main" : "other",
        sessionKey: index === 0 ? "agent:main:main" : "agent:other:main",
        messageId: null,
        alt: metadata,
      }),
    );
    const claimed = readManagedImageRecord(survivorIds[2], stateDir);
    if (!claimed) {
      throw new Error("Expected the seeded claimed record");
    }
    expect(claimManagedImageRecordCleanupIfCurrent(claimed, stateDir)).toBe(true);
    const deletedId = "11111111-1111-4111-8111-111111111111";
    const deleted = seedManagedRecord(deletedId);
    const orphan = path.join(path.dirname(deleted), "old-orphan.png");
    fs.writeFileSync(orphan, "orphan-image");
    for (const file of [...survivors, orphan]) {
      fs.utimesSync(file, 0, 0);
    }
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const readPersistedRecords = () =>
      database.db
        .prepare("SELECT * FROM managed_outgoing_image_records ORDER BY attachment_id")
        .all();
    const persistedBefore = readPersistedRecords();
    const counter = trackSqliteStatementExecutions(database.db, ["records"], (sql) =>
      /^\s*select\b/i.test(sql) && sql.includes('from "managed_outgoing_image_records"')
        ? "records"
        : null,
    );
    try {
      await expect(
        withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
          cleanupManagedOutgoingMediaRecords({ stateDir, sessionKey: "agent:main:main" }),
        ),
      ).resolves.toEqual({ deletedRecordCount: 1, deletedFileCount: 2, retainedCount: 3 });
      expect(counter.counts.records).toBeGreaterThan(0);
      expect(counter.counts.records).toBeLessThanOrEqual(5);
      expect(counter.rowCounts.records).toBeGreaterThan(0);
      expect(counter.rowCounts.records).toBeLessThanOrEqual(9);
      expect(counter.textBytes.records).toBeLessThan(4 * Buffer.byteLength(metadata));
    } finally {
      counter.restore();
    }
    for (const file of survivors) {
      expect(fs.readFileSync(file, "utf8")).toBe("original-image");
    }
    expect(fs.existsSync(deleted)).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(readPersistedRecords()).toEqual(
      persistedBefore.filter((row) => row.attachment_id !== deletedId),
    );
  });

  it.each(["original_width", "original_height", "original_size_bytes", "cleanup_pending"])(
    "stops orphan deletion when %s becomes unsafe after the first record scan",
    async (column) => {
      const attachmentId = "22222222-2222-4222-8222-222222222222";
      const originalPath = seedManagedRecord(attachmentId, {
        messageId: null,
        createdAt: new Date(0).toISOString(),
      });
      const orphanPath = path.join(path.dirname(originalPath), "late-orphan.png");
      fs.writeFileSync(orphanPath, "late-orphan-image");
      fs.utimesSync(orphanPath, 0, 0);
      const database = openOpenClawStateDatabase({
        env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      });
      const events: string[] = [];
      const readdir = vi.spyOn(fsAsync, "readdir").mockImplementationOnce(async (directory) => {
        expect(directory).toBe(path.join(stateDir, "media", "outgoing", "records"));
        expect(events).toEqual(["active-run"]);
        events.push("legacy-directory");
        // Model a corrupt persisted flag only in this synthetic database.
        if (column === "cleanup_pending") {
          database.db.exec("PRAGMA ignore_check_constraints = ON");
        }
        try {
          database.db.exec(
            `UPDATE managed_outgoing_image_records SET ${column} = 9007199254740992`,
          );
        } finally {
          if (column === "cleanup_pending") {
            database.db.exec("PRAGMA ignore_check_constraints = OFF");
          }
        }
        return [];
      });
      try {
        await expect(
          withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
            cleanupManagedOutgoingMediaRecords({
              stateDir,
              hasActiveSessionRun: (sessionKey, agentId) => {
                expect(sessionKey).toBe("agent:main:main");
                expect(agentId).toBe("main");
                events.push("active-run");
                return true;
              },
            }),
          ),
        ).rejects.toBeInstanceOf(RangeError);
        expect(events).toEqual(["active-run", "legacy-directory"]);
        expect(fs.readFileSync(originalPath, "utf8")).toBe("original-image");
        expect(fs.readFileSync(orphanPath, "utf8")).toBe("late-orphan-image");
        expect(
          database.db.prepare("SELECT attachment_id FROM managed_outgoing_image_records").all(),
        ).toEqual([{ attachment_id: attachmentId }]);
      } finally {
        readdir.mockRestore();
      }
    },
  );
});
