import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { hydrateSkillLibraryWorkerAuthority } from "./service.kernel.js";
import {
  requireSkillLibraryProfile,
  requireSkillLibraryUpload,
  selectSkillLibraryOwner,
  skillLibraryDb,
} from "./store.js";
import type { SkillLibraryUploadInput } from "./store.worker-contract.js";

const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_ACTIVE_UPLOADS = 32;

export function prepareSkillLibraryUploadChunk(params: SkillLibraryUploadInput["params"]) {
  if (params.action === "begin") {
    return undefined;
  }
  const bytes = Buffer.from(params.data, "base64");
  if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.toString("base64") !== params.data) {
    throw new SkillLibraryError(
      "INVALID_BUNDLE",
      "Invalid upload chunk; send canonical base64, at most 256 KiB decoded.",
    );
  }
  return bytes;
}

export function uploadSkillLibraryInDatabase(
  db: DatabaseSync,
  input: SkillLibraryUploadInput,
  bytes?: Buffer,
) {
  const { params } = input;
  const authority = hydrateSkillLibraryWorkerAuthority(input.authority);
  if (params.action === "begin") {
    const actor = requireSkillLibraryProfile(db, authority);
    const kysely = skillLibraryDb(db);
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("skill_library_uploads").where("expires_at", "<=", Date.now()),
    );
    // Completed receipts remain replayable without occupying an active upload slot.
    const activeUploads = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("skill_library_uploads")
        .select("owner_profile_id")
        .where("published_skill_id", "is", null)
        .limit(MAX_ACTIVE_UPLOADS),
    ).rows;
    // One canonical profile may fill only half the pool, including uploads begun before a merge.
    if (
      activeUploads.length >= MAX_ACTIVE_UPLOADS ||
      activeUploads.filter(
        (upload) => selectSkillLibraryOwner(db, upload.owner_profile_id)?.id === actor,
      ).length >=
        MAX_ACTIVE_UPLOADS / 2
    ) {
      throw new SkillLibraryError(
        "LIMIT",
        "Active import limit reached for your profile or the Gateway. Finish an existing import or retry after it expires.",
      );
    }
    const uploadId = randomUUID();
    executeSqliteQuerySync(
      db,
      kysely.insertInto("skill_library_uploads").values({
        upload_id: uploadId,
        owner_profile_id: actor,
        slug: params.slug,
        size_bytes: params.sizeBytes,
        sha256: params.sha256,
        archive_blob: Buffer.alloc(0),
        expires_at: Date.now() + 3_600_000,
        published_skill_id: null,
      }),
    );
    return { uploadId, offset: 0, maxChunkBytes: MAX_CHUNK_BYTES };
  }
  if (!bytes) {
    throw new SkillLibraryError("INVALID_BUNDLE", "Upload chunk bytes were not prepared.");
  }
  const upload = requireSkillLibraryUpload(db, params.uploadId, authority);
  const current = Buffer.from(upload.archive_blob);
  if (
    upload.published_skill_id ||
    params.offset !== current.length ||
    current.length + bytes.length > upload.size_bytes
  ) {
    throw new SkillLibraryError(
      "CONFLICT",
      "Upload offset changed or upload completed. Start a new import.",
    );
  }
  const next = Buffer.concat([current, bytes]);
  executeSqliteQuerySync(
    db,
    skillLibraryDb(db)
      .updateTable("skill_library_uploads")
      .set({ archive_blob: next })
      .where("upload_id", "=", params.uploadId),
  );
  return { uploadId: params.uploadId, offset: next.length, maxChunkBytes: MAX_CHUNK_BYTES };
}
