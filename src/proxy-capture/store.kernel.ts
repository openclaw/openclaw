// Connection-bound capture operations retain their caller's synchronous write admission.
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";
import { normalizeUniqueStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { InferResult } from "kysely";
import { sha256Hex } from "../infra/crypto-digest.js";
import { executeWithCachedStatement } from "../infra/kysely-sync-cache-state.js";
import { compileSqliteQueryBindings, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { applyPrivateModeSync } from "../infra/private-mode.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  findDebugProxyCaptureBlobReference,
  listDebugProxyCaptureSessions,
  queryDebugProxyCapturePreset,
  readDebugProxyCaptureBlob,
  readDebugProxyCaptureSessionEvents,
  summarizeDebugProxyCaptureSessionCoverage,
} from "./store-readonly.js";
import type {
  CaptureBlobRecord,
  CaptureEventRecord,
  CaptureQueryPreset,
  CaptureQueryRow,
  CaptureSessionCoverageSummary,
  CaptureSessionRecord,
  CaptureSessionSummary,
  SharedCaptureBlobRecord,
} from "./types.js";

type CaptureDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "capture_sessions" | "capture_events" | "capture_blobs"
>;
type LegacyCaptureDatabase = Pick<CaptureDatabase, "capture_events"> & {
  capture_sessions: CaptureDatabase["capture_sessions"] & {
    db_path: string;
    blob_dir: string;
  };
};

export const DEBUG_PROXY_CAPTURE_DIR_MODE = 0o700;
export const DEBUG_PROXY_CAPTURE_FILE_MODE = 0o600;

export type DebugProxyCaptureKernelOptions = {
  db: DatabaseSync;
  dbPath: string;
  blobDir: string;
  pathBased?: { blobDir: string };
  runWrite: <T>(operation: () => T) => T;
};

export class DebugProxyCaptureKernel {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly blobDir: string;
  private readonly capturePathBased?: { blobDir: string };
  private readonly runWrite: DebugProxyCaptureKernelOptions["runWrite"];

  constructor(options: DebugProxyCaptureKernelOptions) {
    this.db = options.db;
    this.dbPath = options.dbPath;
    this.blobDir = options.blobDir;
    this.capturePathBased = options.pathBased;
    this.runWrite = options.runWrite;
  }

  upsertSession(session: CaptureSessionRecord): void {
    const pathBased = this.capturePathBased;
    const { compiled, bind } = compileSqliteQueryBindings<CaptureSessionRecord>((parameter) => {
      const values = {
        id: parameter((value) => value.id),
        started_at: parameter((value) => value.startedAt),
        ended_at: parameter((value) => value.endedAt ?? null),
        mode: parameter((value) => value.mode),
        source_scope: parameter((value) => value.sourceScope),
        source_process: parameter((value) => value.sourceProcess),
        proxy_url: parameter((value) => value.proxyUrl ?? null),
      };
      if (pathBased) {
        return getNodeSqliteKysely<LegacyCaptureDatabase>(this.db)
          .insertInto("capture_sessions")
          .values({
            ...values,
            db_path: parameter((value) => value.dbPath ?? this.dbPath),
            blob_dir: parameter((value) => value.blobDir ?? pathBased.blobDir),
          })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet((eb) => ({
              ended_at: eb.ref("excluded.ended_at"),
              proxy_url: eb.ref("excluded.proxy_url"),
              source_process: eb.ref("excluded.source_process"),
            })),
          );
      }
      return getNodeSqliteKysely<CaptureDatabase>(this.db)
        .insertInto("capture_sessions")
        .values(values)
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet((eb) => ({
            started_at: eb.fn<number>("min", [
              "capture_sessions.started_at",
              "excluded.started_at",
            ]),
            ended_at: eb.ref("excluded.ended_at"),
            mode: eb
              .case()
              .when("capture_sessions.mode", "=", "implicit")
              .then(eb.ref("excluded.mode"))
              .else(eb.ref("capture_sessions.mode"))
              .end(),
            proxy_url: eb.ref("excluded.proxy_url"),
            source_process: eb.ref("excluded.source_process"),
          })),
        );
    });
    const upsert = () => {
      const parameters = bind(session);
      return executeWithCachedStatement(this.db, compiled.sql, parameters, (statement) =>
        statement.run(...parameters),
      );
    };
    if (pathBased) {
      upsert();
      return;
    }
    this.runWrite(upsert);
  }

  endSession(sessionId: string, endedAt = Date.now()): void {
    const { compiled, bind } = compileSqliteQueryBindings<void>(() =>
      getNodeSqliteKysely<CaptureDatabase>(this.db)
        .updateTable("capture_sessions")
        .set({ ended_at: endedAt })
        .where("id", "=", sessionId),
    );
    const update = () => {
      const parameters = bind();
      return executeWithCachedStatement(this.db, compiled.sql, parameters, (statement) =>
        statement.run(...parameters),
      );
    };
    if (this.capturePathBased) {
      update();
      return;
    }
    this.runWrite(update);
  }

  persistPayload(data: Buffer, contentType?: string): CaptureBlobRecord | SharedCaptureBlobRecord {
    const sha256 = sha256Hex(data);
    const blobId = sha256.slice(0, 24);
    if (this.capturePathBased) {
      fs.mkdirSync(this.capturePathBased.blobDir, {
        recursive: true,
        mode: DEBUG_PROXY_CAPTURE_DIR_MODE,
      });
      const outputPath = path.join(this.capturePathBased.blobDir, `${blobId}.bin.gz`);
      if (!fs.existsSync(outputPath)) {
        fs.writeFileSync(outputPath, gzipSync(data), {
          mode: DEBUG_PROXY_CAPTURE_FILE_MODE,
        });
      }
      applyPrivateModeSync(outputPath, DEBUG_PROXY_CAPTURE_FILE_MODE);
      return {
        blobId,
        path: outputPath,
        encoding: "gzip",
        sizeBytes: data.byteLength,
        sha256,
        ...(contentType ? { contentType } : {}),
      };
    }
    const { compiled, bind } = compileSqliteQueryBindings<Buffer>((parameter) =>
      getNodeSqliteKysely<CaptureDatabase>(this.db)
        .insertInto("capture_blobs")
        .orIgnore()
        .values({
          blob_id: blobId,
          content_type: contentType ?? null,
          encoding: "gzip",
          size_bytes: parameter((value) => value.byteLength),
          sha256,
          data: parameter((value) => gzipSync(value)),
          created_at: parameter(() => Date.now()),
        }),
    );
    // Prepare errors must precede payload compression and its creation timestamp.
    // Size cache admission with source bytes so large payloads never retain a cached binding.
    this.runWrite(() =>
      executeWithCachedStatement(
        this.db,
        compiled.sql,
        [data, contentType ?? null, blobId, sha256],
        (statement) => statement.run(...bind(data)),
      ),
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
    if (this.capturePathBased) {
      this.insertEvent(event, event.dataBlobId ?? null);
      return;
    }
    this.runWrite(() => {
      // Capture can be invoked directly by provider seams before the top-level
      // runtime initializes. Keep the shared-schema foreign key valid without
      // making diagnostics break the request they are observing.
      const implicitSession = compileSqliteQueryBindings<CaptureEventRecord>((parameter) =>
        getNodeSqliteKysely<CaptureDatabase>(this.db)
          .insertInto("capture_sessions")
          .orIgnore()
          .values({
            id: parameter((value) => value.sessionId),
            started_at: parameter((value) => value.ts),
            mode: "implicit",
            source_scope: parameter((value) => value.sourceScope),
            source_process: parameter((value) => value.sourceProcess),
          }),
      );
      const sessionParameters = implicitSession.bind(event);
      executeWithCachedStatement(
        this.db,
        implicitSession.compiled.sql,
        sessionParameters,
        (statement) => statement.run(...sessionParameters),
      );
      // A concurrent purge can remove a payload before its event is recorded.
      // Keep the inline preview instead of failing the observed request.
      let dataBlobId: string | null = null;
      if (event.dataBlobId) {
        const blob = compileSqliteQueryBindings<string>((parameter) =>
          getNodeSqliteKysely<CaptureDatabase>(this.db)
            .selectFrom("capture_blobs")
            .select((eb) => eb.lit(1).as("present"))
            .where(
              "blob_id",
              "=",
              parameter((value) => value),
            ),
        );
        const blobParameters = blob.bind(event.dataBlobId);
        dataBlobId = executeWithCachedStatement(
          this.db,
          blob.compiled.sql,
          blobParameters,
          (statement) => statement.get(...blobParameters),
        )
          ? event.dataBlobId
          : null;
      }
      this.insertEvent(event, dataBlobId);
    });
  }

  private insertEvent(event: CaptureEventRecord, dataBlobId: string | null): void {
    const { compiled, bind } = compileSqliteQueryBindings<CaptureEventRecord>((parameter) =>
      getNodeSqliteKysely<CaptureDatabase>(this.db)
        .insertInto("capture_events")
        .values({
          session_id: parameter((value) => value.sessionId),
          ts: parameter((value) => value.ts),
          source_scope: parameter((value) => value.sourceScope),
          source_process: parameter((value) => value.sourceProcess),
          protocol: parameter((value) => value.protocol),
          direction: parameter((value) => value.direction),
          kind: parameter((value) => value.kind),
          flow_id: parameter((value) => value.flowId),
          method: parameter((value) => value.method ?? null),
          host: parameter((value) => value.host ?? null),
          path: parameter((value) => value.path ?? null),
          status: parameter((value) => value.status ?? null),
          close_code: parameter((value) => value.closeCode ?? null),
          content_type: parameter((value) => value.contentType ?? null),
          headers_json: parameter((value) => value.headersJson ?? null),
          data_text: parameter((value) => value.dataText ?? null),
          data_blob_id: dataBlobId,
          data_sha256: parameter((value) => value.dataSha256 ?? null),
          error_text: parameter((value) => value.errorText ?? null),
          meta_json: parameter((value) => value.metaJson ?? null),
        }),
    );
    const parameters = bind(event);
    executeWithCachedStatement(this.db, compiled.sql, parameters, (statement) =>
      statement.run(...parameters),
    );
  }

  listSessions(limit = 50): CaptureSessionSummary[] {
    // SAFETY: Preserve the shipped SDK type; native nullable fields remain unchanged.
    return listDebugProxyCaptureSessions(this.db, limit) as CaptureSessionSummary[];
  }

  getSessionEvents(sessionId: string, limit = 500): Array<Record<string, unknown>> {
    return readDebugProxyCaptureSessionEvents(this.db, sessionId, limit);
  }

  summarizeSessionCoverage(sessionId: string): CaptureSessionCoverageSummary {
    return summarizeDebugProxyCaptureSessionCoverage(this.db, sessionId);
  }

  readBlob(blobId: string): string | null {
    if (this.capturePathBased) {
      const legacyBlobId = findDebugProxyCaptureBlobReference(this.db, blobId);
      if (!legacyBlobId) {
        return null;
      }
      const blobPath = path.join(this.capturePathBased.blobDir, `${legacyBlobId}.bin.gz`);
      return fs.existsSync(blobPath)
        ? gunzipSync(fs.readFileSync(blobPath)).toString("utf8")
        : null;
    }
    return readDebugProxyCaptureBlob(this.db, blobId);
  }

  queryPreset(preset: CaptureQueryPreset, sessionId?: string): CaptureQueryRow[] {
    return queryDebugProxyCapturePreset(this.db, preset, sessionId);
  }

  purgeAll(): { sessions: number; events: number; blobs: number } {
    const kysely = getNodeSqliteKysely<CaptureDatabase>(this.db);
    const metadataDeletes = [
      kysely.deleteFrom("capture_events").compile().sql,
      kysely.deleteFrom("capture_sessions").compile().sql,
    ];
    if (this.capturePathBased) {
      const sessionCount = this.countCaptureRows("capture_sessions");
      const eventCount = this.countCaptureRows("capture_events");
      runSqliteImmediateTransactionSync(this.db, () => {
        for (const sql of metadataDeletes) {
          executeWithCachedStatement(this.db, sql, [], (statement) => statement.run());
        }
      });
      let blobs = 0;
      if (fs.existsSync(this.capturePathBased.blobDir)) {
        for (const entry of fs.readdirSync(this.capturePathBased.blobDir)) {
          fs.rmSync(path.join(this.capturePathBased.blobDir, entry), { force: true });
          blobs += 1;
        }
      }
      return { sessions: sessionCount, events: eventCount, blobs };
    }
    return this.runWrite(() => {
      const sessionCount = this.countCaptureRows("capture_sessions");
      const eventCount = this.countCaptureRows("capture_events");
      const blobCount = this.countCaptureRows("capture_blobs");
      for (const sql of [...metadataDeletes, kysely.deleteFrom("capture_blobs").compile().sql]) {
        executeWithCachedStatement(this.db, sql, [], (statement) => statement.run());
      }
      return { sessions: sessionCount, events: eventCount, blobs: blobCount };
    });
  }

  deleteSessions(sessionIds: string[]): { sessions: number; events: number; blobs: number } {
    const uniqueSessionIds = normalizeUniqueStringEntries(sessionIds);
    if (uniqueSessionIds.length === 0) {
      return { sessions: 0, events: 0, blobs: 0 };
    }
    if (this.capturePathBased) {
      return this.deletePathBasedSessions(uniqueSessionIds);
    }
    return this.runWrite(() => {
      const { blobRows, eventCount, sessionCount } = this.readSessionDeletionRows(uniqueSessionIds);
      this.deleteSessionMetadata(uniqueSessionIds);
      const candidateBlobIds = blobRows
        .map((row) => row.blobId?.trim())
        .filter((blobId): blobId is string => Boolean(blobId));
      const remainingBlobRefs = this.findRemainingBlobReferences(candidateBlobIds);
      const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
        getNodeSqliteKysely<CaptureDatabase>(this.db)
          .deleteFrom("capture_blobs")
          .where(
            "blob_id",
            "=",
            parameter((blobId) => blobId),
          ),
      );
      // Prepare even without victims so native authorization failures still roll back metadata.
      const blobs = executeWithCachedStatement(
        this.db,
        compiled.sql,
        candidateBlobIds,
        (statement) => {
          let deleted = 0;
          for (const blobId of candidateBlobIds) {
            if (remainingBlobRefs.has(blobId)) {
              continue;
            }
            const result = statement.run(...bind(blobId));
            if (Number(result.changes) > 0) {
              deleted += 1;
            }
          }
          return deleted;
        },
      );
      return { sessions: sessionCount, events: eventCount, blobs };
    });
  }

  private deletePathBasedSessions(sessionIds: string[]): {
    sessions: number;
    events: number;
    blobs: number;
  } {
    const pathBased = this.capturePathBased;
    if (!pathBased) {
      throw new Error("path-based debug proxy capture store is unavailable");
    }
    const { blobRows, eventCount, sessionCount } = this.readSessionDeletionRows(sessionIds);
    runSqliteImmediateTransactionSync(this.db, () => this.deleteSessionMetadata(sessionIds));
    // Legacy files are removed only after metadata commits; file failures do not roll it back.
    const candidateBlobIds = blobRows
      .map((row) => row.blobId?.trim())
      .filter((blobId): blobId is string => Boolean(blobId));
    const remainingBlobRefs = this.findRemainingBlobReferences(candidateBlobIds);
    let blobs = 0;
    for (const blobId of candidateBlobIds) {
      if (remainingBlobRefs.has(blobId)) {
        continue;
      }
      const blobPath = path.join(pathBased.blobDir, `${blobId}.bin.gz`);
      if (fs.existsSync(blobPath)) {
        fs.rmSync(blobPath, { force: true });
        blobs += 1;
      }
    }
    return { sessions: sessionCount, events: eventCount, blobs };
  }

  // The statement executor leaves corruption recovery with the shared write owner or legacy caller.
  private countCaptureRows(table: keyof CaptureDatabase): number {
    const query = getNodeSqliteKysely<CaptureDatabase>(this.db)
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as("count"));
    const row = executeWithCachedStatement(this.db, query.compile().sql, [], (statement) =>
      statement.get(),
    ) as InferResult<typeof query>[number]; // SAFETY: COUNT(*) always returns the generated numeric count projection.
    return row.count ?? 0;
  }

  private readSessionDeletionRows(sessionIds: string[]) {
    const kysely = getNodeSqliteKysely<CaptureDatabase>(this.db);
    const events = kysely.selectFrom("capture_events").where("session_id", "in", sessionIds);
    // DISTINCT precedes trimming: colliding trimmed IDs retain separate cleanup attempts.
    const blobs = compileSqliteQueryBindings(() =>
      events.select("data_blob_id as blobId").distinct().where("data_blob_id", "is not", null),
    );
    const blobParameters = blobs.bind(undefined);
    const blobRows = executeWithCachedStatement(
      this.db,
      blobs.compiled.sql,
      blobParameters,
      (statement) => statement.all(...blobParameters),
    ) as InferResult<typeof blobs.compiled>; // SAFETY: Native rows follow the generated nullable blob-id projection.
    const eventQuery = compileSqliteQueryBindings(() =>
      events.select((eb) => eb.fn.countAll<number>().as("count")),
    );
    const eventParameters = eventQuery.bind(undefined);
    const eventRow = executeWithCachedStatement(
      this.db,
      eventQuery.compiled.sql,
      eventParameters,
      (statement) => statement.get(...eventParameters),
    ) as InferResult<typeof eventQuery.compiled>[number]; // SAFETY: COUNT(*) always returns the generated numeric count projection.
    const sessionQuery = compileSqliteQueryBindings(() =>
      kysely
        .selectFrom("capture_sessions")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("id", "in", sessionIds),
    );
    const sessionParameters = sessionQuery.bind(undefined);
    const sessionRow = executeWithCachedStatement(
      this.db,
      sessionQuery.compiled.sql,
      sessionParameters,
      (statement) => statement.get(...sessionParameters),
    ) as InferResult<typeof sessionQuery.compiled>[number]; // SAFETY: COUNT(*) always returns the generated numeric count projection.
    return { blobRows, eventCount: eventRow.count ?? 0, sessionCount: sessionRow.count ?? 0 };
  }

  private deleteSessionMetadata(sessionIds: string[]): void {
    const kysely = getNodeSqliteKysely<CaptureDatabase>(this.db);
    const events = compileSqliteQueryBindings(() =>
      kysely.deleteFrom("capture_events").where("session_id", "in", sessionIds),
    );
    const eventParameters = events.bind(undefined);
    executeWithCachedStatement(this.db, events.compiled.sql, eventParameters, (statement) =>
      statement.run(...eventParameters),
    );
    const sessions = compileSqliteQueryBindings(() =>
      kysely.deleteFrom("capture_sessions").where("id", "in", sessionIds),
    );
    const sessionParameters = sessions.bind(undefined);
    executeWithCachedStatement(this.db, sessions.compiled.sql, sessionParameters, (statement) =>
      statement.run(...sessionParameters),
    );
  }

  private findRemainingBlobReferences(candidateBlobIds: string[]): Set<string> {
    if (candidateBlobIds.length === 0) {
      return new Set();
    }
    const { compiled, bind } = compileSqliteQueryBindings(() =>
      getNodeSqliteKysely<CaptureDatabase>(this.db)
        .selectFrom("capture_events")
        .select("data_blob_id as blobId")
        .distinct()
        .where("data_blob_id", "in", candidateBlobIds)
        .where("data_blob_id", "is not", null),
    );
    const parameters = bind(undefined);
    const rows = executeWithCachedStatement(this.db, compiled.sql, parameters, (statement) =>
      statement.all(...parameters),
    ) as InferResult<typeof compiled>; // SAFETY: Native rows follow the generated nullable blob-id projection.
    return new Set(
      rows.map((row) => row.blobId?.trim()).filter((blobId): blobId is string => Boolean(blobId)),
    );
  }
}
