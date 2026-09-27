import { randomUUID } from "node:crypto";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { requireOpenClawStateDatabaseIdentity } from "../../state/openclaw-state-db-cache.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { SkillUploadRequestError } from "./upload-store-error.js";
import {
  assertNotExpired,
  deleteExpiredSkillUploadUnlessLeasedInDatabase,
  deleteSkillUploadState,
  hasLiveSkillUploadInstallLease,
  requireUploadMetadata,
  selectSkillUploadMetadata,
  SKILL_UPLOAD_LEASE_SCOPE,
  type SkillUploadDatabase,
  type SkillUploadMetadataRow,
} from "./upload-store.sqlite.js";

type Options = OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase };
const MAX_ACTIVE_SKILL_UPLOADS = 32;

function matchesBegin(
  row: SkillUploadMetadataRow,
  params: {
    kind: "skill-archive";
    slug: string;
    force: boolean;
    sizeBytes: number;
    sha256?: string;
  },
): boolean {
  return (
    row.kind === params.kind &&
    row.slug === params.slug &&
    row.force === (params.force ? 1 : 0) &&
    row.size_bytes === params.sizeBytes &&
    (row.sha256 ?? undefined) === params.sha256
  );
}

export function beginSkillUploadInDatabase(
  params: {
    kind: "skill-archive";
    slug: string;
    force: boolean;
    sizeBytes: number;
    sha256?: string;
    keyHash?: string;
    ttlMs: number;
  },
  options: Options,
) {
  const { slug, force, sizeBytes, sha256, keyHash, ttlMs } = params;
  return runOpenClawStateWriteTransaction(({ db }) => {
    const createdAt = Date.now();
    const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: createdAt });
    if (expiresAt === undefined) {
      throw new SkillUploadRequestError("invalid upload expiry");
    }
    const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
    if (keyHash) {
      const existing = executeSqliteQueryTakeFirstSync(
        db,
        selectSkillUploadMetadata(kysely).where("idempotency_key_hash", "=", keyHash),
      );
      if (existing) {
        if (!matchesBegin(existing, { kind: params.kind, slug, force, sizeBytes, sha256 })) {
          throw new SkillUploadRequestError("idempotencyKey conflicts with a different upload");
        }
        if (isFutureDateTimestampMs(existing.expires_at, { nowMs: createdAt })) {
          return {
            uploadId: existing.upload_id,
            receivedBytes: existing.received_bytes,
            expiresAt: existing.expires_at,
          };
        }
        if (hasLiveSkillUploadInstallLease(db, kysely, existing.upload_id, createdAt)) {
          throw new SkillUploadRequestError("upload is already being installed");
        }
        deleteSkillUploadState(db, kysely, existing.upload_id);
      }
    }

    const atCapacity = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("skill_uploads")
        .select((eb) => eb.val(1).as("present"))
        .where("expires_at", ">", createdAt)
        .offset(MAX_ACTIVE_SKILL_UPLOADS - 1)
        .limit(1),
    );
    if (atCapacity) {
      throw new SkillUploadRequestError("too many active skill uploads");
    }

    const uploadId = randomUUID();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("skill_uploads").values({
        upload_id: uploadId,
        kind: params.kind,
        slug,
        force: force ? 1 : 0,
        size_bytes: sizeBytes,
        sha256: sha256 ?? null,
        actual_sha256: null,
        received_bytes: 0,
        archive_blob: Buffer.alloc(0),
        created_at: createdAt,
        expires_at: expiresAt,
        committed: 0,
        committed_at: null,
        idempotency_key_hash: keyHash ?? null,
      }),
    );
    return { uploadId, receivedBytes: 0, expiresAt };
  }, options);
}

export function appendSkillUploadChunkInDatabase(
  params: {
    uploadId: string;
    offset: number;
    decoded: Uint8Array;
  },
  options: Options,
) {
  const { uploadId, offset, decoded } = params;
  assertNotExpired(requireUploadMetadata(uploadId, options), Date.now(), options);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      selectSkillUploadMetadata(kysely).where("upload_id", "=", uploadId),
    );
    if (!row) {
      throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
    }
    const validNow = asDateTimestampMs(Date.now());
    if (validNow === undefined || !isFutureDateTimestampMs(row.expires_at, { nowMs: validNow })) {
      throw new SkillUploadRequestError("upload has expired");
    }
    if (row.committed === 1) {
      throw new SkillUploadRequestError("upload is already committed");
    }
    if (offset !== row.received_bytes) {
      throw new SkillUploadRequestError(
        `upload offset mismatch: expected ${row.received_bytes}, got ${offset}`,
      );
    }
    const nextSize = row.received_bytes + decoded.length;
    if (nextSize > row.size_bytes) {
      throw new SkillUploadRequestError("upload chunk exceeds declared size");
    }
    executeSqliteQuerySync(
      db,
      kysely.insertInto("skill_upload_chunks").values({
        upload_id: uploadId,
        byte_offset: offset,
        size_bytes: decoded.length,
        chunk_blob: decoded,
      }),
    );
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("skill_uploads")
        .set({ received_bytes: nextSize })
        .where("upload_id", "=", uploadId),
    );
    return { uploadId, receivedBytes: nextSize, expiresAt: row.expires_at };
  }, options);
}

export function claimSkillUploadInDatabase(
  params: {
    uploadId: string;
    leaseOwner: string;
    installLeaseMs: number;
  },
  options: Options,
) {
  const { uploadId, leaseOwner, installLeaseMs } = params;
  assertNotExpired(requireUploadMetadata(uploadId, options), Date.now(), options);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
    const current = executeSqliteQueryTakeFirstSync(
      db,
      kysely.selectFrom("skill_uploads").selectAll().where("upload_id", "=", uploadId),
    );
    if (!current) {
      throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
    }
    const currentTime = Date.now();
    const validNow = asDateTimestampMs(currentTime);
    if (
      validNow === undefined ||
      !isFutureDateTimestampMs(current.expires_at, { nowMs: validNow })
    ) {
      throw new SkillUploadRequestError("upload has expired");
    }
    if (current.committed !== 1) {
      throw new SkillUploadRequestError("upload is not committed");
    }
    if (!current.actual_sha256) {
      throw new SkillUploadRequestError("committed upload is missing sha256");
    }
    if (current.archive_blob.byteLength !== current.size_bytes) {
      throw new SkillUploadRequestError("uploaded archive is missing or incomplete");
    }
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("state_leases")
        .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
        .where("lease_key", "=", uploadId)
        .where("expires_at", "<=", currentTime),
    );
    const claimed = executeSqliteQuerySync(
      db,
      kysely
        .insertInto("state_leases")
        .values({
          scope: SKILL_UPLOAD_LEASE_SCOPE,
          lease_key: uploadId,
          owner: leaseOwner,
          expires_at: currentTime + installLeaseMs,
          heartbeat_at: currentTime,
          payload_json: null,
          created_at: currentTime,
          updated_at: currentTime,
        })
        .onConflict((conflict) => conflict.doNothing()),
    );
    if (claimed.numAffectedRows !== 1n) {
      throw new SkillUploadRequestError("upload is already being installed");
    }
    return current;
  }, options);
}

export function listExpiredSkillUploadsInDatabase(_input: undefined, options: Options): string[] {
  const now = asDateTimestampMs(Date.now());
  if (now === undefined) {
    return [];
  }
  const { db } = options.database;
  return executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<SkillUploadDatabase>(db)
      .selectFrom("skill_uploads")
      .select("upload_id")
      .where("expires_at", "<=", now),
  ).rows.map((row) => row.upload_id);
}

export function deleteExpiredSkillUploadInDatabase(params: { uploadId: string }, options: Options) {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      deleteExpiredSkillUploadUnlessLeasedInDatabase(db, {
        uploadId: params.uploadId,
        nowMs: Date.now(),
      }),
    options,
  );
}

export function releaseSkillUploadInDatabase(
  params: { uploadId: string; owner: string; sharedStateIdentity: string },
  options: Options,
): void {
  runOpenClawStateWriteTransaction((current) => {
    // One native actor can serve multiple locators for the same physical file.
    if (requireOpenClawStateDatabaseIdentity(current).key !== params.sharedStateIdentity) {
      throw new Error("Skill upload cleanup cannot adopt a replacement shared database");
    }
    const { db } = current;
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<SkillUploadDatabase>(db)
        .deleteFrom("state_leases")
        .where("scope", "=", SKILL_UPLOAD_LEASE_SCOPE)
        .where("lease_key", "=", params.uploadId)
        .where("owner", "=", params.owner),
    );
  }, options);
}
