import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { SkillUploadRequestError } from "./upload-store-error.js";
import {
  assertNotExpired,
  deleteExpiredSkillUploadUnlessLeasedInDatabase,
  readSkillUploadArchiveChunks,
  requireUploadMetadata,
  selectSkillUploadMetadata,
  type SkillUploadDatabase,
  type SkillUploadMetadataRow,
} from "./upload-store.sqlite.js";

function assembleArchive(
  chunks: Array<{ byte_offset: number; size_bytes: number; chunk_blob: Uint8Array }>,
  expectedSize: number,
): Buffer {
  let offset = 0;
  const buffers: Uint8Array[] = [];
  for (const chunk of chunks) {
    const bytes = chunk.chunk_blob;
    if (chunk.byte_offset !== offset || chunk.size_bytes !== bytes.length || bytes.length < 1) {
      throw new SkillUploadRequestError("uploaded archive chunks are incomplete");
    }
    buffers.push(bytes);
    offset += bytes.length;
  }
  if (offset !== expectedSize) {
    throw new SkillUploadRequestError("uploaded archive chunks are incomplete");
  }
  return Buffer.concat(buffers, expectedSize);
}

function toCommitResult(row: SkillUploadMetadataRow, requestedSha: string | undefined) {
  if (!row.actual_sha256) {
    throw new SkillUploadRequestError("committed upload is missing sha256");
  }
  if (requestedSha && requestedSha !== row.actual_sha256) {
    throw new SkillUploadRequestError("upload sha256 mismatch");
  }
  return {
    uploadId: row.upload_id,
    receivedBytes: row.received_bytes,
    sha256: row.actual_sha256,
    expiresAt: row.expires_at,
  };
}

export function commitSkillUploadInDatabase(
  params: { uploadId: string; requestedSha?: string },
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
) {
  const { uploadId, requestedSha } = params;
  const row = requireUploadMetadata(uploadId, options);
  assertNotExpired(row, Date.now(), options);
  if (row.committed === 1) {
    return toCommitResult(row, requestedSha);
  }
  if (row.received_bytes !== row.size_bytes) {
    throw new SkillUploadRequestError(
      `upload size mismatch: expected ${row.size_bytes}, got ${row.received_bytes}`,
    );
  }
  if (row.sha256 && requestedSha && row.sha256 !== requestedSha) {
    throw new SkillUploadRequestError("upload sha256 does not match begin sha256");
  }

  let archive: Buffer;
  try {
    archive = assembleArchive(readSkillUploadArchiveChunks(uploadId, options), row.size_bytes);
  } catch (err) {
    // Another process may commit and delete chunks after our metadata read.
    // The committed parent row is the idempotent authority in that race.
    const current = requireUploadMetadata(uploadId, options);
    if (current.committed === 1) {
      assertNotExpired(current, Date.now(), options);
      return toCommitResult(current, requestedSha);
    }
    throw err;
  }
  const actualSha256 = sha256Hex(archive);
  const expectedSha = requestedSha ?? row.sha256 ?? undefined;
  if (expectedSha && expectedSha !== actualSha256) {
    throw new SkillUploadRequestError("upload sha256 mismatch");
  }
  type CommitOutcome =
    | { expired: true }
    | { expired: false; result: ReturnType<typeof toCommitResult> };
  const outcome = runOpenClawStateWriteTransaction(({ db }): CommitOutcome => {
    const kysely = getNodeSqliteKysely<SkillUploadDatabase>(db);
    const current = executeSqliteQueryTakeFirstSync(
      db,
      selectSkillUploadMetadata(kysely).where("upload_id", "=", uploadId),
    );
    if (!current) {
      throw new SkillUploadRequestError(`upload not found: ${uploadId}`);
    }
    const committedAt = Date.now();
    if (!isFutureDateTimestampMs(current.expires_at, { nowMs: committedAt })) {
      deleteExpiredSkillUploadUnlessLeasedInDatabase(db, { uploadId, nowMs: committedAt });
      return { expired: true };
    }
    if (current.committed === 1) {
      return { expired: false, result: toCommitResult(current, requestedSha) };
    }
    if (current.received_bytes !== current.size_bytes || current.size_bytes !== archive.length) {
      throw new SkillUploadRequestError("uploaded archive chunks changed during commit");
    }
    executeSqliteQuerySync(
      db,
      kysely
        .updateTable("skill_uploads")
        .set({
          actual_sha256: actualSha256,
          archive_blob: archive,
          committed: 1,
          committed_at: committedAt,
        })
        .where("upload_id", "=", uploadId),
    );
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("skill_upload_chunks").where("upload_id", "=", uploadId),
    );
    return {
      expired: false,
      result: {
        uploadId,
        receivedBytes: current.received_bytes,
        sha256: actualSha256,
        expiresAt: current.expires_at,
      },
    };
  }, options);
  // The expired-row cleanup must commit before the request error escapes.
  if (outcome.expired) {
    throw new SkillUploadRequestError("upload has expired");
  }
  return outcome.result;
}
