import fs from "node:fs";
import fsAsync from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { cleanupManagedOutgoingMediaRecords } from "./managed-image-attachments.js";
import { createFixture } from "./managed-image-attachments.test-support.js";
import {
  claimManagedImageRecordCleanupIfCurrent,
  readManagedImageRecord,
  type ManagedImageRecord,
} from "./managed-image-record-store.js";

let stateDir: string;
const attachmentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const agentDatabase = () =>
  openOpenClawAgentDatabase({ agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } });
const stateDatabase = () =>
  openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } });
const records = (columns = "*", suffix = "") =>
  stateDatabase()
    .db.prepare(`SELECT ${columns} FROM managed_outgoing_image_records ${suffix}`)
    .all();

function oldOrphan(originalPath: string, name = "old-orphan.png", body = "orphan-image") {
  const orphan = path.join(path.dirname(originalPath), name);
  fs.writeFileSync(orphan, body);
  fs.utimesSync(orphan, 0, 0);
  return orphan;
}

function expectBytes(original: string, orphan: string, orphanBody = "orphan-image") {
  expect(fs.readFileSync(original, "utf8")).toBe("original-image");
  expect(fs.readFileSync(orphan, "utf8")).toBe(orphanBody);
}

async function seedManagedRecord(
  id = attachmentId,
  overrides: Partial<
    Pick<ManagedImageRecord, "agentId" | "sessionKey" | "messageId" | "alt" | "createdAt">
  > = {},
) {
  const { originalPath } = await createFixture(stateDir, {
    attachmentId: id,
    agentId: "main",
    ...overrides,
  });
  return originalPath;
}

function cleanup(
  options: Omit<
    NonNullable<Parameters<typeof cleanupManagedOutgoingMediaRecords>[0]>,
    "stateDir"
  > = {},
) {
  return withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
    cleanupManagedOutgoingMediaRecords({ stateDir, ...options }),
  );
}

function dropSessionNodes() {
  const databasePath = agentDatabase().path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE session_nodes;");
  database.close();
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "gc-availability-"));
  setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("cleanupManagedOutgoingMediaRecords availability fail-safe", () => {
  it.each(["missing", "healthy"] as const)(
    "deletes dereferenced records only when the session store is healthy (%s)",
    async (store) => {
      agentDatabase();
      const originalPath = await seedManagedRecord();
      if (store === "missing") {
        dropSessionNodes();
      }
      await cleanup();
      const record = await readManagedImageRecord(attachmentId, stateDir);
      if (store === "missing") {
        expect(record).not.toBeNull();
      } else {
        expect(record).toBeNull();
      }
      expect(fs.existsSync(originalPath)).toBe(store === "missing");
    },
  );
  it.each(["original_width", "original_height", "original_size_bytes"])(
    "keeps records and orphan files when %s cannot be decoded safely",
    async (column) => {
      const originalPath = await seedManagedRecord();
      const orphanPath = oldOrphan(originalPath);
      const database = stateDatabase();
      database.db.exec(`UPDATE managed_outgoing_image_records SET ${column} = 9007199254740992`);

      await expect(cleanup()).rejects.toBeInstanceOf(RangeError);
      expectBytes(originalPath, orphanPath);
      expect(records("cleanup_pending")).toEqual([{ cleanup_pending: 0 }]);
    },
  );

  it("keeps other agents' claimed and unclaimed bytes without rereading full metadata", async () => {
    agentDatabase();
    const metadata = "synthetic-alt ".repeat(1024);
    const survivorIds = [
      "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "ffffffff-ffff-4fff-8fff-ffffffffffff",
    ] as const;
    const survivors = await Promise.all(
      survivorIds.map((id, index) =>
        seedManagedRecord(id, {
          agentId: index === 0 ? "main" : "other",
          sessionKey: index === 0 ? "agent:main:main" : "agent:other:main",
          messageId: null,
          alt: metadata,
        }),
      ),
    );
    const claimed = await readManagedImageRecord(survivorIds[2], stateDir);
    if (!claimed) {
      throw new Error("Expected the seeded claimed record");
    }
    expect(await claimManagedImageRecordCleanupIfCurrent(claimed, stateDir)).toBe(true);
    const deletedId = "11111111-1111-4111-8111-111111111111";
    const deleted = await seedManagedRecord(deletedId);
    const orphan = oldOrphan(deleted);
    for (const file of [...survivors, orphan]) {
      fs.utimesSync(file, 0, 0);
    }
    const database = stateDatabase();
    const readPersistedRecords = () => records("*", "ORDER BY attachment_id");
    const persistedBefore = readPersistedRecords();
    const counter = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["records"],
      (sql) =>
        /^\s*select\b/i.test(sql) && sql.includes('from "managed_outgoing_image_records"')
          ? "records"
          : null,
    );
    try {
      await cleanup({ sessionKey: "agent:main:main" });
      expect([
        counter.counts.records,
        counter.rowCounts.records,
        counter.textBytes.records,
      ]).toEqual([0, 0, 0]);
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
      const originalPath = await seedManagedRecord(attachmentId, {
        messageId: null,
        createdAt: new Date(0).toISOString(),
      });
      const orphanPath = oldOrphan(originalPath, "late-orphan.png", "late-orphan-image");
      const database = stateDatabase();
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
          cleanup({
            hasActiveSessionRun: (sessionKey, agentId) => {
              expect(sessionKey).toBe("agent:main:main");
              expect(agentId).toBe("main");
              events.push("active-run");
              return true;
            },
          }),
        ).rejects.toBeInstanceOf(RangeError);
        expect(events).toEqual(["active-run", "legacy-directory"]);
        expectBytes(originalPath, orphanPath, "late-orphan-image");
        expect(records("attachment_id")).toEqual([{ attachment_id: attachmentId }]);
      } finally {
        readdir.mockRestore();
      }
    },
  );
});
