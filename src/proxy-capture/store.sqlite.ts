// Proxy capture SQLite store persists capture metadata and replayable exchanges.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { resolveSqliteDatabaseFilePaths } from "../infra/sqlite-files.js";
import { migrateSqliteSchemaToStrict } from "../infra/sqlite-strict.js";
import {
  configureSqliteConnectionPragmas,
  registerSqliteCacheExitClose,
  type SqliteWalMaintenance,
} from "../infra/sqlite-wal.js";
import { retainOpenClawStateDatabaseForIdle } from "../state/openclaw-state-db-cache.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { finalizeCaptureStore } from "./store-lifecycle.js";
import {
  DEBUG_PROXY_CAPTURE_DIR_MODE,
  DEBUG_PROXY_CAPTURE_FILE_MODE,
  DebugProxyCaptureKernel,
} from "./store.kernel.js";
import type { CaptureBlobRecord, SharedCaptureBlobRecord } from "./types.js";

// Capture rows and compressed payload BLOBs live in the shared global state DB.
type DebugProxyCaptureStoreOptions = {
  env?: NodeJS.ProcessEnv;
};

type PathBasedDebugProxyCaptureStore = {
  blobDir: string;
  walMaintenance: SqliteWalMaintenance;
};

const DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_VERSION = 1;
const DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS capture_sessions (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    mode TEXT NOT NULL,
    source_scope TEXT NOT NULL,
    source_process TEXT NOT NULL,
    proxy_url TEXT,
    db_path TEXT NOT NULL,
    blob_dir TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS capture_events (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    source_scope TEXT NOT NULL,
    source_process TEXT NOT NULL,
    protocol TEXT NOT NULL,
    direction TEXT NOT NULL,
    kind TEXT NOT NULL,
    flow_id TEXT NOT NULL,
    method TEXT,
    host TEXT,
    path TEXT,
    status INTEGER,
    close_code INTEGER,
    content_type TEXT,
    headers_json TEXT,
    data_text TEXT,
    data_blob_id TEXT,
    data_sha256 TEXT,
    error_text TEXT,
    meta_json TEXT
  ) STRICT;
  CREATE INDEX IF NOT EXISTS capture_events_session_ts_idx ON capture_events(session_id, ts);
  CREATE INDEX IF NOT EXISTS capture_events_flow_idx ON capture_events(flow_id, ts);
`;

function isInMemoryDatabasePath(dbPath: string): boolean {
  if (dbPath === ":memory:") {
    return true;
  }
  if (!dbPath.startsWith("file:")) {
    return false;
  }
  const fragmentIndex = dbPath.indexOf("#");
  const uriWithoutFragment = fragmentIndex === -1 ? dbPath : dbPath.slice(0, fragmentIndex);
  const queryIndex = uriWithoutFragment.indexOf("?");
  const uriPath = queryIndex === -1 ? uriWithoutFragment : uriWithoutFragment.slice(0, queryIndex);
  try {
    if (decodeURIComponent(uriPath.slice("file:".length)) === ":memory:") {
      return true;
    }
  } catch {
    // Malformed escapes cannot identify a memory URI; retain file-backed handling.
  }
  return (
    queryIndex !== -1 &&
    new URLSearchParams(uriWithoutFragment.slice(queryIndex + 1)).get("mode") === "memory"
  );
}

function hardenLegacyDatabaseFiles(dbPath: string): void {
  for (const candidate of resolveSqliteDatabaseFilePaths(dbPath)) {
    if (fs.existsSync(candidate)) {
      applyPrivateModeSync(candidate, DEBUG_PROXY_CAPTURE_FILE_MODE);
    }
  }
}

function openPathBasedDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): { db: DatabaseSync; pathBased: PathBasedDebugProxyCaptureStore } {
  const fileBackedPath = isInMemoryDatabasePath(dbPath) ? undefined : dbPath;
  if (fileBackedPath) {
    fs.mkdirSync(path.dirname(fileBackedPath), {
      recursive: true,
      mode: DEBUG_PROXY_CAPTURE_DIR_MODE,
    });
    if (!fs.existsSync(fileBackedPath)) {
      fs.closeSync(fs.openSync(fileBackedPath, "a", DEBUG_PROXY_CAPTURE_FILE_MODE));
    }
  }
  const db = openNodeSqliteDatabase(dbPath);
  let walMaintenance: SqliteWalMaintenance | undefined;
  try {
    if (fileBackedPath) {
      applyPrivateModeSync(fileBackedPath, DEBUG_PROXY_CAPTURE_FILE_MODE);
    }
    walMaintenance = configureSqliteConnectionPragmas(db, {
      busyTimeoutMs: 5000,
      databaseLabel: "debug-proxy-capture-sdk",
      ...(fileBackedPath ? { databasePath: fileBackedPath } : {}),
      foreignKeys: true,
    });
    const versionRow = db.prepare("PRAGMA user_version").get() as
      | { user_version?: unknown }
      | undefined;
    const schemaVersion = Number(versionRow?.user_version ?? 0);
    if (schemaVersion > DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_VERSION) {
      throw new Error(
        `Legacy debug proxy capture database uses newer schema version ${schemaVersion}; this build supports ${DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_VERSION}`,
      );
    }
    db.exec(DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_SQL);
    if (schemaVersion < DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_VERSION) {
      migrateSqliteSchemaToStrict(db, DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_SQL, {
        databaseLabel: fileBackedPath ?? dbPath,
      });
      db.exec(`PRAGMA user_version = ${DEBUG_PROXY_CAPTURE_LEGACY_SCHEMA_VERSION};`);
    }
    if (fileBackedPath) {
      hardenLegacyDatabaseFiles(fileBackedPath);
    }
    return {
      db,
      pathBased: {
        blobDir,
        walMaintenance,
      },
    };
  } catch (err) {
    walMaintenance?.close();
    db.close();
    throw err;
  }
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

type SharedDebugProxyCaptureState = {
  database: OpenClawStateDatabase;
  env?: NodeJS.ProcessEnv;
};

const sharedDebugProxyCaptureStates = new WeakMap<object, SharedDebugProxyCaptureState>();

function runSharedDebugProxyCaptureWrite<T>(owner: object, operation: () => T): T {
  const shared = sharedDebugProxyCaptureStates.get(owner);
  if (!shared) {
    throw new Error("shared debug proxy capture state is unavailable");
  }
  return runOpenClawStateWriteTransaction(() => operation(), {
    database: shared.database,
    env: shared.env ?? process.env,
  });
}

class DebugProxyCaptureStoreImpl extends DebugProxyCaptureKernel {
  private readonly pathBased?: PathBasedDebugProxyCaptureStore;
  private readonly releaseIdleReference?: () => void;
  private closed: boolean;
  private closing: boolean;

  constructor(
    optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
    legacyBlobDir?: string,
  ) {
    if (typeof optionsOrDbPath === "string") {
      if (!legacyBlobDir) {
        throw new TypeError("legacy debug proxy capture store requires a blob directory");
      }
      const opened = openPathBasedDebugProxyCaptureStore(optionsOrDbPath, legacyBlobDir);
      super({
        db: opened.db,
        dbPath: optionsOrDbPath,
        blobDir: legacyBlobDir,
        pathBased: opened.pathBased,
        runWrite: (operation) => runSharedDebugProxyCaptureWrite(this, operation),
      });
      this.pathBased = opened.pathBased;
      this.closed = false;
      this.closing = false;
      return;
    }
    const database = openOpenClawStateDatabase({ env: optionsOrDbPath.env });
    super({
      db: database.db,
      dbPath: database.path,
      // Retain the shipped public property while shared-state blobs live in this DB.
      blobDir: database.path,
      runWrite: (operation) => runSharedDebugProxyCaptureWrite(this, operation),
    });
    this.closed = false;
    this.closing = false;
    this.releaseIdleReference = retainOpenClawStateDatabaseForIdle(database);
    sharedDebugProxyCaptureStates.set(this, { database, env: optionsOrDbPath.env });
  }

  close(): void {
    if (this.closed || this.closing) {
      return;
    }
    this.closing = true;
    const errors: unknown[] = [];
    for (const close of [
      () => finalizeCaptureStore(this),
      () => this.releaseIdleReference?.(),
      () => this.pathBased?.walMaintenance.close(),
      () => {
        if (this.pathBased && this.db.isOpen) {
          this.db.close();
        }
      },
    ]) {
      try {
        close();
      } catch (error) {
        errors.push(error);
      }
    }
    this.closed = true;
    this.closing = false;
    if (errors.length) {
      throw new AggregateError(errors, "Capture store close failed.");
    }
  }

  get isClosed(): boolean {
    // A store dies with the DatabaseSync it wraps: the shared-path handle can
    // be closed underneath us (exit-time cache close), and the cache must then
    // rebind a fresh store instead of handing out a dead connection.
    return this.closed || !this.db.isOpen;
  }
}

export type DebugProxyCaptureStore = Omit<DebugProxyCaptureStoreImpl, "persistPayload"> & {
  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord | SharedCaptureBlobRecord;
};

type LegacyDebugProxyCaptureStore = Omit<DebugProxyCaptureStoreImpl, "persistPayload"> & {
  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord;
};

type SharedDebugProxyCaptureStore = Omit<DebugProxyCaptureStoreImpl, "persistPayload"> & {
  persistPayload(data: Buffer, contentType?: string): SharedCaptureBlobRecord;
};

type DebugProxyCaptureStoreConstructor = {
  new (dbPath: string, blobDir: string): LegacyDebugProxyCaptureStore;
  new (options?: DebugProxyCaptureStoreOptions): SharedDebugProxyCaptureStore;
};

// The runtime implementation branches on constructor arguments; expose the
// corresponding result type so both shipped constructor contracts stay exact.
export const DebugProxyCaptureStore =
  DebugProxyCaptureStoreImpl as unknown as DebugProxyCaptureStoreConstructor;

type CachedStoreEntry = {
  store: DebugProxyCaptureStoreImpl;
  leases: number;
};

const cachedStores = new Map<string, CachedStoreEntry>();
let unregisterExitClose: (() => void) | null = null;

function resolveDebugProxyCaptureStoreKey(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string,
  legacyBlobDir?: string,
): string {
  return typeof optionsOrDbPath === "string"
    ? `legacy:${optionsOrDbPath}:${legacyBlobDir ?? ""}`
    : `shared:${openOpenClawStateDatabase({ env: optionsOrDbPath.env }).path}`;
}

function getDebugProxyCaptureStoreImpl(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
  legacyBlobDir?: string,
): DebugProxyCaptureStoreImpl {
  const key = resolveDebugProxyCaptureStoreKey(optionsOrDbPath, legacyBlobDir);
  const cached = cachedStores.get(key);
  if (cached && !cached.store.isClosed) {
    return cached.store;
  }
  const store = new DebugProxyCaptureStoreImpl(optionsOrDbPath, legacyBlobDir);
  cachedStores.set(key, { store, leases: 0 });
  // Safety net for legacy path-based stores that own their DatabaseSync;
  // shared-path stores only flip their closed flag here, never the shared DB.
  unregisterExitClose ??= registerSqliteCacheExitClose(closeDebugProxyCaptureStore);
  return store;
}

export function getDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): LegacyDebugProxyCaptureStore;
export function getDebugProxyCaptureStore(
  options?: DebugProxyCaptureStoreOptions,
): SharedDebugProxyCaptureStore;
export function getDebugProxyCaptureStore(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
  legacyBlobDir?: string,
): DebugProxyCaptureStore {
  return getDebugProxyCaptureStoreImpl(optionsOrDbPath, legacyBlobDir);
}

export function closeDebugProxyCaptureStore(): void {
  unregisterExitClose?.();
  unregisterExitClose = null;
  const stores = [...cachedStores.values()];
  cachedStores.clear();
  const errors: unknown[] = [];
  for (const cached of stores) {
    try {
      cached.store.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Capture stores failed to close.");
  }
}

// Lease API keeps one cached capture-store wrapper alive across related
// operations, then releases it without closing the shared state database.
export function acquireDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): {
  store: LegacyDebugProxyCaptureStore;
  release: () => void;
};
export function acquireDebugProxyCaptureStore(options?: DebugProxyCaptureStoreOptions): {
  store: SharedDebugProxyCaptureStore;
  release: () => void;
};
export function acquireDebugProxyCaptureStore(
  optionsOrDbPath: DebugProxyCaptureStoreOptions | string = {},
  legacyBlobDir?: string,
): {
  store: DebugProxyCaptureStore;
  release: () => void;
} {
  const key = resolveDebugProxyCaptureStoreKey(optionsOrDbPath, legacyBlobDir);
  const store = getDebugProxyCaptureStoreImpl(optionsOrDbPath, legacyBlobDir);
  const cached = cachedStores.get(key);
  if (!cached || cached.store !== store) {
    throw new Error("debug proxy capture store cache changed while acquiring a lease");
  }
  cached.leases += 1;
  let released = false;
  return {
    store,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      const current = cachedStores.get(key);
      if (!current || current.store !== store) {
        return;
      }
      current.leases = Math.max(0, current.leases - 1);
      if (current.leases === 0) {
        cachedStores.delete(key);
        current.store.close();
      }
    },
  };
}

export function persistEventPayload(
  store: {
    persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord | SharedCaptureBlobRecord;
  },
  params: { data?: Buffer | string | null; contentType?: string; previewLimit?: number },
): { dataText?: string; dataBlobId?: string; dataSha256?: string } {
  if (params.data == null) {
    return {};
  }
  const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data);
  const previewLimit = params.previewLimit ?? 8192;
  // Store the whole payload as a blob but keep a small UTF-8 preview inline for
  // fast CLI listings and query output. write(), unlike end(), omits an incomplete
  // trailing code point introduced by the byte cap instead of injecting U+FFFD.
  const blob = store.persistPayload(buffer, params.contentType);
  return {
    dataText: new StringDecoder("utf8").write(buffer.subarray(0, previewLimit)),
    dataBlobId: blob.blobId,
    dataSha256: blob.sha256,
  };
}

export function safeJsonString(value: unknown): string | undefined {
  const raw = serializeJson(value);
  return raw ?? undefined;
}
