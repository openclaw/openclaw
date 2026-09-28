import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createDebugProxyCaptureReaderAsync } from "./store-readonly.async.js";
import { acquireDebugProxyCaptureStoreAsync } from "./store.async.js";
import type { CaptureEventRecord } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
});

function event(sessionId: string, flowId: string): CaptureEventRecord {
  return {
    sessionId,
    ts: 10,
    sourceScope: "openclaw",
    sourceProcess: "fixture",
    protocol: "https",
    direction: "outbound",
    kind: "request",
    flowId,
  };
}

describe("async capture store", () => {
  it("persists immutable FIFO input on a worker and preserves shared blob custody", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("capture-async-") };
    const native = requireNodeSqlite();
    const prepare = vi.spyOn(native.DatabaseSync.prototype, "prepare");
    const exec = vi.spyOn(native.DatabaseSync.prototype, "exec");
    const statements = (["get", "all", "run", "iterate"] as const).map((method) =>
      vi.spyOn(StatementSync.prototype, method),
    );
    const compress = vi.spyOn(zlib, "gzipSync");
    const decompress = vi.spyOn(zlib, "gunzipSync");
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    syncBuiltinESMExports();
    const lease = await acquireDebugProxyCaptureStoreAsync({ env });
    try {
      const session = {
        id: "first",
        startedAt: 1,
        mode: "fixture",
        sourceScope: "openclaw" as const,
        sourceProcess: "fixture",
      };
      const sessionWrite = lease.store.upsertSession(session);
      session.sourceProcess = "mutated";
      const bytes = Buffer.from("shared café");
      const payloadWrite = lease.store.persistPayload(bytes, "text/plain");
      const submitted = event("first", "accepted-first");
      const firstWrite = lease.store.recordEventWithPayload(submitted, {
        data: bytes,
        contentType: "text/plain",
        previewLimit: 10,
      });
      submitted.flowId = "mutated";
      bytes.fill(0);
      const secondWrite = lease.store.recordEventWithPayload(event("first", "accepted-second"), {
        data: "shared café",
      });
      const orderedRead = lease.store.getSessionEvents("first");
      await Promise.all([sessionWrite, firstWrite, secondWrite]);
      const rows = await orderedRead;
      expect(rows.map((row) => row.flowId)).toEqual(["accepted-second", "accepted-first"]);
      expect(rows[1]).toMatchObject({ dataText: "shared caf" });
      const blobId = rows[0]!.dataBlobId;
      expect(typeof blobId).toBe("string");
      if (typeof blobId !== "string") {
        throw new Error("Expected captured blob");
      }
      expect(rows[1]!.dataBlobId).toBe(blobId);
      expect((await payloadWrite).blobId).toBe(blobId);
      expect(await lease.store.readBlob(blobId)).toBe("shared café");
      expect(await lease.store.listSessions()).toEqual([
        expect.objectContaining({ id: "first", sourceProcess: "fixture", eventCount: 2 }),
      ]);
      await lease.store.recordEventWithPayload(event("second", "shared-reference"), {
        data: "shared café",
      });
      expect(await lease.store.deleteSessions(["first"])).toEqual({
        sessions: 1,
        events: 2,
        blobs: 0,
      });
      expect(await lease.store.readBlob(blobId)).toBe("shared café");
      expect(await lease.store.purgeAll()).toEqual({ sessions: 1, events: 1, blobs: 1 });
      expect(await lease.store.getSessionEvents("second")).toEqual([]);
      expect(await lease.store.readBlob(blobId)).toBeNull();
      expect(await lease.store.purgeAll()).toEqual({ sessions: 0, events: 0, blobs: 0 });
      expect(
        messages.mock.contexts.some((worker) => worker instanceof Worker && worker.threadId > 0),
      ).toBe(true);
      expect(prepare).not.toHaveBeenCalled();
      expect(exec).not.toHaveBeenCalled();
      for (const statement of statements) {
        expect(statement).not.toHaveBeenCalled();
      }
      expect(compress).not.toHaveBeenCalled();
      expect(decompress).not.toHaveBeenCalled();
    } finally {
      await lease.release();
      await closeOpenClawStateDatabaseByPathAsync(lease.store.dbPath);
    }
  });

  it("keeps a missing database absent and reads later writes from its captured state root", async () => {
    const root = tempDirs.make("capture-async-reader-");
    const originalEnv = { OPENCLAW_STATE_DIR: path.join(root, "original") };
    const alternateEnv = { OPENCLAW_STATE_DIR: path.join(root, "alternate") };
    const callerEnv = { ...originalEnv };
    const databasePath = resolveOpenClawStateSqlitePath(originalEnv);
    const alternatePath = resolveOpenClawStateSqlitePath(alternateEnv);
    const reader = createDebugProxyCaptureReaderAsync({ env: callerEnv });
    callerEnv.OPENCLAW_STATE_DIR = alternateEnv.OPENCLAW_STATE_DIR;
    let writer: Awaited<ReturnType<typeof acquireDebugProxyCaptureStoreAsync>> | undefined;
    try {
      expect(await reader.getSessionEvents("reader-session")).toEqual([]);
      expect(await reader.readBlob("missing")).toBeNull();
      expect(existsSync(databasePath)).toBe(false);
      expect(existsSync(alternateEnv.OPENCLAW_STATE_DIR)).toBe(false);

      writer = await acquireDebugProxyCaptureStoreAsync({ env: originalEnv });
      expect(writer.store.dbPath).toBe(databasePath);
      await writer.store.recordEventWithPayload(event("reader-session", "later-write"), {
        data: "reader payload",
        contentType: "text/plain",
      });
      const rows = await reader.getSessionEvents("reader-session");
      expect(rows).toEqual([
        expect.objectContaining({ flowId: "later-write", dataText: "reader payload" }),
      ]);
      const blobId = rows[0]!.dataBlobId;
      if (typeof blobId !== "string") {
        throw new Error("Expected captured blob");
      }
      expect(await reader.readBlob(blobId)).toBe("reader payload");
      await withOpenClawStateDatabaseReadSnapshot(
        async () => {
          await writer!.store.recordEventWithPayload(event("reader-session", "after-snapshot"), {
            data: "newer payload",
          });
          expect(await reader.getSessionEvents("reader-session")).toEqual(rows);
          expect(await reader.readBlob(blobId)).toBe("reader payload");
        },
        { env: originalEnv },
      );
      expect((await reader.getSessionEvents("reader-session")).map((row) => row.flowId)).toEqual([
        "after-snapshot",
        "later-write",
      ]);
      expect(existsSync(databasePath)).toBe(true);
      expect(existsSync(alternateEnv.OPENCLAW_STATE_DIR)).toBe(false);
    } finally {
      await writer?.release();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      await closeOpenClawStateDatabaseByPathAsync(alternatePath);
    }
  });

  it.each(["close", "release"] as const)(
    "%s joins accepted writes and leaves their durable result readable",
    async (mode) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("capture-async-close-") };
      const lease = await acquireDebugProxyCaptureStoreAsync({ env });
      const dbPath = path.join(env.OPENCLAW_STATE_DIR, "state", "openclaw.sqlite");
      try {
        let writeSettled = false;
        const writing = lease.store
          .recordEventWithPayload(event("accepted", "before-close"), { data: "accepted bytes" })
          .then(() => {
            writeSettled = true;
          });
        const closing = mode === "close" ? lease.store.close() : lease.release();
        expect(lease.store.close()).toBe(closing);
        await closing;
        expect(writeSettled).toBe(true);
        expect(lease.store.isClosed).toBe(true);
        await writing;
        const reopened = await acquireDebugProxyCaptureStoreAsync({ env });
        try {
          expect(await reopened.store.getSessionEvents("accepted")).toEqual([
            expect.objectContaining({ flowId: "before-close", dataText: "accepted bytes" }),
          ]);
        } finally {
          await reopened.release();
        }
      } finally {
        await lease.release();
        await closeOpenClawStateDatabaseByPathAsync(dbPath);
      }
    },
  );
});
