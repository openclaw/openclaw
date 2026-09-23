// Skill upload store persists uploaded skill archives before installation.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MAX_ARCHIVE_BYTES_ZIP } from "../../infra/archive.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createAsyncLock } from "../../infra/json-files.js";
import { withTempWorkspace } from "../../infra/private-temp-workspace.js";
import type { SqliteWorkerStore } from "../../infra/sqlite-worker-contract.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { validateRequestedSkillSlug } from "./install-paths.js";
import { SkillUploadRequestError } from "./upload-store-error.js";
import {
  resolveSkillUploadDatabaseOptions,
  type SkillUploadMetadataRow,
} from "./upload-store.sqlite.js";
import type { SkillUploadWorkerOperations } from "./upload-store.worker.js";
type SkillUploadScope = Pick<SqliteWorkerStore<SkillUploadWorkerOperations>, "execute">;

/** Time window in which uploaded skill archive chunks may be committed. */
const SKILL_UPLOAD_TTL_MS = 60 * 60 * 1000;
const SKILL_UPLOAD_INSTALL_LEASE_MS = 15 * 60 * 1000;
const SKILL_UPLOAD_INSTALL_HEARTBEAT_MS = 30 * 1000;
const MAX_SKILL_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_SKILL_UPLOAD_BASE64_LENGTH = Math.ceil(MAX_SKILL_UPLOAD_CHUNK_BYTES / 3) * 4;
const SKILL_UPLOAD_IDEMPOTENCY_KEY_MAX_LENGTH = 2048;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SkillUploadStoreOptions = OpenClawStateDatabaseOptions & {
  installLeaseHeartbeatMs?: number;
  installLeaseMs?: number;
  tempRootDir?: string;
  ttlMs?: number;
};

const locks = new Map<string, { lock: ReturnType<typeof createAsyncLock>; references: number }>();

type SkillUploadRecord = {
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

function resolvePositiveDuration(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function decodeBase64Chunk(dataBase64: string): Buffer {
  const normalized = dataBase64.trim();
  if (normalized.length > MAX_SKILL_UPLOAD_BASE64_LENGTH) {
    throw new SkillUploadRequestError("upload chunk exceeds maximum size");
  }
  if (!normalized || normalized.length % 4 !== 0) {
    throw new SkillUploadRequestError("invalid dataBase64");
  }
  const paddingLength = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const contentLength = normalized.length - paddingLength;
  for (let index = 0; index < contentLength; index += 1) {
    const code = normalized.charCodeAt(index);
    const isBase64Character =
      (code >= 0x41 && code <= 0x5a) ||
      (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) ||
      code === 0x2b ||
      code === 0x2f;
    if (!isBase64Character) {
      throw new SkillUploadRequestError("invalid dataBase64");
    }
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

async function cleanupExpiredUploads(
  scope: SkillUploadScope,
  lockRoot: string,
  excludeUploadId?: string,
): Promise<void> {
  const expired = await scope.execute({ type: "skillUploads.expired", input: undefined });
  for (const uploadId of expired) {
    if (uploadId === excludeUploadId) {
      continue;
    }
    await withLock(`${lockRoot}:upload:${uploadId}`, async () => {
      await scope.execute({ type: "skillUploads.deleteExpired", input: { uploadId } });
    });
  }
}

function toSkillUploadRecord(row: SkillUploadMetadataRow, archivePath: string): SkillUploadRecord {
  return {
    version: 1,
    kind: "skill-archive",
    uploadId: row.upload_id,
    slug: row.slug,
    force: row.force === 1,
    sizeBytes: row.size_bytes,
    ...(row.sha256 ? { sha256: row.sha256 } : {}),
    ...(row.actual_sha256 ? { actualSha256: row.actual_sha256 } : {}),
    receivedBytes: row.received_bytes,
    archivePath,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    committed: row.committed === 1,
    ...(row.committed_at !== null ? { committedAt: row.committed_at } : {}),
    ...(row.idempotency_key_hash ? { idempotencyKeyHash: row.idempotency_key_hash } : {}),
  };
}

function createSkillUploadStore(options?: SkillUploadStoreOptions) {
  const stateOptions = resolveSkillUploadDatabaseOptions(options ?? {});
  const ttlMs = options?.ttlMs ?? SKILL_UPLOAD_TTL_MS;
  const tempRootDir = options?.tempRootDir;
  const installLeaseMs = resolvePositiveDuration(
    options?.installLeaseMs,
    SKILL_UPLOAD_INSTALL_LEASE_MS,
  );
  const installLeaseHeartbeatMs = resolvePositiveDuration(
    options?.installLeaseHeartbeatMs,
    SKILL_UPLOAD_INSTALL_HEARTBEAT_MS,
  );

  return {
    async begin(params: BeginParams) {
      const request = { ...params };
      const context = captureOpenClawStateWorkerContext(stateOptions);
      const root = context.admission.databasePath;
      return await withLock(`${root}:begin`, async () => {
        const { runOpenClawStateWorkerOperation } =
          await import("../../state/openclaw-state-worker-store.js");
        return runOpenClawStateWorkerOperation(context, async (scope) => {
          await cleanupExpiredUploads(scope, root);
          if (request.kind !== "skill-archive") {
            throw new SkillUploadRequestError("unsupported upload kind");
          }
          const slug = validateUploadSlug(request.slug);
          const sizeBytes = validateSizeBytes(request.sizeBytes);
          const sha256 = normalizeSkillUploadSha256(request.sha256);
          const force = request.force === true;
          const idempotencyKey = validateIdempotencyKey(request.idempotencyKey);
          const keyHash = idempotencyKey ? sha256Hex(idempotencyKey) : undefined;
          return scope.execute({
            type: "skillUploads.begin",
            input: {
              kind: request.kind,
              slug,
              sizeBytes,
              sha256,
              force,
              keyHash,
              ttlMs,
            },
          });
        });
      });
    },

    async chunk(params: ChunkParams) {
      const uploadId = validateUploadId(params.uploadId);
      const offset = validateOffset(params.offset);
      const decoded = decodeBase64Chunk(params.dataBase64);
      const context = captureOpenClawStateWorkerContext(stateOptions);
      const root = context.admission.databasePath;
      const { runOpenClawStateWorkerOperation } =
        await import("../../state/openclaw-state-worker-store.js");
      return runOpenClawStateWorkerOperation(context, async (scope) => {
        await cleanupExpiredUploads(scope, root, uploadId);
        return withLock(`${root}:upload:${uploadId}`, () =>
          scope.execute({
            type: "skillUploads.chunk",
            input: { uploadId, offset, decoded },
          }),
        );
      });
    },

    async commit(params: CommitParams) {
      const uploadId = validateUploadId(params.uploadId);
      const requestedSha = normalizeSkillUploadSha256(params.sha256);
      const context = captureOpenClawStateWorkerContext(stateOptions);
      return await withLock(`${context.admission.databasePath}:upload:${uploadId}`, async () => {
        const { executeOpenClawStateWorker } =
          await import("../../state/openclaw-state-worker-store.js");
        return executeOpenClawStateWorker(context, {
          type: "skillUploads.commit",
          input: { uploadId, requestedSha },
        });
      });
    },

    async withCommittedUpload<T>(
      uploadIdRaw: string,
      action: (record: SkillUploadRecord, controls: { remove: () => Promise<void> }) => Promise<T>,
    ): Promise<T> {
      const uploadId = validateUploadId(uploadIdRaw);
      const context = captureOpenClawStateWorkerContext(stateOptions);
      return withLock(`${context.admission.databasePath}:upload:${uploadId}`, async () => {
        const { runOpenClawStateWorkerOperation } =
          await import("../../state/openclaw-state-worker-store.js");
        const { withSkillUploadInstallOwner } = await import("./upload-store-install-owner.js");
        const owner = randomUUID();
        return withSkillUploadInstallOwner(context, { uploadId, owner }, (claimStarted) =>
          runOpenClawStateWorkerOperation(context, async (scope) => {
            claimStarted();
            const row = await scope.execute({
              type: "skillUploads.claim",
              input: {
                uploadId,
                leaseOwner: owner,
                installLeaseMs,
              },
            });
            context.admission.assertCurrent();
            let renewal: Promise<void> | undefined;
            let renewalPaused = 0;
            let installing = true;
            const heartbeat = setInterval(() => {
              if (!installing || renewalPaused || renewal) {
                return;
              }
              renewal = scope
                .execute({
                  type: "skillUploads.renew",
                  input: {
                    uploadId,
                    owner,
                    installLeaseMs,
                  },
                })
                .then(
                  () => undefined,
                  () => undefined,
                )
                .finally(() => {
                  renewal = undefined;
                });
            }, installLeaseHeartbeatMs);
            heartbeat.unref();
            try {
              return await withTempWorkspace(
                {
                  rootDir: tempRootDir ?? resolvePreferredOpenClawTmpDir(),
                  prefix: "openclaw-skill-upload-",
                },
                async (tmp) => {
                  const archivePath = path.join(tmp.dir, "archive.zip");
                  await fs.writeFile(archivePath, row.archive_blob, { mode: 0o600 });
                  context.admission.assertCurrent();
                  return action(toSkillUploadRecord(row, archivePath), {
                    remove: async () => {
                      renewalPaused += 1;
                      try {
                        await renewal;
                        const result = await scope.execute({
                          type: "skillUploads.consume",
                          input: {
                            uploadId,
                            owner,
                          },
                        });
                        if (result === "not-owner") {
                          throw new SkillUploadRequestError(
                            "upload install lease is no longer active",
                          );
                        }
                      } finally {
                        renewalPaused -= 1;
                      }
                    },
                  });
                },
              );
            } finally {
              installing = false;
              clearInterval(heartbeat);
              await renewal;
            }
          }),
        );
      });
    },
  };
}

export const defaultSkillUploadStore = createSkillUploadStore();

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.skillUploadStoreTestApi")] = {
    createSkillUploadStore,
  };
}
