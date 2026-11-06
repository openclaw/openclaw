import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
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

const write = (store: Lease["store"], sessionId: string, flowId: string, data: string) =>
  store.recordEventWithPayload(event(sessionId, flowId), { data });

describe("async capture store", () => {
  it("persists immutable FIFO input off the main thread", async () => {
    const mainThreadWork = [
      ...observeMainThreadSql().calls,
      vi.spyOn(zlib, "gzipSync"),
      vi.spyOn(zlib, "gunzipSync"),
    ];
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
    const secondWrite = write(store, "first", "accepted-second", "shared café");
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
    expect(await store.deleteSessions(["first"])).toEqual({ sessions: 1, events: 2, blobs: 1 });
    expect(await store.purgeAll()).toEqual({ sessions: 0, events: 0, blobs: 0 });
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
    await store.recordEventWithPayload(event("reader-session", "later-write"), {
      data: "reader payload",
      contentType: "text/plain",
    });
    const rows = await reader.getSessionEvents("reader-session");
    expect(rows).toMatchObject([{ flowId: "later-write", dataText: "reader payload" }]);
    const blobId = rows[0]!.dataBlobId;
    assert(typeof blobId === "string", "Expected captured blob");
    expect(await reader.readBlob(blobId)).toBe("reader payload");
    expect(existsSync(alternateEnv.OPENCLAW_STATE_DIR)).toBe(false);
  });
});
