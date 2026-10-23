import fs from "node:fs";
import path from "node:path";
import { constants } from "node:sqlite";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { OpenClawStateOwnershipError } from "../infra/sqlite-lifecycle-errors.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { claimOpenClawStateOwnership } from "../state/openclaw-state-ownership-operations.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  acquireDebugProxyCaptureStore,
  closeDebugProxyCaptureStore,
  DebugProxyCaptureStore,
  getDebugProxyCaptureStore,
  persistEventPayload,
} from "./store.sqlite.js";
import type { CaptureEventRecord, CaptureQueryPreset, CaptureSessionRecord } from "./types.js";

const cleanupDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) {
    cleanups.pop()!();
  }
  closeDebugProxyCaptureStore();
  closeOpenClawStateDatabaseForTest();
  vi.useRealTimers();
  vi.restoreAllMocks();
  cleanupTempDirs(cleanupDirs);
});

function makeStore(kind: "shared" | "path" = "shared", env = makeStateEnv()) {
  return makeLease(kind, env).store;
}

function makeStateEnv(): NodeJS.ProcessEnv {
  return { OPENCLAW_STATE_DIR: makeTempDir(cleanupDirs, "proxy-capture-") };
}

function storagePaths(env: NodeJS.ProcessEnv) {
  return {
    dbPath: path.join(env.OPENCLAW_STATE_DIR!, "capture.sqlite"),
    blobDir: path.join(env.OPENCLAW_STATE_DIR!, "blobs"),
  };
}

function makeLease(kind: "shared" | "path", env = makeStateEnv()) {
  const { dbPath, blobDir } = storagePaths(env);
  const lease =
    kind === "path"
      ? acquireDebugProxyCaptureStore(dbPath, blobDir)
      : acquireDebugProxyCaptureStore({ env });
  cleanups.push(lease.release);
  return { ...lease, dbPath, blobDir };
}

function deny(store: DebugProxyCaptureStore, action: number, table: string) {
  const db = requireNativeSqliteDatabase(store.db);
  db.setAuthorizer((a, t) =>
    a === action && t === table ? constants.SQLITE_DENY : constants.SQLITE_OK,
  );
  const allow = () => db.setAuthorizer(null);
  cleanups.push(allow);
  return allow;
}

function upsertSession(store: DebugProxyCaptureStore, overrides: Partial<CaptureSessionRecord>) {
  store.upsertSession({
    id: "session-1",
    startedAt: 1,
    mode: "proxy-run",
    sourceScope: "openclaw",
    sourceProcess: "openclaw",
    ...overrides,
  });
}

function makeEvent(overrides: Partial<CaptureEventRecord>): CaptureEventRecord {
  return {
    sessionId: "session-1",
    ts: 1,
    sourceScope: "openclaw",
    sourceProcess: "openclaw",
    protocol: "https",
    direction: "outbound",
    kind: "request",
    flowId: "flow-1",
    ...overrides,
  };
}

function recordEvent(store: DebugProxyCaptureStore, overrides: Partial<CaptureEventRecord>) {
  store.recordEvent(makeEvent(overrides));
}

function recordPayload(store: DebugProxyCaptureStore, sessionId: string, data: string) {
  const blob = store.persistPayload(Buffer.from(data), "text/plain");
  recordEvent(store, { sessionId, dataBlobId: blob.blobId, dataSha256: blob.sha256 });
  return blob;
}

function observed(...entries: Array<[string, number]>) {
  return entries.map(([value, count]) => ({ value, count }));
}

function readMode(target: string): number {
  return fs.statSync(target).mode & 0o777;
}

describe("DebugProxyCaptureStore", () => {
  it.each(["shared", "path"] as const)(
    "summarizes %s capture labels without materializing every metadata row",
    (kind) => {
      const store = makeStore(kind);
      const events = [
        { host: " localhost:7 ", metaJson: '{"provider":" alpha ","api":"chat","model":"one"}' },
        { host: "localhost:7", metaJson: '{"provider":"alpha","api":"chat","model":"two"}' },
        { host: "remote", metaJson: '{"provider":"beta","api":"other","model":"two"}' },
        { host: "localhost", metaJson: '{"provider":1,"api":[],"model":false}' },
        { host: "LOCALHOST:7", metaJson: "invalid" },
        { host: "[::1]:7", metaJson: "[]" },
        { metaJson: " " },
        {},
        { metaJson: "null" },
        { metaJson: "42" },
        { metaJson: '"text"' },
        { host: "remote", metaJson: '{"provider":"gamma","api":" ","model":""}' },
      ];
      for (const [index, metadata] of [
        ...events,
        { metaJson: '{"provider":"excluded"}' },
      ].entries()) {
        recordEvent(store, {
          sessionId: index < events.length ? "coverage" : "other",
          ...metadata,
        });
      }
      const db = requireNativeSqliteDatabase(store.db);
      const prepare = db.prepare.bind(db);
      const materializations: MockInstance[] = [];
      vi.spyOn(db, "prepare").mockImplementation((sql) => {
        const statement = prepare(sql);
        materializations.push(vi.spyOn(statement, "all"));
        return statement;
      });

      const summary = store.summarizeSessionCoverage("coverage");

      expect(summary).toMatchObject({
        sessionId: "coverage",
        totalEvents: 12,
        unlabeledEventCount: 8,
        providers: observed(["alpha", 2], ["beta", 1], ["gamma", 1]),
        apis: observed(["chat", 2], ["other", 1]),
        models: observed(["two", 2], ["one", 1]),
        localPeers: observed(["localhost:7", 2]),
      });
      expect(Object.fromEntries(summary.hosts.map(({ value, count }) => [value, count]))).toEqual({
        "localhost:7": 2,
        remote: 2,
        localhost: 1,
        "LOCALHOST:7": 1,
        "[::1]:7": 1,
      });
      expect(store.summarizeSessionCoverage("missing")).toEqual({
        sessionId: "missing",
        totalEvents: 0,
        unlabeledEventCount: 0,
        providers: [],
        apis: [],
        models: [],
        hosts: [],
        localPeers: [],
      });
      for (const materialization of materializations) {
        expect(materialization).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps the cached store open until the last lease releases", () => {
    const options = { env: makeStateEnv() };

    const first = acquireDebugProxyCaptureStore(options);
    const second = acquireDebugProxyCaptureStore(options);

    expect(second.store).toBe(first.store);
    first.release();
    expect(first.store.isClosed).toBe(false);

    second.release();
    expect(first.store.isClosed).toBe(true);
    first.store.close();
    expect(first.store.isClosed).toBe(true);

    const reopened = getDebugProxyCaptureStore(options);
    expect(Object.is(reopened, first.store)).toBe(false);
    expect(reopened.isClosed).toBe(false);
  });

  it.each(["quiet", "active"] as const)(
    "retains %s capture through idle expiry and releases its native handle after close",
    (activity) => {
      const options = { env: makeStateEnv() };
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const store = getDebugProxyCaptureStore(options);
      const intervals =
        activity === "quiet"
          ? [SQLITE_IDLE_HANDLE_TTL_MS + 1]
          : [SQLITE_IDLE_HANDLE_TTL_MS / 2 + 1, SQLITE_IDLE_HANDLE_TTL_MS / 2 + 1];
      for (const [index, interval] of intervals.entries()) {
        vi.advanceTimersByTime(interval);
        recordEvent(store, {
          sessionId: "retained-capture",
          ts: index,
          sourceProcess: "test",
          flowId: `retained-${index}`,
        });
      }
      expect(store.getSessionEvents("retained-capture").map((event) => event.flowId)).toEqual(
        intervals.map((_, index) => `retained-${index}`).toReversed(),
      );
      store.close();
      expect(store.db.isOpen).toBe(true);
      vi.advanceTimersByTime(SQLITE_IDLE_HANDLE_TTL_MS - 1);
      expect(store.db.isOpen).toBe(true);
      vi.advanceTimersByTime(1);
      expect(store.db.isOpen).toBe(false);

      const reopened = getDebugProxyCaptureStore(options);
      expect(reopened.getSessionEvents("retained-capture").map((event) => event.flowId)).toEqual(
        intervals.map((_, index) => `retained-${index}`).toReversed(),
      );
    },
  );

  it("rebinds a cached shared store after the state database closes underneath it", () => {
    const options = { env: makeStateEnv() };
    const stale = getDebugProxyCaptureStore(options);
    upsertSession(stale, { id: "exit-session", sourceProcess: "cli" });

    closeOpenClawStateDatabaseForTest();
    expect(stale.isClosed).toBe(true);

    const rebound = getDebugProxyCaptureStore(options);
    expect(Object.is(rebound, stale)).toBe(false);
    expect(() => rebound.endSession("exit-session")).not.toThrow();
  });

  it("fences a shared store that was opened before external ownership was claimed", () => {
    const env = makeStateEnv();
    const store = new DebugProxyCaptureStore({ env });
    env.OPENCLAW_SUPERVISOR_MODE = "external";
    claimOpenClawStateOwnership("gateway-supervisor", { env });
    delete env.OPENCLAW_SUPERVISOR_MODE;

    expect(() => upsertSession(store, { id: "preclaim-session", sourceProcess: "cli" })).toThrow(
      OpenClawStateOwnershipError,
    );
  });

  it("tracks and closes cached stores independently across paths", () => {
    const first = acquireDebugProxyCaptureStore({ env: makeStateEnv() });
    const second = acquireDebugProxyCaptureStore({ env: makeStateEnv() });

    first.release();
    expect(first.store.isClosed).toBe(true);
    expect(second.store.isClosed).toBe(false);

    closeDebugProxyCaptureStore();
    expect(second.store.isClosed).toBe(true);
    second.release();
  });

  it("preserves the shipped path-based Plugin SDK overloads", () => {
    const { store, release, dbPath, blobDir } = makeLease("path");
    store.db.exec(`
      CREATE TABLE config_machine_state (
        state_key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      INSERT INTO config_machine_state VALUES ('gateway.supervision', '{"malformed":true}', 1);
    `);

    expect(getDebugProxyCaptureStore(dbPath, blobDir)).toBe(store);
    upsertSession(store, {
      id: "legacy-sdk-session",
      mode: "sdk",
      sourceProcess: "plugin",
      dbPath,
      blobDir,
    });
    upsertSession(store, {
      id: "legacy-sdk-session",
      startedAt: 0,
      mode: "replacement",
      sourceProcess: "updated-plugin",
      dbPath: "unused-database",
      blobDir: "unused-blobs",
    });
    expect(store.listSessions()).toMatchObject([
      {
        startedAt: 1,
        mode: "sdk",
        sourceProcess: "updated-plugin",
        endedAt: null,
        proxyUrl: null,
      },
    ]);
    const blob = recordPayload(store, "legacy-sdk-session", "legacy sdk payload");

    expect(store.readBlob(blob.blobId)).toBe("legacy sdk payload");
    const blobPath = path.join(blobDir, `${blob.blobId}.bin.gz`);
    expect(blob.path).toBe(blobPath);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(blobPath)).toBe(true);
    expect(
      store.db
        .prepare("SELECT db_path AS dbPath, blob_dir AS blobDir FROM capture_sessions WHERE id = ?")
        .get("legacy-sdk-session"),
    ).toEqual({ dbPath, blobDir });
    expect(
      store.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'capture_blobs'")
        .get(),
    ).toBeUndefined();
    store.db.exec("DROP TABLE config_machine_state;");
    expect(
      store.db
        .prepare(
          `SELECT name, strict FROM pragma_table_list
           WHERE schema = 'main' AND type = 'table' AND name NOT LIKE 'sqlite_%'
           ORDER BY name`,
        )
        .all(),
    ).toEqual([
      { name: "capture_events", strict: 1 },
      { name: "capture_sessions", strict: 1 },
    ]);
    expect(store.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(store.deleteSessions(["legacy-sdk-session"])).toEqual({
      sessions: 1,
      events: 1,
      blobs: 1,
    });
    expect(fs.existsSync(blobPath)).toBe(false);

    release();
    expect(store.isClosed).toBe(true);
  });

  it.each([
    ["path", "deleteSessions", "capture_sessions"],
    ["path", "purgeAll", "capture_sessions"],
    ["shared", "deleteSessions", "capture_sessions"],
    ["shared", "purgeAll", "capture_sessions"],
    ["shared", "deleteSessions", "capture_blobs"],
    ["shared", "purgeAll", "capture_blobs"],
  ] as const)("rolls back %s %s when %s deletion fails", (kind, operation, deniedTable) => {
    const { store, dbPath, blobDir } = makeLease(kind);
    const sessionId = "rollback-session";

    upsertSession(store, { id: sessionId, dbPath, blobDir });
    const blob = recordPayload(store, sessionId, "rollback payload");
    const blobPath = path.join(blobDir, `${blob.blobId}.bin.gz`);

    const cleanup = () =>
      operation === "deleteSessions" ? store.deleteSessions([sessionId]) : store.purgeAll();
    const allow = deny(store, constants.SQLITE_DELETE, deniedTable);

    if (deniedTable === "capture_blobs" && operation === "deleteSessions") {
      expect(() => store.deleteSessions(["missing"])).toThrow(/not authorized/u);
    }
    expect(cleanup).toThrow(/not authorized/u);
    allow();
    expect(store.listSessions()).toHaveLength(1);
    expect(store.getSessionEvents(sessionId)).toHaveLength(1);
    expect(store.readBlob(blob.blobId)).toBe("rollback payload");
    if (kind === "path") {
      expect(fs.existsSync(blobPath)).toBe(true);
    }

    expect(cleanup()).toEqual({ sessions: 1, events: 1, blobs: 1 });
    expect(store.listSessions()).toEqual([]);
    expect(store.getSessionEvents(sessionId)).toEqual([]);
    expect(store.readBlob(blob.blobId)).toBeNull();
    if (kind === "path") {
      expect(fs.existsSync(blobPath)).toBe(false);
    }
    expect(cleanup()).toEqual({ sessions: 0, events: 0, blobs: 0 });
  });

  it("uses rollback journaling for captures on NFS-backed volumes", () => {
    const stats = fs.statfsSync(".");
    stats.type = 0x6969;
    vi.spyOn(fs, "statfsSync").mockReturnValue(stats);

    const store = makeStore();
    expect(store.db.prepare("PRAGMA journal_mode").get()).toMatchObject({
      journal_mode: "delete",
    });
  });

  it.each(["shared", "path"] as const)(
    "retries a rejected %s event without retaining an implicit session",
    (kind) => {
      const { store } = makeLease(kind);
      const rejectedEvent = makeEvent({
        sessionId: "rejected-event",
        ts: 7,
        sourceProcess: "capture-test",
        protocol: "wss",
        direction: "inbound",
        kind: "ws-close",
        flowId: "write-flow",
        status: 429,
        closeCode: 1001,
        headersJson: '{"x-fixture":"header"}',
        dataText: "preview",
        dataSha256: "payload-hash",
        errorText: "fixture error",
        metaJson: '{"fixture":true}',
      });
      const allow = deny(store, constants.SQLITE_INSERT, "capture_events");
      expect(() => store.recordEvent(rejectedEvent)).toThrow(/not authorized/u);
      allow();
      expect(store.listSessions()).toEqual([]);
      expect(store.getSessionEvents(rejectedEvent.sessionId)).toEqual([]);

      store.recordEvent(rejectedEvent);

      expect(store.getSessionEvents(rejectedEvent.sessionId)).toMatchObject([
        { ...rejectedEvent, dataBlobId: null },
      ]);
      expect(store.listSessions()).toHaveLength(kind === "shared" ? 1 : 0);
    },
  );

  it.runIf(process.platform !== "win32")(
    "stores capture blobs in the private shared state database",
    () => {
      const env = makeStateEnv();
      const root = env.OPENCLAW_STATE_DIR!;
      const store = makeStore("shared", env);
      const blob = store.persistPayload(Buffer.from("authorization: Bearer secret"));
      const row = store.db
        .prepare(
          `SELECT encoding, size_bytes AS sizeBytes, sha256, data
           FROM capture_blobs
           WHERE blob_id = ?`,
        )
        .get(blob.blobId) as
        | { data: Uint8Array; encoding: string; sha256: string; sizeBytes: number }
        | undefined;

      expect(store.dbPath).toBe(path.join(root, "state", "openclaw.sqlite"));
      expect(fs.existsSync(path.join(root, "debug-proxy", "capture.sqlite"))).toBe(false);
      expect(fs.existsSync(path.join(root, "debug-proxy", "blobs"))).toBe(false);
      expect(row).toMatchObject({
        encoding: "gzip",
        sha256: blob.sha256,
        sizeBytes: blob.sizeBytes,
      });
      expect(Buffer.from(row?.data ?? []).toString("utf8")).not.toContain("Bearer secret");
      expect(readMode(path.dirname(store.dbPath))).toBe(0o700);
      for (const databaseFile of resolveSqliteDatabaseFilePaths(store.dbPath).filter(
        fs.existsSync,
      )) {
        expect(readMode(databaseFile)).toBe(0o600);
      }
    },
  );

  it("stores sessions and deduplicates complete payloads", () => {
    const store = makeStore();
    upsertSession(store, { startedAt: Date.now() });
    const firstPayload = persistEventPayload(store, {
      data: '{"ok":true}',
      contentType: "application/json",
    });
    const firstBlob = store.db
      .prepare("SELECT * FROM capture_blobs WHERE blob_id = ?")
      .get(firstPayload.dataBlobId ?? "");
    const duplicateBlob = store.persistPayload(Buffer.from('{"ok":true}'), "text/plain");
    expect(duplicateBlob).toMatchObject({
      blobId: firstPayload.dataBlobId,
      contentType: "text/plain",
    });
    expect(
      store.db.prepare("SELECT * FROM capture_blobs WHERE blob_id = ?").get(duplicateBlob.blobId),
    ).toEqual(firstBlob);
    recordEvent(store, firstPayload);
    expect(store.listSessions(10)).toHaveLength(1);
    expect(store.readBlob(firstPayload.dataBlobId ?? "")).toContain('"ok":true');
  });

  it.each(["shared", "path"] as const)(
    "preserves %s diagnostic grouping, session scope, and native read retries",
    (kind) => {
      const store = makeStore(kind);
      const record = (overrides: Partial<CaptureEventRecord>) =>
        recordEvent(store, {
          sessionId: "captured",
          sourceProcess: "test",
          flowId: "cross-session",
          host: "api.example",
          path: "/send",
          method: "POST",
          ...overrides,
        });
      for (const [index, id] of ["captured", "other", "empty"].entries()) {
        upsertSession(store, { id, startedAt: index, mode: "test", sourceProcess: "test" });
      }
      for (const eventKind of ["request", "ws-frame"] as const) {
        for (const dataSha256 of ["first", "second"]) {
          record({ kind: eventKind, dataSha256 });
          record({ kind: eventKind, dataSha256 });
        }
      }
      for (const status of [428, 429, 500]) {
        record({ kind: "response", direction: "inbound", status });
      }
      record({ path: "/cache?variant" });
      record({ path: "/cache", headersJson: "CACHE-CONTROL" });
      record({ path: "/pragma", headersJson: "pragma" });
      record({ sessionId: "other", kind: "ws-frame", direction: "inbound" });
      record({ kind: "error", host: undefined, path: undefined });
      const presets: CaptureQueryPreset[] = [
        "double-sends",
        "retry-storms",
        "cache-busting",
        "ws-duplicate-frames",
        "missing-ack",
        "error-bursts",
      ];
      const location = { host: "api.example", path: "/send" };
      const queryPresets = () =>
        Object.fromEntries(
          presets.map((preset) => [preset, store.queryPreset(preset, "captured")]),
        );
      const results = queryPresets();
      expect(results).toEqual({
        "double-sends": [
          { ...location, method: "POST", duplicateCount: 2 },
          { ...location, method: "POST", duplicateCount: 2 },
        ],
        "retry-storms": [{ ...location, errorCount: 2 }],
        "cache-busting": expect.arrayContaining([
          { host: "api.example", path: "/cache", variantCount: 1 },
          { host: "api.example", path: "/cache?variant", variantCount: 1 },
          { host: "api.example", path: "/pragma", variantCount: 1 },
        ]),
        "ws-duplicate-frames": [
          { ...location, duplicateFrames: 2 },
          { ...location, duplicateFrames: 2 },
        ],
        "missing-ack": [{ flowId: "cross-session", ...location, outboundFrames: 4 }],
        "error-bursts": [{ host: null, path: null, errorCount: 1 }],
      });
      expect(results["cache-busting"]).toHaveLength(3);
      expect(store.queryPreset("missing-ack")).toEqual([]);
      expect(store.queryPreset("missing-ack", "")).toEqual([]);
      expect(store.queryPreset("error-bursts", " captured ")).toEqual([]);
      expect(store.listSessions(1)).toEqual([
        {
          id: "empty",
          startedAt: 2,
          endedAt: null,
          mode: "test",
          sourceProcess: "test",
          proxyUrl: null,
          eventCount: 0,
        },
      ]);
      for (const id of ["empty-z", "empty-a"]) {
        upsertSession(store, { id, startedAt: 2, mode: "test", sourceProcess: "test" });
      }
      expect(store.listSessions(2).map(({ id, eventCount }) => ({ id, eventCount }))).toEqual([
        { id: "empty", eventCount: 0 },
        { id: "empty-a", eventCount: 0 },
      ]);
      expect(store.listSessions(0)).toEqual([]);
      expect(store.listSessions(-1)).toHaveLength(5);

      const allow = deny(store, constants.SQLITE_READ, "capture_events");
      for (const preset of presets) {
        expect(() => store.queryPreset(preset, "captured")).toThrow(/prohibited/u);
      }
      expect(() => store.listSessions()).toThrow(/prohibited/u);
      expect(store.db.isOpen).toBe(true);
      allow();
      expect(queryPresets()).toEqual(results);
    },
  );

  it("keeps byte-limited UTF-8 previews on a complete character boundary", () => {
    const store = makeStore();
    const data = `${"x".repeat(8191)}étail`;

    const payload = persistEventPayload(store, { data });

    expect(payload.dataText).toBe("x".repeat(8191));
    expect(Buffer.byteLength(payload.dataText ?? "", "utf8")).toBeLessThanOrEqual(8192);
    expect(store.readBlob(payload.dataBlobId ?? "")).toBe(data);
  });

  it("creates and later upgrades an implicit session for direct event capture", () => {
    const store = makeStore();
    recordEvent(store, {
      sessionId: "session-direct",
      ts: 20,
      sourceProcess: "provider",
      flowId: "flow-direct",
      dataBlobId: "already-purged",
    });

    expect(store.listSessions(10)[0]).toMatchObject({ id: "session-direct", mode: "implicit" });
    expect(store.getSessionEvents("session-direct", 10)[0]).toMatchObject({ dataBlobId: null });
    recordEvent(store, {
      sessionId: "session-direct",
      sourceProcess: "another-provider",
      flowId: "earlier-flow",
      dataBlobId: "",
    });
    expect(store.listSessions()[0]).toMatchObject({ startedAt: 20, mode: "implicit" });
    expect(store.getSessionEvents("session-direct").map((event) => event.dataBlobId)).toEqual([
      null,
      null,
    ]);

    upsertSession(store, {
      id: "session-direct",
      startedAt: 10,
      mode: "runtime",
      endedAt: 40,
      proxyUrl: "http://synthetic.invalid",
    });
    upsertSession(store, {
      id: "session-direct",
      startedAt: 30,
      mode: "replacement",
      sourceProcess: "updated-process",
    });

    expect(store.listSessions(10)[0]).toMatchObject({
      id: "session-direct",
      mode: "runtime",
      startedAt: 10,
      endedAt: null,
      proxyUrl: null,
      sourceProcess: "updated-process",
    });
  });

  it.each(["shared", "path"] as const)("preserves %s blob custody and cleanup counts", (kind) => {
    const env = makeStateEnv();
    const blobDir = path.join(env.OPENCLAW_STATE_DIR!, "blobs");
    const store = makeStore(kind, env);
    const sharedPayload = persistEventPayload(store, {
      data: '{"shared":true}',
      contentType: "application/json",
    });

    for (const sessionId of ["session-a", "session-b"]) {
      upsertSession(store, { id: sessionId, startedAt: Date.now() });
      recordEvent(store, { sessionId, ...sharedPayload });
    }

    const result = store.deleteSessions([" session-a ", "session-a", "", " "]);

    expect(result).toEqual({ sessions: 1, events: 1, blobs: 0 });
    expect(store.readBlob(sharedPayload.dataBlobId ?? "")).toContain('"shared":true');
    expect(store.listSessions(10).map((session) => session.id)).toEqual(["session-b"]);

    expect(store.deleteSessions(["session-b"])).toEqual({ sessions: 1, events: 1, blobs: 1 });
    expect(store.readBlob(sharedPayload.dataBlobId ?? "")).toBeNull();
    store.persistPayload(Buffer.from("unreferenced capture"));
    if (kind === "path") {
      fs.writeFileSync(path.join(blobDir, "extra-artifact.txt"), "capture artifact");
    }
    expect(store.purgeAll()).toEqual({ sessions: 0, events: 0, blobs: kind === "path" ? 2 : 1 });
    if (kind === "path") {
      expect(fs.readdirSync(blobDir)).toEqual([]);
    }
    expect(store.purgeAll()).toEqual({ sessions: 0, events: 0, blobs: 0 });
  });
});
