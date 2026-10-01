// Managed image record store tests cover typed-column authority and atomic mutations.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deserialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import * as brokerReply from "../infra/sqlite-worker-broker-reply.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  attachManagedImageRecordsToMessage,
  claimManagedImageRecordCleanupIfCurrent,
  deleteClaimedManagedImageRecord,
  insertManagedImageRecord,
  listManagedImageRecordEntries,
  listManagedImageOriginalMediaIds,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
  type ManagedImageRecord,
  type ManagedImageRecordDatabase,
} from "./managed-image-record-store.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function record(overrides: Partial<ManagedImageRecord> = {}): ManagedImageRecord {
  return {
    attachmentId: "11111111-1111-4111-8111-111111111111",
    sessionKey: "agent:main:main",
    agentId: "main",
    messageId: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    retentionClass: "transient",
    alt: "Cat",
    original: {
      mediaRoot: path.join(os.tmpdir(), "managed-image-media"),
      mediaId: "cat---11111111-1111-4111-8111-111111111111.png",
      mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
      contentType: "image/png",
      width: 640,
      height: 480,
      sizeBytes: 123,
      filename: "cat.png",
    },
    ...overrides,
  };
}

describe("managed image record SQLite store", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = tempDirs.make("managed-image-record-store-");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("creates, reads, and reopens managed metadata without parent SQL", async () => {
    requireNodeSqlite();
    const counters = observeMainThreadSql();
    try {
      counters.calibrate();
      expect(await readManagedImageRecord("missing", stateDir)).toBeNull();
      expect(await listManagedImageRecordEntries({ stateDir })).toEqual([]);
      expect(await listManagedImageOriginalMediaIds(stateDir)).toEqual([]);
      expect((await fs.stat(path.join(stateDir, "state", "openclaw.sqlite"))).isFile()).toBe(true);
      counters.expectIdle();

      const first = record();
      const claimed = record({ attachmentId: "22222222-2222-4222-8222-222222222222" });
      const older = record({
        attachmentId: "33333333-3333-4333-8333-333333333333",
        createdAt: "2026-07-14T00:00:00.000Z",
        sessionKey: "agent:other:main",
        original: { ...first.original, mediaId: "older.png" },
      });
      await insertManagedImageRecord(claimed, stateDir);
      await insertManagedImageRecord(older, stateDir);
      await insertManagedImageRecord(first, stateDir);
      expect(await claimManagedImageRecordCleanupIfCurrent(claimed, stateDir)).toBe(true);
      counters.expectIdle();
      await closeOpenClawStateDatabaseAsync();
      counters.clear();
      expect(await readManagedImageRecord(first.attachmentId, stateDir)).toEqual(first);
      expect(await readManagedImageRecord(claimed.attachmentId, stateDir)).toBeNull();
      expect(await listManagedImageRecordEntries({ stateDir })).toEqual([
        { record: first, cleanupPending: false },
        { record: claimed, cleanupPending: true },
        { record: older, cleanupPending: false },
      ]);
      expect(await listManagedImageOriginalMediaIds(stateDir)).toEqual([
        first.original.mediaId,
        claimed.original.mediaId,
        older.original.mediaId,
      ]);
      const options = { stateDir, sessionKey: first.sessionKey };
      const pending = listManagedImageRecordEntries(options);
      options.stateDir = path.join(stateDir, "later");
      options.sessionKey = older.sessionKey;
      expect(await pending).toEqual([
        { record: first, cleanupPending: false },
        { record: claimed, cleanupPending: true },
      ]);
      await closeOpenClawStateDatabaseAsync();
      counters.expectIdle();
    } finally {
      counters.restore();
    }
  });

  it("round-trips every typed field", async () => {
    const expected = record({
      messageId: "message-1",
      updatedAt: "2026-07-15T00:01:00.000Z",
      retentionClass: "history",
    });

    await insertManagedImageRecord(expected, stateDir);

    expect(await readManagedImageRecord(expected.attachmentId, stateDir)).toEqual(expected);
  });

  it("uses typed columns when the debug JSON copy is corrupt", async () => {
    const expected = record();
    await insertManagedImageRecord(expected, stateDir);
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    executeSqliteQuerySync(
      database.db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db)
        .updateTable("managed_outgoing_image_records")
        .set({ record_json: '{"attachmentId":"wrong"}' })
        .where("attachment_id", "=", expected.attachmentId),
    );

    expect(await readManagedImageRecord(expected.attachmentId, stateDir)).toEqual(expected);
  });

  it("atomically promotes a transient row and refreshes its debug copy", async () => {
    const initial = record();
    await insertManagedImageRecord(initial, stateDir);

    expect(
      await attachManagedImageRecordsToMessage({
        attachments: [initial],
        messageId: "message-committed",
        updatedAt: "2026-07-15T00:02:00.000Z",
        stateDir,
      }),
    ).toBe(true);

    const current = await readManagedImageRecord(initial.attachmentId, stateDir);
    expect(current).toMatchObject({
      messageId: "message-committed",
      retentionClass: "history",
      updatedAt: "2026-07-15T00:02:00.000Z",
    });
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      getNodeSqliteKysely<ManagedImageRecordDatabase>(database.db)
        .selectFrom("managed_outgoing_image_records")
        .select("record_json")
        .where("attachment_id", "=", initial.attachmentId),
    );
    expect(JSON.parse(row?.record_json ?? "{}")).toEqual(current);
  });

  it("keeps a row changed after cleanup planning", async () => {
    const planned = record();
    await insertManagedImageRecord(planned, stateDir);
    await attachManagedImageRecordsToMessage({
      attachments: [planned],
      messageId: "message-committed",
      updatedAt: "2026-07-15T00:02:00.000Z",
      stateDir,
    });

    expect(await claimManagedImageRecordCleanupIfCurrent(planned, stateDir)).toBe(false);
    expect((await readManagedImageRecord(planned.attachmentId, stateDir))?.messageId).toBe(
      "message-committed",
    );
  });

  it("keeps a cleanup claim durable until the file deletion completes", async () => {
    const planned = record();
    await insertManagedImageRecord(planned, stateDir);

    expect(await claimManagedImageRecordCleanupIfCurrent(planned, stateDir)).toBe(true);
    expect(await readManagedImageRecord(planned.attachmentId, stateDir)).toBeNull();
    expect(
      await attachManagedImageRecordsToMessage({
        attachments: [planned],
        messageId: "too-late",
        updatedAt: "2026-07-15T00:02:00.000Z",
        stateDir,
      }),
    ).toBe(false);
    expect(await listManagedImageRecordEntries({ stateDir })).toEqual([
      { record: planned, cleanupPending: true },
    ]);

    expect(await deleteClaimedManagedImageRecord(planned, stateDir)).toBe(true);
    expect(await listManagedImageRecordEntries({ stateDir })).toEqual([]);
  });

  it("reserves promotion before an awaited worker entry so cleanup cannot overtake it", async (test) => {
    const initial = record();
    await insertManagedImageRecord(initial, stateDir);
    const entered = createDeferred();
    const release = createDeferred();
    const run = stateWorker.runOpenClawStateWorkerOperation;
    const held = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementationOnce(async (...args) => {
        entered.resolve();
        await release.promise;
        return await run(...args);
      });
    const attaching = attachManagedImageRecordsToMessage({
      attachments: [initial],
      messageId: "committed",
      updatedAt: initial.createdAt,
      stateDir,
    });
    let claiming: Promise<boolean> | undefined;
    void attaching.catch(() => {});
    try {
      await racePromiseWithAbortSignal(entered.promise, test.signal);
      claiming = claimManagedImageRecordCleanupIfCurrent(initial, stateDir);
      // An actual independent reader completes while the accepted mutation still waits.
      expect(await readManagedImageRecord(initial.attachmentId, stateDir)).toEqual(initial);
      expect(held).toHaveBeenCalledTimes(1);
      release.resolve();
      expect(await attaching).toBe(true);
      expect(await claiming).toBe(false);
      expect(await readManagedImageRecord(initial.attachmentId, stateDir)).toMatchObject({
        messageId: "committed",
        retentionClass: "history",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([attaching, claiming]);
      held.mockRestore();
    }
  });

  it("recovers exact native mutation receipts after ordinary replies are lost", async () => {
    const initial = record();
    const receive = brokerReply.receiveSqliteWorkerReply;
    const corrupted: string[] = [];
    vi.spyOn(brokerReply, "receiveSqliteWorkerReply").mockImplementation((slot, reply, owner) => {
      if (slot.current?.request.type === "execute" && reply.ok && !reply.transfer && !reply.input) {
        const command: unknown = deserialize(slot.current.request.input);
        if (
          isRecord(command) &&
          typeof command.type === "string" &&
          [
            "managedImages.insert",
            "managedImages.attach",
            "managedImages.claimCleanup",
            "managedImages.deleteClaimed",
          ].includes(command.type)
        ) {
          corrupted.push(command.type);
          return receive(slot, { ...reply, value: new Uint8Array([0]) }, owner);
        }
      }
      return receive(slot, reply, owner);
    });
    await insertManagedImageRecord(initial, stateDir);
    expect(
      await attachManagedImageRecordsToMessage({
        attachments: [initial],
        messageId: "committed",
        updatedAt: initial.createdAt,
        stateDir,
      }),
    ).toBe(true);
    const promoted = await readManagedImageRecord(initial.attachmentId, stateDir);
    if (!promoted) {
      throw new Error("Expected native promotion after lost reply");
    }
    expect(promoted.messageId).toBe("committed");
    expect(await claimManagedImageRecordCleanupIfCurrent(promoted, stateDir)).toBe(true);
    expect(await deleteClaimedManagedImageRecord(promoted, stateDir)).toBe(true);
    expect(await listManagedImageRecordEntries({ stateDir })).toEqual([]);
    expect(corrupted).toEqual([
      "managedImages.insert",
      "managedImages.attach",
      "managedImages.claimCleanup",
      "managedImages.deleteClaimed",
    ]);
  });
});
