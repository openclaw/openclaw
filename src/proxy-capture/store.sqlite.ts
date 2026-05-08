import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { configureSqliteWalMaintenance, type SqliteWalMaintenance } from "../infra/sqlite-wal.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { decodeCaptureBlobText, encodeCaptureBlob } from "./blob-store.js";
import type { DB as ProxyCaptureKyselyDatabase } from "./db.generated.js";
import { PROXY_CAPTURE_SCHEMA_SQL } from "./schema.generated.js";
import type {
  CaptureBlobRecord,
  CaptureEventRecord,
  CaptureObservedDimension,
  CaptureQueryPreset,
  CaptureQueryRow,
  CaptureSessionCoverageSummary,
  CaptureSessionRecord,
  CaptureSessionSummary,
} from "./types.js";

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

type OpenedDatabase = {
  db: DatabaseSync;
  walMaintenance: SqliteWalMaintenance;
};

function openDatabase(dbPath: string): OpenedDatabase {
  ensureParentDir(dbPath);
  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  const walMaintenance = configureSqliteWalMaintenance(db, {
    databaseLabel: "proxy-capture",
    databasePath: dbPath,
  });
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(PROXY_CAPTURE_SCHEMA_SQL);
  return { db, walMaintenance };
}

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

function parseMetaJson(metaJson: unknown): Record<string, unknown> | null {
  if (typeof metaJson !== "string" || metaJson.trim().length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(metaJson) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeObservedValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function sortObservedCounts(counts: Map<string, number>): CaptureObservedDimension[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

type CaptureSessionRow = {
  id: string;
  startedAt: number;
  endedAt: number | null;
  mode: string;
  sourceProcess: string;
  proxyUrl: string | null;
  eventCount: number;
};

type BlobIdRow = {
  blobId: string | null;
};

type CountRow = {
  count: number;
};

function getCaptureKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<ProxyCaptureKyselyDatabase>(db);
}

function captureBlobRecordFromEncoded(
  encoded: ReturnType<typeof encodeCaptureBlob>,
): CaptureBlobRecord {
  return {
    blobId: encoded.blobId,
    path: encoded.path,
    encoding: encoded.encoding,
    sizeBytes: encoded.sizeBytes,
    sha256: encoded.sha256,
    ...(encoded.contentType ? { contentType: encoded.contentType } : {}),
  };
}

function countTable(
  db: DatabaseSync,
  table: "capture_blobs" | "capture_events" | "capture_sessions",
): number {
  return (
    executeSqliteQueryTakeFirstSync<CountRow>(
      db,
      getCaptureKysely(db).selectFrom(table).select((eb) => eb.fn.countAll<number>().as("count")),
    )?.count ?? 0
  );
}

function assertNeverCaptureQueryPreset(preset: never): never {
  throw new Error(`Unhandled capture query preset: ${String(preset)}`);
}

export class DebugProxyCaptureStore {
  readonly db: DatabaseSync;
  private readonly walMaintenance: SqliteWalMaintenance;
  private closed = false;

  constructor(
    readonly dbPath: string,
    readonly blobDir: string,
  ) {
    const opened = openDatabase(dbPath);
    this.db = opened.db;
    this.walMaintenance = opened.walMaintenance;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.walMaintenance.close();
    this.db.close();
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  upsertSession(session: CaptureSessionRecord): void {
    executeSqliteQuerySync(
      this.db,
      getCaptureKysely(this.db)
        .insertInto("capture_sessions")
        .values({
          id: session.id,
          started_at: session.startedAt,
          ended_at: session.endedAt ?? null,
          mode: session.mode,
          source_scope: session.sourceScope,
          source_process: session.sourceProcess,
          proxy_url: session.proxyUrl ?? null,
          db_path: session.dbPath,
          blob_dir: session.blobDir,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            ended_at: (eb) => eb.ref("excluded.ended_at"),
            proxy_url: (eb) => eb.ref("excluded.proxy_url"),
            source_process: (eb) => eb.ref("excluded.source_process"),
          }),
        ),
    );
  }

  endSession(sessionId: string, endedAt = Date.now()): void {
    executeSqliteQuerySync(
      this.db,
      getCaptureKysely(this.db)
        .updateTable("capture_sessions")
        .set({ ended_at: endedAt })
        .where("id", "=", sessionId),
    );
  }

  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord {
    const encoded = encodeCaptureBlob({ data, contentType });
    const row: Insertable<ProxyCaptureKyselyDatabase["capture_blobs"]> = {
      blob_id: encoded.blobId,
      content_type: encoded.contentType ?? null,
      encoding: encoded.encoding,
      size_bytes: encoded.sizeBytes,
      sha256: encoded.sha256,
      data: encoded.encodedData,
      created_at: Date.now(),
    };
    executeSqliteQuerySync(
      this.db,
      getCaptureKysely(this.db)
        .insertInto("capture_blobs")
        .values(row)
        .onConflict((conflict) => conflict.column("blob_id").doNothing()),
    );
    return captureBlobRecordFromEncoded(encoded);
  }

  recordEvent(event: CaptureEventRecord): void {
    executeSqliteQuerySync(
      this.db,
      getCaptureKysely(this.db)
        .insertInto("capture_events")
        .values({
          session_id: event.sessionId,
          ts: event.ts,
          source_scope: event.sourceScope,
          source_process: event.sourceProcess,
          protocol: event.protocol,
          direction: event.direction,
          kind: event.kind,
          flow_id: event.flowId,
          method: event.method ?? null,
          host: event.host ?? null,
          path: event.path ?? null,
          status: event.status ?? null,
          close_code: event.closeCode ?? null,
          content_type: event.contentType ?? null,
          headers_json: event.headersJson ?? null,
          data_text: event.dataText ?? null,
          data_blob_id: event.dataBlobId ?? null,
          data_sha256: event.dataSha256 ?? null,
          error_text: event.errorText ?? null,
          meta_json: event.metaJson ?? null,
        }),
    );
  }

  listSessions(limit = 50): CaptureSessionSummary[] {
    const rows = executeSqliteQuerySync<CaptureSessionRow>(
      this.db,
      getCaptureKysely(this.db)
        .selectFrom("capture_sessions as s")
        .leftJoin("capture_events as e", "e.session_id", "s.id")
        .select((eb) => [
          "s.id as id",
          "s.started_at as startedAt",
          "s.ended_at as endedAt",
          "s.mode as mode",
          "s.source_process as sourceProcess",
          "s.proxy_url as proxyUrl",
          eb.fn.count<number>("e.id").as("eventCount"),
        ])
        .groupBy("s.id")
        .orderBy("s.started_at", "desc")
        .limit(limit),
    ).rows;
    return rows.map((row) =>
      Object.assign(
        { id: row.id, startedAt: row.startedAt },
        row.endedAt != null ? { endedAt: row.endedAt } : {},
        { mode: row.mode, sourceProcess: row.sourceProcess },
        row.proxyUrl ? { proxyUrl: row.proxyUrl } : {},
        { eventCount: row.eventCount },
      ),
    );
  }

  getSessionEvents(sessionId: string, limit = 500): Array<Record<string, unknown>> {
    return executeSqliteQuerySync<Record<string, unknown>>(
      this.db,
      getCaptureKysely(this.db)
        .selectFrom("capture_events")
        .select([
          "id",
          "session_id as sessionId",
          "ts",
          "source_scope as sourceScope",
          "source_process as sourceProcess",
          "protocol",
          "direction",
          "kind",
          "flow_id as flowId",
          "method",
          "host",
          "path",
          "status",
          "close_code as closeCode",
          "content_type as contentType",
          "headers_json as headersJson",
          "data_text as dataText",
          "data_blob_id as dataBlobId",
          "data_sha256 as dataSha256",
          "error_text as errorText",
          "meta_json as metaJson",
        ])
        .where("session_id", "=", sessionId)
        .orderBy("ts", "desc")
        .orderBy("id", "desc")
        .limit(limit),
    ).rows;
  }

  summarizeSessionCoverage(sessionId: string): CaptureSessionCoverageSummary {
    const rows = executeSqliteQuerySync<{ host: string | null; metaJson: string | null }>(
      this.db,
      getCaptureKysely(this.db)
        .selectFrom("capture_events")
        .select(["host", "meta_json as metaJson"])
        .where("session_id", "=", sessionId),
    ).rows;
    const providers = new Map<string, number>();
    const apis = new Map<string, number>();
    const models = new Map<string, number>();
    const hosts = new Map<string, number>();
    const localPeers = new Map<string, number>();
    let unlabeledEventCount = 0;
    for (const row of rows) {
      const meta = parseMetaJson(row.metaJson);
      const provider = normalizeObservedValue(meta?.provider);
      const api = normalizeObservedValue(meta?.api);
      const model = normalizeObservedValue(meta?.model);
      const host = normalizeObservedValue(row.host);
      if (!provider && !api && !model) {
        unlabeledEventCount += 1;
      }
      if (provider) {
        providers.set(provider, (providers.get(provider) ?? 0) + 1);
      }
      if (api) {
        apis.set(api, (apis.get(api) ?? 0) + 1);
      }
      if (model) {
        models.set(model, (models.get(model) ?? 0) + 1);
      }
      if (host) {
        hosts.set(host, (hosts.get(host) ?? 0) + 1);
        if (
          host === "127.0.0.1:11434" ||
          host.startsWith("127.0.0.1:") ||
          host.startsWith("localhost:")
        ) {
          localPeers.set(host, (localPeers.get(host) ?? 0) + 1);
        }
      }
    }
    return {
      sessionId,
      totalEvents: rows.length,
      unlabeledEventCount,
      providers: sortObservedCounts(providers),
      apis: sortObservedCounts(apis),
      models: sortObservedCounts(models),
      hosts: sortObservedCounts(hosts),
      localPeers: sortObservedCounts(localPeers),
    };
  }

  readBlob(blobId: string): string | null {
    const row = executeSqliteQueryTakeFirstSync<{ data: Uint8Array }>(
      this.db,
      getCaptureKysely(this.db)
        .selectFrom("capture_blobs")
        .select("data")
        .where("blob_id", "=", blobId)
        .limit(1),
    );
    return row ? decodeCaptureBlobText(Buffer.from(row.data)) : null;
  }

  queryPreset(preset: CaptureQueryPreset, sessionId?: string): CaptureQueryRow[] {
    const db = getCaptureKysely(this.db);
    switch (preset) {
      case "double-sends":
        return executeSqliteQuerySync<CaptureQueryRow>(
          this.db,
          db
            .selectFrom("capture_events")
            .select((eb) => [
              "host",
              "path",
              "method",
              eb.fn.countAll<number>().as("duplicateCount"),
            ])
            .where("kind", "=", "request")
            .$if(Boolean(sessionId), (qb) => qb.where("session_id", "=", sessionId ?? ""))
            .groupBy(["host", "path", "method", "data_sha256"])
            .having((eb) => eb.fn.countAll<number>(), ">", 1)
            .orderBy("duplicateCount", "desc")
            .orderBy("host", "asc"),
        ).rows;
      case "retry-storms":
        return executeSqliteQuerySync<CaptureQueryRow>(
          this.db,
          db
            .selectFrom("capture_events")
            .select((eb) => ["host", "path", eb.fn.countAll<number>().as("errorCount")])
            .where("kind", "=", "response")
            .where("status", ">=", 429)
            .$if(Boolean(sessionId), (qb) => qb.where("session_id", "=", sessionId ?? ""))
            .groupBy(["host", "path"])
            .having((eb) => eb.fn.countAll<number>(), ">", 1)
            .orderBy("errorCount", "desc")
            .orderBy("host", "asc"),
        ).rows;
      case "cache-busting":
        return executeSqliteQuerySync<CaptureQueryRow>(
          this.db,
          db
            .selectFrom("capture_events")
            .select((eb) => ["host", "path", eb.fn.countAll<number>().as("variantCount")])
            .where("kind", "=", "request")
            .where((eb) =>
              eb.or([
                eb("path", "like", "%?%"),
                eb("headers_json", "like", "%cache-control%"),
                eb("headers_json", "like", "%pragma%"),
              ]),
            )
            .$if(Boolean(sessionId), (qb) => qb.where("session_id", "=", sessionId ?? ""))
            .groupBy(["host", "path"])
            .orderBy("variantCount", "desc")
            .orderBy("host", "asc"),
        ).rows;
      case "ws-duplicate-frames":
        return executeSqliteQuerySync<CaptureQueryRow>(
          this.db,
          db
            .selectFrom("capture_events")
            .select((eb) => ["host", "path", eb.fn.countAll<number>().as("duplicateFrames")])
            .where("kind", "=", "ws-frame")
            .where("direction", "=", "outbound")
            .$if(Boolean(sessionId), (qb) => qb.where("session_id", "=", sessionId ?? ""))
            .groupBy(["host", "path", "data_sha256"])
            .having((eb) => eb.fn.countAll<number>(), ">", 1)
            .orderBy("duplicateFrames", "desc")
            .orderBy("host", "asc"),
        ).rows;
      case "missing-ack": {
        const inboundFlows = db
          .selectFrom("capture_events")
          .select("flow_id")
          .where("kind", "=", "ws-frame")
          .where("direction", "=", "inbound")
          .$if(Boolean(sessionId), (qb) => qb.where("session_id", "=", sessionId ?? ""));
        return executeSqliteQuerySync<CaptureQueryRow>(
          this.db,
          db
            .selectFrom("capture_events")
            .select((eb) => [
              "flow_id as flowId",
              "host",
              "path",
              eb.fn.countAll<number>().as("outboundFrames"),
            ])
            .where("kind", "=", "ws-frame")
            .where("direction", "=", "outbound")
            .$if(Boolean(sessionId), (qb) => qb.where("session_id", "=", sessionId ?? ""))
            .where("flow_id", "not in", inboundFlows)
            .groupBy(["flow_id", "host", "path"])
            .orderBy("outboundFrames", "desc"),
        ).rows;
      }
      case "error-bursts":
        return executeSqliteQuerySync<CaptureQueryRow>(
          this.db,
          db
            .selectFrom("capture_events")
            .select((eb) => ["host", "path", eb.fn.countAll<number>().as("errorCount")])
            .where("kind", "=", "error")
            .$if(Boolean(sessionId), (qb) => qb.where("session_id", "=", sessionId ?? ""))
            .groupBy(["host", "path"])
            .orderBy("errorCount", "desc")
            .orderBy("host", "asc"),
        ).rows;
      default:
        return assertNeverCaptureQueryPreset(preset);
    }
  }

  purgeAll(): { sessions: number; events: number; blobs: number } {
    return runSqliteImmediateTransactionSync(this.db, () => {
      const sessionCount = countTable(this.db, "capture_sessions");
      const eventCount = countTable(this.db, "capture_events");
      const blobCount = countTable(this.db, "capture_blobs");
      const db = getCaptureKysely(this.db);
      executeSqliteQuerySync(this.db, db.deleteFrom("capture_events"));
      executeSqliteQuerySync(this.db, db.deleteFrom("capture_sessions"));
      executeSqliteQuerySync(this.db, db.deleteFrom("capture_blobs"));
      return { sessions: sessionCount, events: eventCount, blobs: blobCount };
    });
  }

  deleteSessions(sessionIds: string[]): { sessions: number; events: number; blobs: number } {
    const uniqueSessionIds = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
    if (uniqueSessionIds.length === 0) {
      return { sessions: 0, events: 0, blobs: 0 };
    }
    const db = getCaptureKysely(this.db);
    const blobRows = executeSqliteQuerySync<BlobIdRow>(
      this.db,
      db
        .selectFrom("capture_events")
        .select("data_blob_id as blobId")
        .distinct()
        .where("session_id", "in", uniqueSessionIds)
        .where("data_blob_id", "is not", null),
    ).rows;
    const eventCount =
      executeSqliteQueryTakeFirstSync<CountRow>(
        this.db,
        db
          .selectFrom("capture_events")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("session_id", "in", uniqueSessionIds),
      )?.count ?? 0;
    const sessionCount =
      executeSqliteQueryTakeFirstSync<CountRow>(
        this.db,
        db
          .selectFrom("capture_sessions")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("id", "in", uniqueSessionIds),
      )?.count ?? 0;
    executeSqliteQuerySync(
      this.db,
      db.deleteFrom("capture_events").where("session_id", "in", uniqueSessionIds),
    );
    executeSqliteQuerySync(
      this.db,
      db.deleteFrom("capture_sessions").where("id", "in", uniqueSessionIds),
    );
    const candidateBlobIds = blobRows
      .map((row) => row.blobId?.trim())
      .filter((blobId): blobId is string => Boolean(blobId));
    const remainingBlobRefs =
      candidateBlobIds.length > 0
        ? new Set(
            executeSqliteQuerySync<BlobIdRow>(
              this.db,
              db
                .selectFrom("capture_events")
                .select("data_blob_id as blobId")
                .distinct()
                .where("data_blob_id", "in", candidateBlobIds)
                .where("data_blob_id", "is not", null),
            )
              .rows.map((row) => row.blobId?.trim())
              .filter((blobId): blobId is string => Boolean(blobId)),
          )
        : new Set<string>();
    const orphanBlobIds = candidateBlobIds.filter((blobId) => !remainingBlobRefs.has(blobId));
    if (orphanBlobIds.length > 0) {
      executeSqliteQuerySync(
        this.db,
        db.deleteFrom("capture_blobs").where("blob_id", "in", orphanBlobIds),
      );
    }
    return { sessions: sessionCount, events: eventCount, blobs: orphanBlobIds.length };
  }
}

let cachedStore: DebugProxyCaptureStore | null = null;
let cachedKey = "";
let cachedStoreLeases = 0;

export function getDebugProxyCaptureStore(dbPath: string, blobDir: string): DebugProxyCaptureStore {
  const key = `${dbPath}:${blobDir}`;
  if (!cachedStore || cachedStore.isClosed || cachedKey !== key) {
    cachedStore = new DebugProxyCaptureStore(dbPath, blobDir);
    cachedKey = key;
    cachedStoreLeases = 0;
  }
  return cachedStore;
}

export function closeDebugProxyCaptureStore(): void {
  if (!cachedStore) {
    return;
  }
  cachedStore.close();
  cachedStore = null;
  cachedKey = "";
  cachedStoreLeases = 0;
}

export function acquireDebugProxyCaptureStore(
  dbPath: string,
  blobDir: string,
): { store: DebugProxyCaptureStore; release: () => void } {
  const store = getDebugProxyCaptureStore(dbPath, blobDir);
  const key = cachedKey;
  cachedStoreLeases += 1;
  let released = false;
  return {
    store,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      cachedStoreLeases = Math.max(0, cachedStoreLeases - 1);
      if (cachedStoreLeases === 0 && cachedStore === store && cachedKey === key) {
        closeDebugProxyCaptureStore();
      }
    },
  };
}

export function persistEventPayload(
  store: DebugProxyCaptureStore,
  params: { data?: Buffer | string | null; contentType?: string; previewLimit?: number },
): { dataText?: string; dataBlobId?: string; dataSha256?: string } {
  if (params.data == null) {
    return {};
  }
  const buffer = Buffer.isBuffer(params.data) ? params.data : Buffer.from(params.data);
  const previewLimit = params.previewLimit ?? 8192;
  const blob = store.persistPayload(buffer, params.contentType);
  return {
    dataText: buffer.subarray(0, previewLimit).toString("utf8"),
    dataBlobId: blob.blobId,
    dataSha256: blob.sha256,
  };
}

export function safeJsonString(value: unknown): string | undefined {
  const raw = serializeJson(value);
  return raw ?? undefined;
}
