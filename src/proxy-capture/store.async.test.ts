import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { withOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createDebugProxyCaptureReaderAsync } from "./store-readonly.async.js";
import { acquireDebugProxyCaptureStoreAsync } from "./store.async.js";
import type { CaptureEventRecord } from "./types.js";

const tempDirs = createTempDirTracker();
type Lease = Awaited<ReturnType<typeof acquireDebugProxyCaptureStoreAsync>>;
const leases: Lease[] = [];
const databasePaths = new Set<string>();
afterEach(async () => {
  try {
    for (const lease of leases.splice(0).toReversed()) {
      await lease.release();
    }
    for (const dbPath of databasePaths) {
      await closeOpenClawStateDatabaseByPathAsync(dbPath);
    }
    databasePaths.clear();
  } finally {
    vi.restoreAllMocks();
    syncBuiltinESMExports();
    tempDirs.cleanup();
  }
});

async function acquire(env = { OPENCLAW_STATE_DIR: tempDirs.make("capture-async-") }) {
  const lease = await acquireDebugProxyCaptureStoreAsync({ env });
  leases.push(lease);
  databasePaths.add(lease.store.dbPath);
  return lease;
}

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
    const native = requireNodeSqlite();
    const mainThreadWork = [
      vi.spyOn(native.DatabaseSync.prototype, "prepare"),
      vi.spyOn(native.DatabaseSync.prototype, "exec"),
      ...(["get", "all", "run", "iterate"] as const).map((method) =>
        vi.spyOn(StatementSync.prototype, method),
      ),
      vi.spyOn(zlib, "gzipSync"),
      vi.spyOn(zlib, "gunzipSync"),
    ];
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    syncBuiltinESMExports();
    const { store } = await acquire();
    const session = {
      id: "first",
      startedAt: 1,
      mode: "fixture",
      sourceScope: "openclaw" as const,
      sourceProcess: "fixture",
    };
    const sessionWrite = store.upsertSession(session);
    session.sourceProcess = "mutated";
    const bytes = Buffer.from("shared café");
    const payloadWrite = store.persistPayload(bytes, "text/plain");
    const submitted = event("first", "accepted-first");
    const firstWrite = store.recordEventWithPayload(submitted, {
      data: bytes,
      contentType: "text/plain",
      previewLimit: 10,
    });
    submitted.flowId = "mutated";
    bytes.fill(0);
    const secondWrite = store.recordEventWithPayload(event("first", "accepted-second"), {
      data: "shared café",
    });
    const orderedRead = store.getSessionEvents("first");
    await Promise.all([sessionWrite, firstWrite, secondWrite]);
    const rows = await orderedRead;
    expect(rows.map((row) => row.flowId)).toEqual(["accepted-second", "accepted-first"]);
    expect(rows[1]).toMatchObject({ dataText: "shared caf" });
    const blobId = rows[0]!.dataBlobId;
    assert(typeof blobId === "string", "Expected captured blob");
    expect(rows[1]!.dataBlobId).toBe(blobId);
    expect((await payloadWrite).blobId).toBe(blobId);
    expect(await store.readBlob(blobId)).toBe("shared café");
    expect(await store.listSessions()).toMatchObject([
      { id: "first", sourceProcess: "fixture", eventCount: 2 },
    ]);
    await store.recordEventWithPayload(event("second", "shared-reference"), {
      data: "shared café",
    });
    expect(await store.deleteSessions(["first"])).toEqual({ sessions: 1, events: 2, blobs: 0 });
    expect(await store.readBlob(blobId)).toBe("shared café");
    expect(await store.purgeAll()).toEqual({ sessions: 1, events: 1, blobs: 1 });
    expect(await store.getSessionEvents("second")).toEqual([]);
    expect(await store.readBlob(blobId)).toBeNull();
    expect(await store.purgeAll()).toEqual({ sessions: 0, events: 0, blobs: 0 });
    expect(
      messages.mock.contexts.some((worker) => worker instanceof Worker && worker.threadId > 0),
    ).toBe(true);
    for (const work of mainThreadWork) {
      expect(work).not.toHaveBeenCalled();
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
    databasePaths.add(databasePath);
    databasePaths.add(alternatePath);
    expect(await reader.getSessionEvents("reader-session")).toEqual([]);
    expect(await reader.readBlob("missing")).toBeNull();
    expect(existsSync(databasePath)).toBe(false);
    expect(existsSync(alternateEnv.OPENCLAW_STATE_DIR)).toBe(false);

    const { store } = await acquire(originalEnv);
    expect(store.dbPath).toBe(databasePath);
    await store.recordEventWithPayload(event("reader-session", "later-write"), {
      data: "reader payload",
      contentType: "text/plain",
    });
    const rows = await reader.getSessionEvents("reader-session");
    expect(rows).toMatchObject([{ flowId: "later-write", dataText: "reader payload" }]);
    const blobId = rows[0]!.dataBlobId;
    assert(typeof blobId === "string", "Expected captured blob");
    expect(await reader.readBlob(blobId)).toBe("reader payload");
    await withOpenClawStateDatabaseReadSnapshot(
      async () => {
        await store.recordEventWithPayload(event("reader-session", "after-snapshot"), {
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
  });

  it("release joins accepted writes and leaves their durable result readable", async () => {
    const env = { OPENCLAW_STATE_DIR: tempDirs.make("capture-async-close-") };
    const { store, release } = await acquire(env);
    let writeSettled = false;
    const writing = store
      .recordEventWithPayload(event("accepted", "before-close"), { data: "accepted bytes" })
      .then(() => {
        writeSettled = true;
      });
    const closing = release();
    expect(store.close()).toBe(closing);
    await closing;
    expect(writeSettled).toBe(true);
    expect(store.isClosed).toBe(true);
    await writing;
    const reopened = await acquire(env);
    expect(await reopened.store.getSessionEvents("accepted")).toMatchObject([
      { flowId: "before-close", dataText: "accepted bytes" },
    ]);
  });
});
