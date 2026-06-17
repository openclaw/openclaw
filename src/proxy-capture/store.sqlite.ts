// Proxy capture SQLite store persists capture metadata and replayable exchanges.
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { normalizeNullableString as normalizeObservedValue } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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

// Capture rows and compressed payload BLOBs live in the shared global state DB.
export type DebugProxyCaptureStoreOptions = {
  env?: NodeJS.ProcessEnv;
};

function serializeJson(value: unknown): string | null {
  return value == null ? null : JSON.stringify(value);
}

// Metadata is optional and user/tool supplied, so parse defensively for coverage
// summaries instead of assuming every event has valid JSON.
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

function sortObservedCounts(counts: Map<string, number>): CaptureObservedDimension[] {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

export class DebugProxyCaptureStore {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  private closed = false;

  constructor(options: DebugProxyCaptureStoreOptions = {}) {
    const database = openOpenClawStateDatabase({ env: options.env });
    this.db = database.db;
    this.dbPath = database.path;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  upsertSession(session: CaptureSessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO capture_sessions (
          id, started_at, ended_at, mode, source_scope, source_process, proxy_url
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          started_at=MIN(capture_sessions.started_at, excluded.started_at),
          ended_at=excluded.ended_at,
          mode=CASE
            WHEN capture_sessions.mode = 'implicit' THEN excluded.mode
            ELSE capture_sessions.mode
          END,
          proxy_url=excluded.proxy_url,
          source_process=excluded.source_process`,
      )
      .run(
        session.id,
        session.startedAt,
        session.endedAt ?? null,
        session.mode,
        session.sourceScope,
        session.sourceProcess,
        session.proxyUrl ?? null,
      );
  }

  endSession(sessionId: string, endedAt = Date.now()): void {
    this.db
      .prepare(`UPDATE capture_sessions SET ended_at = ? WHERE id = ?`)
      .run(endedAt, sessionId);
  }

  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord {
    const sha256 = createHash("sha256").update(data).digest("hex");
    const blobId = sha256.slice(0, 24);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO capture_blobs (
          blob_id, content_type, encoding, size_bytes, sha256, data, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        blobId,
        contentType ?? null,
        "gzip",
        data.byteLength,
        sha256,
        gzipSync(data),
        Date.now(),
      );
    return {
      blobId,
      encoding: "gzip",
      sizeBytes: data.byteLength,
      sha256,
      ...(contentType ? { contentType } : {}),
    };
  }

  recordEvent(event: CaptureEventRecord): void {
    runSqliteImmediateTransactionSync(this.db, () => {
      // Capture can be invoked directly by provider seams before the top-level
      // runtime initializes. Keep the shared-schema foreign key valid without
      // making diagnostics break the request they are observing.
      this.db
        .prepare(
          `INSERT OR IGNORE INTO capture_sessions (
            id, started_at, mode, source_scope, source_process
          ) VALUES (?, ?, 'implicit', ?, ?)`,
        )
        .run(event.sessionId, event.ts, event.sourceScope, event.sourceProcess);
      // A concurrent purge can remove a payload before its event is recorded.
      // Keep the inline preview instead of failing the observed request.
      const dataBlobId =
        event.dataBlobId &&
        this.db.prepare(`SELECT 1 FROM capture_blobs WHERE blob_id = ?`).get(event.dataBlobId)
          ? event.dataBlobId
          : null;
      this.db
        .prepare(
          `INSERT INTO capture_events (
            session_id, ts, source_scope, source_process, protocol, direction, kind, flow_id,
            method, host, path, status, close_code, content_type, headers_json,
            data_text, data_blob_id, data_sha256, error_text, meta_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.sessionId,
          event.ts,
          event.sourceScope,
          event.sourceProcess,
          event.protocol,
          event.direction,
          event.kind,
          event.flowId,
          event.method ?? null,
          event.host ?? null,
          event.path ?? null,
          event.status ?? null,
          event.closeCode ?? null,
          event.contentType ?? null,
          event.headersJson ?? null,
          event.dataText ?? null,
          dataBlobId,
          event.dataSha256 ?? null,
          event.errorText ?? null,
          event.metaJson ?? null,
        );
    });
  }

  listSessions(limit = 50): CaptureSessionSummary[] {
    return this.db
      .prepare(
        `SELECT
           s.id,
           s.started_at AS startedAt,
           s.ended_at AS endedAt,
           s.mode,
           s.source_process AS sourceProcess,
           s.proxy_url AS proxyUrl,
           COUNT(e.id) AS eventCount
         FROM capture_sessions s
         LEFT JOIN capture_events e ON e.session_id = s.id
         GROUP BY s.id
         ORDER BY s.started_at DESC
         LIMIT ?`,
      )
      .all(limit) as CaptureSessionSummary[];
  }

  getSessionEvents(sessionId: string, limit = 500): Array<Record<string, unknown>> {
    return this.db
      .prepare(
        `SELECT
           id, session_id AS sessionId, ts, source_scope AS sourceScope, source_process AS sourceProcess,
           protocol, direction, kind, flow_id AS flowId, method, host, path, status, close_code AS closeCode,
           content_type AS contentType, headers_json AS headersJson, data_text AS dataText,
           data_blob_id AS dataBlobId, data_sha256 AS dataSha256, error_text AS errorText, meta_json AS metaJson
         FROM capture_events
         WHERE session_id = ?
         ORDER BY ts DESC, id DESC
         LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
  }

  summarizeSessionCoverage(sessionId: string): CaptureSessionCoverageSummary {
    const rows = this.db
      .prepare(
        `SELECT host, meta_json AS metaJson
         FROM capture_events
         WHERE session_id = ?`,
      )
      .all(sessionId) as Array<{ host?: string | null; metaJson?: string | null }>;
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
        // Local model/provider endpoints are useful to surface separately when
        // debugging why cloud-provider labels are absent.
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
    const row = this.db
      .prepare(`SELECT encoding, data FROM capture_blobs WHERE blob_id = ?`)
      .get(blobId) as { data?: Uint8Array; encoding?: string } | undefined;
    if (!row?.data) {
      return null;
    }
    const data = Buffer.from(row.data);
    return (row.encoding === "gzip" ? gunzipSync(data) : data).toString("utf8");
  }

  queryPreset(preset: CaptureQueryPreset, sessionId?: string): CaptureQueryRow[] {
    const sessionWhere = sessionId ? "AND session_id = ?" : "";
    const args = sessionId ? [sessionId] : [];
    switch (preset) {
      // Presets are intentionally SQL-only summaries so the CLI can query large
      // capture sessions without loading every event into memory.
      case "double-sends":
        return this.db
          .prepare(
            `SELECT host, path, method, COUNT(*) AS duplicateCount
             FROM capture_events
             WHERE kind = 'request' ${sessionWhere}
             GROUP BY host, path, method, data_sha256
             HAVING COUNT(*) > 1
             ORDER BY duplicateCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "retry-storms":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS errorCount
             FROM capture_events
             WHERE kind = 'response' AND status >= 429 ${sessionWhere}
             GROUP BY host, path
             HAVING COUNT(*) > 1
             ORDER BY errorCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "cache-busting":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS variantCount
             FROM capture_events
             WHERE kind = 'request'
               AND (path LIKE '%?%' OR headers_json LIKE '%cache-control%' OR headers_json LIKE '%pragma%')
               ${sessionWhere}
             GROUP BY host, path
             ORDER BY variantCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "ws-duplicate-frames":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS duplicateFrames
             FROM capture_events
             WHERE kind = 'ws-frame' AND direction = 'outbound' ${sessionWhere}
             GROUP BY host, path, data_sha256
             HAVING COUNT(*) > 1
             ORDER BY duplicateFrames DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      case "missing-ack":
        return this.db
          .prepare(
            `SELECT flow_id AS flowId, host, path, COUNT(*) AS outboundFrames
             FROM capture_events
             WHERE kind = 'ws-frame' AND direction = 'outbound' ${sessionWhere}
               AND flow_id NOT IN (
                 SELECT flow_id FROM capture_events
                 WHERE kind = 'ws-frame' AND direction = 'inbound' ${sessionId ? "AND session_id = ?" : ""}
               )
             GROUP BY flow_id, host, path
             ORDER BY outboundFrames DESC`,
          )
          .all(...(sessionId ? [sessionId, sessionId] : [])) as CaptureQueryRow[];
      case "error-bursts":
        return this.db
          .prepare(
            `SELECT host, path, COUNT(*) AS errorCount
             FROM capture_events
             WHERE kind = 'error' ${sessionWhere}
             GROUP BY host, path
             ORDER BY errorCount DESC, host ASC`,
          )
          .all(...args) as CaptureQueryRow[];
      default:
        return [];
    }
  }

  purgeAll(): { sessions: number; events: number; blobs: number } {
    return runSqliteImmediateTransactionSync(this.db, () => {
      const sessionCount =
        (
          this.db.prepare(`SELECT COUNT(*) AS count FROM capture_sessions`).get() as {
            count: number;
          }
        ).count ?? 0;
      const eventCount =
        (this.db.prepare(`SELECT COUNT(*) AS count FROM capture_events`).get() as { count: number })
          .count ?? 0;
      const blobCount =
        (this.db.prepare(`SELECT COUNT(*) AS count FROM capture_blobs`).get() as { count: number })
          .count ?? 0;
      this.db.exec(
        `DELETE FROM capture_events; DELETE FROM capture_sessions; DELETE FROM capture_blobs;`,
      );
      return { sessions: sessionCount, events: eventCount, blobs: blobCount };
    });
  }

  deleteSessions(sessionIds: string[]): { sessions: number; events: number; blobs: number } {
    const uniqueSessionIds = normalizeUniqueStringEntries(sessionIds);
    if (uniqueSessionIds.length === 0) {
      return { sessions: 0, events: 0, blobs: 0 };
    }
    return runSqliteImmediateTransactionSync(this.db, () => {
      const placeholders = uniqueSessionIds.map(() => "?").join(", ");
      const blobRows = this.db
        .prepare(
          `SELECT DISTINCT data_blob_id AS blobId
           FROM capture_events
           WHERE session_id IN (${placeholders})
             AND data_blob_id IS NOT NULL`,
        )
        .all(...uniqueSessionIds) as Array<{ blobId?: string | null }>;
      const eventCount =
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM capture_events
               WHERE session_id IN (${placeholders})`,
            )
            .get(...uniqueSessionIds) as { count: number }
        ).count ?? 0;
      const sessionCount =
        (
          this.db
            .prepare(
              `SELECT COUNT(*) AS count
               FROM capture_sessions
               WHERE id IN (${placeholders})`,
            )
            .get(...uniqueSessionIds) as { count: number }
        ).count ?? 0;
      this.db
        .prepare(`DELETE FROM capture_events WHERE session_id IN (${placeholders})`)
        .run(...uniqueSessionIds);
      this.db
        .prepare(`DELETE FROM capture_sessions WHERE id IN (${placeholders})`)
        .run(...uniqueSessionIds);
      const candidateBlobIds = blobRows
        .map((row) => row.blobId?.trim())
        .filter((blobId): blobId is string => Boolean(blobId));
      const remainingBlobRefs =
        // Shared blobs are deleted only when no surviving event references them.
        candidateBlobIds.length > 0
          ? new Set(
              (
                this.db
                  .prepare(
                    `SELECT DISTINCT data_blob_id AS blobId
                     FROM capture_events
                     WHERE data_blob_id IN (${candidateBlobIds.map(() => "?").join(", ")})
                       AND data_blob_id IS NOT NULL`,
                  )
                  .all(...candidateBlobIds) as Array<{ blobId?: string | null }>
              )
                .map((row) => row.blobId?.trim())
                .filter((blobId): blobId is string => Boolean(blobId)),
            )
          : new Set<string>();
      let blobs = 0;
      const deleteBlob = this.db.prepare(`DELETE FROM capture_blobs WHERE blob_id = ?`);
      for (const blobId of candidateBlobIds) {
        if (remainingBlobRefs.has(blobId)) {
          continue;
        }
        const result = deleteBlob.run(blobId);
        if (Number(result.changes) > 0) {
          blobs += 1;
        }
      }
      return { sessions: sessionCount, events: eventCount, blobs };
    });
  }
}

type CachedStoreEntry = {
  store: DebugProxyCaptureStore;
  leases: number;
};

const cachedStores = new Map<string, CachedStoreEntry>();

export function getDebugProxyCaptureStore(
  options: DebugProxyCaptureStoreOptions = {},
): DebugProxyCaptureStore {
  const key = openOpenClawStateDatabase({ env: options.env }).path;
  const cached = cachedStores.get(key);
  if (cached && !cached.store.isClosed) {
    return cached.store;
  }
  const store = new DebugProxyCaptureStore(options);
  cachedStores.set(key, { store, leases: 0 });
  return store;
}

export function closeDebugProxyCaptureStore(): void {
  for (const cached of cachedStores.values()) {
    cached.store.close();
  }
  cachedStores.clear();
}

// Lease API keeps one cached capture-store wrapper alive across related
// operations, then releases it without closing the shared state database.
export function acquireDebugProxyCaptureStore(options: DebugProxyCaptureStoreOptions = {}): {
  store: DebugProxyCaptureStore;
  release: () => void;
} {
  const store = getDebugProxyCaptureStore(options);
  const key = store.dbPath;
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
        current.store.close();
        cachedStores.delete(key);
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
  // Store the whole payload as a blob but keep a small UTF-8 preview inline for
  // fast CLI listings and query output.
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
