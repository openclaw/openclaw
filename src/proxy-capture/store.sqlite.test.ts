// Proxy capture SQLite store tests cover persisted capture reads and writes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listOpenFileDescriptorsForPath } from "../infra/open-file-descriptors.test-support.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import {
  acquireDebugProxyCaptureStore,
  closeDebugProxyCaptureStore,
  DebugProxyCaptureStore,
  getDebugProxyCaptureStore,
  persistEventPayload,
} from "./store.sqlite.js";

const cleanupDirs: string[] = [];

afterEach(() => {
  closeDebugProxyCaptureStore();
  vi.restoreAllMocks();
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeStore() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-"));
  cleanupDirs.push(root);
  return new DebugProxyCaptureStore(path.join(root, "capture.sqlite"), path.join(root, "blobs"));
}

function readMode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe("DebugProxyCaptureStore", () => {
  it.each([
    ":memory:",
    "file::memory:?cache=shared",
    "file:%3Amemory:?cache=shared",
    "file:proxy-capture?mode=memory&cache=shared",
    "file:proxy-capture?mode=memory#ignored",
  ])(
    "keeps SQLite memory path %s off the filesystem",
    (dbPath) => {
      const mkdirSync = vi.spyOn(fs, "mkdirSync");
      const openSync = vi.spyOn(fs, "openSync");
      const existsSync = vi.spyOn(fs, "existsSync");

      const store = new DebugProxyCaptureStore(dbPath, "unused");
      try {
        expect(store.db.prepare("PRAGMA database_list").get()).toMatchObject({ file: "" });
        expect(mkdirSync).not.toHaveBeenCalled();
        expect(openSync).not.toHaveBeenCalled();
        expect(existsSync).not.toHaveBeenCalled();
      } finally {
        store.close();
      }
    },
  );

  it.runIf(process.platform === "linux")("closes the database when initialization fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-failed-open-"));
    cleanupDirs.push(root);
    const dbPath = path.join(root, "capture.sqlite");
    fs.writeFileSync(dbPath, "not a sqlite database");

    expect(() => new DebugProxyCaptureStore(dbPath, path.join(root, "blobs"))).toThrow(
      "file is not a database",
    );
    expect(listOpenFileDescriptorsForPath(dbPath)).toEqual([]);
  });

  it("keeps the cached store open until the last lease releases", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-lease-"));
    cleanupDirs.push(root);
    const dbPath = path.join(root, "capture.sqlite");
    const blobDir = path.join(root, "blobs");

    const first = acquireDebugProxyCaptureStore(dbPath, blobDir);
    const second = acquireDebugProxyCaptureStore(dbPath, blobDir);

    expect(second.store).toBe(first.store);
    first.release();
    expect(first.store.isClosed).toBe(false);

    second.release();
    expect(first.store.isClosed).toBe(true);

    const reopened = getDebugProxyCaptureStore(dbPath, blobDir);
    expect(Object.is(reopened, first.store)).toBe(false);
    expect(reopened.isClosed).toBe(false);
  });

  it("tracks and closes cached stores independently across paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-paths-"));
    cleanupDirs.push(root);
    const first = acquireDebugProxyCaptureStore(
      path.join(root, "first.sqlite"),
      path.join(root, "first-blobs"),
    );
    const second = acquireDebugProxyCaptureStore(
      path.join(root, "second.sqlite"),
      path.join(root, "second-blobs"),
    );

    first.release();
    expect(first.store.isClosed).toBe(true);
    expect(second.store.isClosed).toBe(false);

    closeDebugProxyCaptureStore();
    expect(second.store.isClosed).toBe(true);
    second.release();
  });

  it("uses rollback journaling for captures on NFS-backed volumes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-nfs-"));
    cleanupDirs.push(root);
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      type: 0x6969,
      bsize: 1024,
      blocks: 1,
      bfree: 1,
      bavail: 1,
      files: 0,
      ffree: 0,
    });

    const store = new DebugProxyCaptureStore(
      path.join(root, "capture.sqlite"),
      path.join(root, "blobs"),
    );
    try {
      expect(store.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
        journal_mode: "delete",
      });
    } finally {
      store.close();
    }
  });

  it.runIf(process.platform !== "win32")("keeps capture databases and blobs private", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-proxy-capture-permissions-"));
    cleanupDirs.push(root);
    const dbDir = path.join(root, "db");
    const dbPath = path.join(dbDir, "capture.sqlite");
    const blobDir = path.join(root, "blobs");
    const store = new DebugProxyCaptureStore(dbPath, blobDir);
    const blob = store.persistPayload(Buffer.from("authorization: Bearer secret"));

    expect(readMode(dbDir)).toBe(0o700);
    expect(readMode(blobDir)).toBe(0o700);
    for (const databaseFile of resolveSqliteDatabaseFilePaths(dbPath).filter(fs.existsSync)) {
      expect(readMode(databaseFile)).toBe(0o600);
    }
    expect(readMode(blob.path)).toBe(0o600);

    store.close();
    fs.chmodSync(dbPath, 0o644);
    fs.chmodSync(blob.path, 0o644);
    const reopened = new DebugProxyCaptureStore(dbPath, blobDir);
    reopened.persistPayload(Buffer.from("authorization: Bearer secret"));
    expect(readMode(dbPath)).toBe(0o600);
    expect(readMode(blob.path)).toBe(0o600);
    reopened.close();
  });

  it("ignores duplicate close calls", () => {
    const store = makeStore();

    store.close();
    store.close();
    expect(store.isClosed).toBe(true);
  });

  it("stores sessions, blobs, and duplicate-send query results", () => {
    const store = makeStore();
    store.upsertSession({
      id: "session-1",
      startedAt: Date.now(),
      mode: "proxy-run",
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      dbPath: store.dbPath,
      blobDir: store.blobDir,
    });
    const firstPayload = persistEventPayload(store, {
      data: '{"ok":true}',
      contentType: "application/json",
    });
    store.recordEvent({
      sessionId: "session-1",
      ts: 1,
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-1",
      method: "POST",
      host: "api.example.com",
      path: "/v1/send",
      ...firstPayload,
    });
    store.recordEvent({
      sessionId: "session-1",
      ts: 2,
      sourceScope: "openclaw",
      sourceProcess: "openclaw",
      protocol: "https",
      direction: "outbound",
      kind: "request",
      flowId: "flow-2",
      method: "POST",
      host: "api.example.com",
      path: "/v1/send",
      ...firstPayload,
    });

    expect(store.listSessions(10)).toHaveLength(1);
    const duplicateRows = store.queryPreset("double-sends", "session-1");
    expect(duplicateRows).toHaveLength(1);
    expect(duplicateRows[0]?.host).toBe("api.example.com");
    expect(duplicateRows[0]?.path).toBe("/v1/send");
    expect(duplicateRows[0]?.method).toBe("POST");
    expect(duplicateRows[0]?.duplicateCount).toBe(2);
    expect(store.readBlob(firstPayload.dataBlobId ?? "")).toContain('"ok":true');
  });

  it("keeps shared blobs when deleting one of multiple referencing sessions", () => {
    const store = makeStore();
    const sharedPayload = persistEventPayload(store, {
      data: '{"shared":true}',
      contentType: "application/json",
    });

    for (const sessionId of ["session-a", "session-b"]) {
      store.upsertSession({
        id: sessionId,
        startedAt: Date.now(),
        mode: "proxy-run",
        sourceScope: "openclaw",
        sourceProcess: "openclaw",
        dbPath: store.dbPath,
        blobDir: store.blobDir,
      });
      store.recordEvent({
        sessionId,
        ts: Date.now(),
        sourceScope: "openclaw",
        sourceProcess: "openclaw",
        protocol: "https",
        direction: "outbound",
        kind: "request",
        flowId: `flow-${sessionId}`,
        method: "POST",
        host: "api.example.com",
        path: "/v1/shared",
        ...sharedPayload,
      });
    }

    const result = store.deleteSessions(["session-a"]);

    expect(result.sessions).toBe(1);
    expect(result.events).toBe(1);
    expect(result.blobs).toBe(0);
    expect(store.readBlob(sharedPayload.dataBlobId ?? "")).toContain('"shared":true');
    expect(store.listSessions(10).map((session) => session.id)).toEqual(["session-b"]);
  });
});
