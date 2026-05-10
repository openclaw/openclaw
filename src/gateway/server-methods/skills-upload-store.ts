import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateRequestedSkillSlug } from "../../agents/skills-archive-install.js";
import { DEFAULT_MAX_ARCHIVE_BYTES_ZIP } from "../../infra/archive.js";
import { createAsyncLock } from "../../infra/async-lock.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

export const SKILL_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const MAX_SKILL_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const MAX_SKILL_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_SKILL_UPLOAD_CHUNK_BYTES / 3) * 4;
export const MAX_ACTIVE_SKILL_UPLOADS = 32;
export const SKILL_UPLOAD_IDEMPOTENCY_KEY_MAX_LENGTH = 2048;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const locks = new Map<string, { lock: ReturnType<typeof createAsyncLock>; references: number }>();

export class SkillUploadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillUploadRequestError";
  }
}

export type SkillUploadRecord = {
  version: 1;
  kind: "skill-archive";
  uploadId: string;
  slug: string;
  force: boolean;
  sizeBytes: number;
  sha256?: string;
  actualSha256?: string;
  receivedBytes: number;
  archivePath: string;
  createdAt: number;
  expiresAt: number;
  committed: boolean;
  committedAt?: number;
  idempotencyKeyHash?: string;
};

export type SkillUploadStore = ReturnType<typeof createSkillUploadStore>;

type BeginParams = {
  kind: "skill-archive";
  slug: string;
  sizeBytes: number;
  sha256?: string;
  force?: boolean;
  idempotencyKey?: string;
};

type ChunkParams = {
  uploadId: string;
  offset: number;
  dataBase64: string;
};

type CommitParams = {
  uploadId: string;
  sha256?: string;
};

type SkillUploadDatabase = Pick<OpenClawStateKyselyDatabase, "skill_uploads">;

type SkillUploadRow = OpenClawStateKyselyDatabase["skill_uploads"];

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let entry = locks.get(key);
  if (!entry) {
    entry = { lock: createAsyncLock(), references: 0 };
    locks.set(key, entry);
  }
  entry.references += 1;
  try {
    return await entry.lock(fn);
  } finally {
    entry.references -= 1;
    if (entry.references === 0) {
      locks.delete(key);
    }
  }
}

export function normalizeSkillUploadSha256(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!SHA256_PATTERN.test(normalized)) {
    throw new SkillUploadRequestError("invalid sha256");
  }
  return normalized;
}

function validateUploadId(uploadId: string): string {
  const normalized = uploadId.trim();
  if (!UPLOAD_ID_PATTERN.test(normalized)) {
    throw new SkillUploadRequestError("invalid uploadId");
  }
  return normalized;
}

function validateSizeBytes(sizeBytes: number): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
    throw new SkillUploadRequestError("invalid sizeBytes");
  }
  if (sizeBytes > DEFAULT_MAX_ARCHIVE_BYTES_ZIP) {
    throw new SkillUploadRequestError("skill archive exceeds maximum upload size");
  }
  return sizeBytes;
}

function validateUploadSlug(slug: string): string {
  try {
    return validateRequestedSkillSlug(slug);
  } catch (err) {
    throw new SkillUploadRequestError(formatErrorMessage(err));
  }
}

function validateOffset(offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SkillUploadRequestError("invalid offset");
  }
  return offset;
}

function validateIdempotencyKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  if (normalized.length > SKILL_UPLOAD_IDEMPOTENCY_KEY_MAX_LENGTH) {
    throw new SkillUploadRequestError("idempotencyKey is too long");
  }
  return normalized;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function estimateBase64DecodedBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function decodeBase64Chunk(dataBase64: string): Buffer {
  const normalized = dataBase64.trim();
  if (!normalized || normalized.length % 4 !== 0 || !BASE64_PATTERN.test(normalized)) {
    throw new SkillUploadRequestError("invalid dataBase64");
  }
  if (normalized.length > MAX_SKILL_UPLOAD_BASE64_LENGTH) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  if (estimateBase64DecodedBytes(normalized) > MAX_SKILL_UPLOAD_CHUNK_BYTES) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length < 1) {
    throw new SkillUploadRequestError("empty upload chunk");
  }
  if (decoded.length > MAX_SKILL_UPLOAD_CHUNK_BYTES) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  return decoded;
}

function resolveStateDatabaseOptions(rootDir?: string): OpenClawStateDatabaseOptions {
  return rootDir ? { path: path.join(path.resolve(rootDir), "openclaw-state.sqlite") } : {};
}

function getUploadDatabase(database: OpenClawStateDatabase) {
  return getNodeSqliteKysely<SkillUploadDatabase>(database.db);
}

function boolFromSqlite(value: number | bigint): boolean {
  return Number(value) !== 0;
}

function numberFromSqlite(value: number | bigint | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

function rowToRecord(row: SkillUploadRow, archivePath: string): SkillUploadRecord {
  return {
    version: 1,
    kind: "skill-archive",
    uploadId: row.upload_id,
    slug: row.slug,
    force: boolFromSqlite(row.force),
    sizeBytes: Number(row.size_bytes),
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.actual_sha256 ? { actualSha256: row.actual_sha256 } : {}),
    receivedBytes: Number(row.received_bytes),
    archivePath,
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    committed: boolFromSqlite(row.committed),
    ...(numberFromSqlite(row.committed_at) !== undefined
      ? { committedAt: numberFromSqlite(row.committed_at) }
      : {}),
    ...(row.idempotency_key_hash ? { idempotencyKeyHash: row.idempotency_key_hash } : {}),
  };
}

function readBlob(row: SkillUploadRow): Buffer {
  return Buffer.from(row.archive_blob);
}

async function withTemporaryArchive<T>(
  record: SkillUploadRecord,
  archive: Buffer,
  action: (record: SkillUploadRecord, controls: { remove: () => Promise<void> }) => Promise<T>,
  remove: () => Promise<void>,
): Promise<T> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-upload-"));
  const archivePath = path.join(tempDir, "archive.zip");
  try {
    await fs.writeFile(archivePath, archive, { mode: 0o600 });
    return await action({ ...record, archivePath }, { remove });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function assertNotExpired(
  stateDbOptions: OpenClawStateDatabaseOptions,
  record: SkillUploadRecord,
  now: number,
): Promise<void> {
  if (record.expiresAt <= now) {
    await removeRecordFiles(stateDbOptions, record);
    throw new SkillUploadRequestError("upload has expired");
  }
}

function computeBufferSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readRow(
  stateDbOptions: OpenClawStateDatabaseOptions,
  uploadId: string,
): SkillUploadRow | null {
  const database = openOpenClawStateDatabase(stateDbOptions);
  const db = getUploadDatabase(database);
  return (
    executeSqliteQueryTakeFirstSync(
      database.db,
      db.selectFrom("skill_uploads").selectAll().where("upload_id", "=", uploadId),
    ) ?? null
  );
}

async function readRecord(
  stateDbOptions: OpenClawStateDatabaseOptions,
  uploadId: string,
): Promise<SkillUploadRecord> {
  const row = readRow(stateDbOptions, uploadId);
  if (!row) {
    throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
  }
  return rowToRecord(row, "");
}

async function readRecordIfPresent(
  stateDbOptions: OpenClawStateDatabaseOptions,
  uploadId: string,
): Promise<SkillUploadRecord | null> {
  const row = readRow(stateDbOptions, uploadId);
  return row ? rowToRecord(row, "") : null;
}

function writeRecord(
  stateDbOptions: OpenClawStateDatabaseOptions,
  record: SkillUploadRecord,
  archiveBlob?: Buffer,
): void {
  runOpenClawStateWriteTransaction((database) => {
    const db = getUploadDatabase(database);
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("skill_uploads")
        .values({
          upload_id: record.uploadId,
          kind: record.kind,
          slug: record.slug,
          force: record.force ? 1 : 0,
          size_bytes: record.sizeBytes,
          sha256: record.sha256 ?? null,
          actual_sha256: record.actualSha256 ?? null,
          received_bytes: record.receivedBytes,
          archive_blob: archiveBlob ?? Buffer.alloc(0),
          created_at: record.createdAt,
          expires_at: record.expiresAt,
          committed: record.committed ? 1 : 0,
          committed_at: record.committedAt ?? null,
          idempotency_key_hash: record.idempotencyKeyHash ?? null,
        })
        .onConflict((conflict) =>
          conflict.column("upload_id").doUpdateSet({
            kind: record.kind,
            slug: record.slug,
            force: record.force ? 1 : 0,
            size_bytes: record.sizeBytes,
            sha256: record.sha256 ?? null,
            actual_sha256: record.actualSha256 ?? null,
            received_bytes: record.receivedBytes,
            ...(archiveBlob ? { archive_blob: archiveBlob } : {}),
            expires_at: record.expiresAt,
            committed: record.committed ? 1 : 0,
            committed_at: record.committedAt ?? null,
            idempotency_key_hash: record.idempotencyKeyHash ?? null,
          }),
        ),
    );
  }, stateDbOptions);
}

function removeUploadRow(stateDbOptions: OpenClawStateDatabaseOptions, uploadId: string): boolean {
  return runOpenClawStateWriteTransaction((database) => {
    const db = getUploadDatabase(database);
    const result = executeSqliteQuerySync(
      database.db,
      db.deleteFrom("skill_uploads").where("upload_id", "=", uploadId),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, stateDbOptions);
}

async function removeRecordFiles(
  stateDbOptions: OpenClawStateDatabaseOptions,
  record: SkillUploadRecord,
): Promise<void> {
  removeUploadRow(stateDbOptions, record.uploadId);
}

async function listUploadIds(stateDbOptions: OpenClawStateDatabaseOptions): Promise<string[]> {
  const database = openOpenClawStateDatabase(stateDbOptions);
  const db = getUploadDatabase(database);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("skill_uploads").select("upload_id").orderBy("created_at", "asc"),
  ).rows.map((row) => row.upload_id);
}

async function cleanupExpiredUploads(
  stateDbOptions: OpenClawStateDatabaseOptions,
  nowMs: number,
  excludeUploadId?: string,
): Promise<void> {
  for (const uploadId of await listUploadIds(stateDbOptions)) {
    if (uploadId === excludeUploadId) {
      continue;
    }
    await withLock(`${stateDbOptions.path ?? "default"}:upload:${uploadId}`, async () => {
      const record = await readRecordIfPresent(stateDbOptions, uploadId).catch(() => null);
      if (record && record.expiresAt <= nowMs) {
        await removeRecordFiles(stateDbOptions, record);
      }
    });
  }
}

async function countActiveUploads(
  stateDbOptions: OpenClawStateDatabaseOptions,
  nowMs: number,
): Promise<number> {
  const database = openOpenClawStateDatabase(stateDbOptions);
  const db = getUploadDatabase(database);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    db
      .selectFrom("skill_uploads")
      .select(({ fn }) => fn.count<number>("upload_id").as("count"))
      .where("expires_at", ">", nowMs),
  );
  return Number(row?.count ?? 0);
}

async function writeArchiveChunk(params: {
  stateDbOptions: OpenClawStateDatabaseOptions;
  record: SkillUploadRecord;
  offset: number;
  decoded: Buffer;
}): Promise<void> {
  runOpenClawStateWriteTransaction((database) => {
    const db = getUploadDatabase(database);
    const row = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("skill_uploads")
        .select(["archive_blob"])
        .where("upload_id", "=", params.record.uploadId),
    );
    if (!row) {
      throw new SkillUploadRequestError(`upload not found: ${params.record.uploadId}`);
    }
    const existing = Buffer.from(row.archive_blob).subarray(0, params.offset);
    const archiveBlob = Buffer.concat([existing, params.decoded]);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("skill_uploads")
        .set({
          archive_blob: archiveBlob,
          received_bytes: params.record.receivedBytes + params.decoded.length,
        })
        .where("upload_id", "=", params.record.uploadId),
    );
  }, params.stateDbOptions);
}

async function readCommittedRecord(
  stateDbOptions: OpenClawStateDatabaseOptions,
  uploadId: string,
  nowMs: number,
): Promise<{ record: SkillUploadRecord; archive: Buffer }> {
  const row = readRow(stateDbOptions, uploadId);
  if (!row) {
    throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
  }
  const record = rowToRecord(row, "");
  await assertNotExpired(stateDbOptions, record, nowMs);
  if (!record.committed) {
    throw new SkillUploadRequestError("upload is not committed");
  }
  if (!record.actualSha256) {
    throw new SkillUploadRequestError("committed upload is missing sha256");
  }
  const archive = readBlob(row);
  if (archive.length !== record.sizeBytes) {
    throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
  }
  return { record, archive };
}

export function createSkillUploadStore(options?: {
  rootDir?: string;
  now?: () => number;
  ttlMs?: number;
}) {
  const stateDbOptions = resolveStateDatabaseOptions(options?.rootDir);
  const lockPrefix = stateDbOptions.path ?? "default";
  const now = options?.now ?? Date.now;
  const ttlMs = options?.ttlMs ?? SKILL_UPLOAD_TTL_MS;

  return {
    rootDir: options?.rootDir ? path.resolve(options.rootDir) : undefined,
    async begin(params: BeginParams) {
      return await withLock(`${lockPrefix}:begin`, async () => {
        await cleanupExpiredUploads(stateDbOptions, now());
        if (params.kind !== "skill-archive") {
          throw new SkillUploadRequestError("unsupported upload kind");
        }
        const slug = validateUploadSlug(params.slug);
        const sizeBytes = validateSizeBytes(params.sizeBytes);
        const sha256 = normalizeSkillUploadSha256(params.sha256);
        const force = params.force === true;
        const idempotencyKey = validateIdempotencyKey(params.idempotencyKey);
        const keyHash = idempotencyKey ? hashText(idempotencyKey) : undefined;
        if (keyHash) {
          const database = openOpenClawStateDatabase(stateDbOptions);
          const db = getUploadDatabase(database);
          const existing = executeSqliteQueryTakeFirstSync(
            database.db,
            db.selectFrom("skill_uploads").selectAll().where("idempotency_key_hash", "=", keyHash),
          );
          if (existing) {
            if (
              existing.kind !== params.kind ||
              existing.slug !== slug ||
              boolFromSqlite(existing.force) !== force ||
              Number(existing.size_bytes) !== sizeBytes ||
              existing.sha256 !== sha256
            ) {
              throw new SkillUploadRequestError("idempotencyKey conflicts with a different upload");
            }
            const existingUploadId = validateUploadId(existing.upload_id);
            const activeExisting = await withLock(
              `${lockPrefix}:upload:${existingUploadId}`,
              async () => {
                const record = await readRecordIfPresent(stateDbOptions, existingUploadId);
                if (record && record.expiresAt > now()) {
                  return {
                    uploadId: record.uploadId,
                    receivedBytes: record.receivedBytes,
                    expiresAt: record.expiresAt,
                  };
                }
                if (record) {
                  await removeRecordFiles(stateDbOptions, record);
                } else {
                  removeUploadRow(stateDbOptions, existingUploadId);
                }
                return null;
              },
            );
            if (activeExisting) {
              return activeExisting;
            }
          }
        }

        if ((await countActiveUploads(stateDbOptions, now())) >= MAX_ACTIVE_SKILL_UPLOADS) {
          throw new SkillUploadRequestError("too many active skill uploads");
        }

        const uploadId = randomUUID();
        const createdAt = now();
        const record: SkillUploadRecord = {
          version: 1,
          kind: params.kind,
          uploadId,
          slug,
          force,
          sizeBytes,
          ...(sha256 ? { sha256 } : {}),
          receivedBytes: 0,
          archivePath: "",
          createdAt,
          expiresAt: createdAt + ttlMs,
          committed: false,
          ...(keyHash ? { idempotencyKeyHash: keyHash } : {}),
        };

        writeRecord(stateDbOptions, record, Buffer.alloc(0));
        return {
          uploadId,
          receivedBytes: 0,
          expiresAt: record.expiresAt,
        };
      });
    },
    async chunk(params: ChunkParams) {
      const uploadId = validateUploadId(params.uploadId);
      const offset = validateOffset(params.offset);
      const decoded = decodeBase64Chunk(params.dataBase64);
      await cleanupExpiredUploads(stateDbOptions, now(), uploadId);
      return await withLock(`${lockPrefix}:upload:${uploadId}`, async () => {
        const record = await readRecord(stateDbOptions, uploadId);
        await assertNotExpired(stateDbOptions, record, now());
        if (record.committed) {
          throw new SkillUploadRequestError("upload is already committed");
        }
        if (offset !== record.receivedBytes) {
          throw new SkillUploadRequestError(
            `upload offset mismatch: expected ${record.receivedBytes}, got ${offset}`,
          );
        }
        const nextSize = record.receivedBytes + decoded.length;
        if (nextSize > record.sizeBytes) {
          throw new SkillUploadRequestError("upload chunk exceeds declared size");
        }
        const nextRecord = {
          ...record,
          receivedBytes: nextSize,
        };
        await writeArchiveChunk({
          stateDbOptions,
          record,
          offset: record.receivedBytes,
          decoded,
        });
        writeRecord(stateDbOptions, nextRecord);
        return {
          uploadId,
          receivedBytes: nextRecord.receivedBytes,
          expiresAt: nextRecord.expiresAt,
        };
      });
    },
    async commit(params: CommitParams) {
      const uploadId = validateUploadId(params.uploadId);
      const requestedSha = normalizeSkillUploadSha256(params.sha256);
      return await withLock(`${lockPrefix}:upload:${uploadId}`, async () => {
        const row = readRow(stateDbOptions, uploadId);
        if (!row) {
          throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
        }
        const record = rowToRecord(row, "");
        const archive = readBlob(row);
        await assertNotExpired(stateDbOptions, record, now());
        if (record.committed) {
          if (!record.actualSha256) {
            throw new SkillUploadRequestError("committed upload is missing sha256");
          }
          if (requestedSha && requestedSha !== record.actualSha256) {
            throw new SkillUploadRequestError("upload sha256 mismatch");
          }
          return {
            uploadId,
            receivedBytes: record.receivedBytes,
            sha256: record.actualSha256,
            expiresAt: record.expiresAt,
          };
        }
        if (record.receivedBytes !== record.sizeBytes) {
          throw new SkillUploadRequestError(
            `upload size mismatch: expected ${record.sizeBytes}, got ${record.receivedBytes}`,
          );
        }
        if (archive.length !== record.sizeBytes) {
          throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
        }
        if (record.sha256 && requestedSha && record.sha256 !== requestedSha) {
          throw new SkillUploadRequestError("upload sha256 does not match begin sha256");
        }
        const actualSha256 = computeBufferSha256(archive);
        const expectedSha = requestedSha ?? record.sha256;
        if (expectedSha && expectedSha !== actualSha256) {
          throw new SkillUploadRequestError("upload sha256 mismatch");
        }
        const nextRecord = {
          ...record,
          sha256: record.sha256 ?? requestedSha ?? actualSha256,
          actualSha256,
          committed: true,
          committedAt: now(),
        };
        writeRecord(stateDbOptions, nextRecord);
        return {
          uploadId,
          receivedBytes: nextRecord.receivedBytes,
          sha256: actualSha256,
          expiresAt: nextRecord.expiresAt,
        };
      });
    },
    async withCommittedUpload<T>(
      uploadIdRaw: string,
      action: (record: SkillUploadRecord, controls: { remove: () => Promise<void> }) => Promise<T>,
    ): Promise<T> {
      const uploadId = validateUploadId(uploadIdRaw);
      return await withLock(`${lockPrefix}:upload:${uploadId}`, async () => {
        const { record, archive } = await readCommittedRecord(stateDbOptions, uploadId, now());
        return await withTemporaryArchive(
          record,
          archive,
          action,
          async () => await removeRecordFiles(stateDbOptions, record),
        );
      });
    },
    async remove(uploadIdRaw: string): Promise<void> {
      const uploadId = validateUploadId(uploadIdRaw);
      await withLock(`${lockPrefix}:upload:${uploadId}`, async () => {
        removeUploadRow(stateDbOptions, uploadId);
      });
    },
  };
}

export const defaultSkillUploadStore = createSkillUploadStore();
