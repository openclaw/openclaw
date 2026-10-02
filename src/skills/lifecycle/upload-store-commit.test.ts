import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { commitSkillUploadInDatabase } from "./upload-store-commit.js";
import {
  beginSkillUploadInDatabase,
  appendSkillUploadChunkInDatabase,
  claimSkillUploadInDatabase,
  deleteExpiredSkillUploadInDatabase,
  listExpiredSkillUploadsInDatabase,
} from "./upload-store.kernel.js";

type RequireUploadMetadata = typeof import("./upload-store.sqlite.js").requireUploadMetadata;

type ReadSkillUploadArchiveChunks =
  typeof import("./upload-store.sqlite.js").readSkillUploadArchiveChunks;

const uploadSqliteMocks = vi.hoisted(() => ({
  defaultRequireUploadMetadata: undefined as RequireUploadMetadata | undefined,
  requireUploadMetadata: vi.fn<RequireUploadMetadata>(),
  defaultReadSkillUploadArchiveChunks: undefined as ReadSkillUploadArchiveChunks | undefined,
  readSkillUploadArchiveChunks: vi.fn<ReadSkillUploadArchiveChunks>(),
}));

vi.mock("./upload-store.sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload-store.sqlite.js")>();
  uploadSqliteMocks.defaultRequireUploadMetadata = actual.requireUploadMetadata;
  uploadSqliteMocks.requireUploadMetadata.mockImplementation(actual.requireUploadMetadata);
  uploadSqliteMocks.defaultReadSkillUploadArchiveChunks = actual.readSkillUploadArchiveChunks;
  uploadSqliteMocks.readSkillUploadArchiveChunks.mockImplementation(
    actual.readSkillUploadArchiveChunks,
  );
  return {
    ...actual,
    requireUploadMetadata: uploadSqliteMocks.requireUploadMetadata,
    readSkillUploadArchiveChunks: uploadSqliteMocks.readSkillUploadArchiveChunks,
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    uploadSqliteMocks.requireUploadMetadata.mockReset();
    uploadSqliteMocks.requireUploadMetadata.mockImplementation(
      uploadSqliteMocks.defaultRequireUploadMetadata!,
    );
    uploadSqliteMocks.readSkillUploadArchiveChunks.mockReset();
    uploadSqliteMocks.readSkillUploadArchiveChunks.mockImplementation(
      uploadSqliteMocks.defaultReadSkillUploadArchiveChunks!,
    );
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
async function makeStore() {
  const root = tempDirs.make("openclaw-skill-upload-commit-");
  const databasePath = path.join(root, "openclaw.sqlite");
  return { databasePath };
}

function stageUpload(databasePath: string, slug: string, archive: Buffer, expectedSha?: string) {
  const options = {
    database: openOpenClawStateDatabase({ path: databasePath }),
    path: databasePath,
  };
  const begun = beginSkillUploadInDatabase(
    {
      kind: "skill-archive",
      slug,
      sizeBytes: archive.length,
      sha256: expectedSha,
      force: false,
      ttlMs: 60_000,
    },
    options,
  );
  appendSkillUploadChunkInDatabase(
    { uploadId: begun.uploadId, offset: 0, decoded: archive },
    options,
  );
  return begun;
}

function stateDatabase(databasePath: string) {
  return openOpenClawStateDatabase({ path: databasePath }).db;
}

function uploadExists(databasePath: string, uploadId: string): boolean {
  return Boolean(
    stateDatabase(databasePath)
      .prepare("SELECT 1 AS found FROM skill_uploads WHERE upload_id = ?")
      .get(uploadId),
  );
}

function chunkCount(databasePath: string, uploadId?: string): number {
  const row = uploadId
    ? stateDatabase(databasePath)
        .prepare("SELECT count(*) AS count FROM skill_upload_chunks WHERE upload_id = ?")
        .get(uploadId)
    : stateDatabase(databasePath)
        .prepare("SELECT count(*) AS count FROM skill_upload_chunks")
        .get();
  return (row as { count: number }).count;
}

function installLeaseCount(databasePath: string, uploadId: string): number {
  return (
    stateDatabase(databasePath)
      .prepare(
        "SELECT count(*) AS count FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
      )
      .get(uploadId) as { count: number }
  ).count;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function advanceClockAtAdmission(
  database: ReturnType<typeof openOpenClawStateDatabase>,
  before: number,
  after: number,
) {
  const clock = vi.spyOn(Date, "now").mockReturnValue(before);
  const admitted = vi.fn();
  const execute = database.db.exec.bind(database.db);
  vi.spyOn(database.db, "exec").mockImplementation((sql) => {
    const result = execute(sql);
    if (sql === "BEGIN IMMEDIATE") {
      expect(database.db.isTransaction).toBe(true);
      admitted();
      clock.mockReturnValue(after);
    }
    return result;
  });
  return admitted;
}

describe("skill upload transaction kernels", () => {
  it.each([Number.NaN, MAX_DATE_TIMESTAMP_MS])(
    "rejects a begin when the admitted clock %s cannot produce a valid expiry",
    async (now) => {
      const { databasePath } = await makeStore();
      const database = openOpenClawStateDatabase({ path: databasePath });
      const admitted = advanceClockAtAdmission(database, Date.now(), now);
      expect(() =>
        beginSkillUploadInDatabase(
          {
            kind: "skill-archive",
            slug: "invalid-clock",
            sizeBytes: 1,
            force: false,
            ttlMs: 60_000,
          },
          { database, path: databasePath },
        ),
      ).toThrow("invalid upload expiry");
      expect(admitted).toHaveBeenCalledOnce();
      expect(database.db.prepare("SELECT count(*) AS count FROM skill_uploads").get()).toEqual({
        count: 0,
      });
    },
  );

  it.each(["idempotency", "capacity"] as const)(
    "starts the full TTL and evaluates %s after admission",
    async (boundary) => {
      const { databasePath } = await makeStore();
      const database = openOpenClawStateDatabase({ path: databasePath });
      const options = { database, path: databasePath };
      const before = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(before);
      const request = {
        kind: "skill-archive" as const,
        slug: "admitted-begin",
        sizeBytes: 1,
        force: false,
        ttlMs: 60_000,
      };
      const first = beginSkillUploadInDatabase({ ...request, keyHash: "same-key" }, options);
      if (boundary === "capacity") {
        for (let index = 1; index < 32; index += 1) {
          beginSkillUploadInDatabase(request, options);
        }
      }
      const admitted = advanceClockAtAdmission(database, before, first.expiresAt);
      const next = beginSkillUploadInDatabase(
        { ...request, ...(boundary === "idempotency" ? { keyHash: "same-key" } : {}) },
        options,
      );
      expect(admitted).toHaveBeenCalledOnce();
      expect(next.uploadId).not.toBe(first.uploadId);
      expect(next.expiresAt).toBe(first.expiresAt + request.ttlMs);
      expect(
        database.db
          .prepare("SELECT created_at, expires_at FROM skill_uploads WHERE upload_id = ?")
          .get(next.uploadId),
      ).toEqual({ created_at: first.expiresAt, expires_at: next.expiresAt });
      if (boundary === "idempotency") {
        expect(uploadExists(databasePath, first.uploadId)).toBe(false);
      }
    },
  );

  it.each(["chunk", "claim"] as const)(
    "rejects %s when upload expiry is crossed during native admission",
    async (operation) => {
      const { databasePath } = await makeStore();
      const database = openOpenClawStateDatabase({ path: databasePath });
      const options = { database, path: databasePath };
      const archive = Buffer.from("a");
      const begun = beginSkillUploadInDatabase(
        {
          kind: "skill-archive",
          slug: "admitted-expiry",
          sizeBytes: operation === "chunk" ? 2 : 1,
          force: false,
          ttlMs: 60_000,
        },
        options,
      );
      appendSkillUploadChunkInDatabase(
        { uploadId: begun.uploadId, offset: 0, decoded: archive },
        options,
      );
      if (operation === "claim") {
        commitSkillUploadInDatabase({ uploadId: begun.uploadId }, options);
      }
      const admitted = advanceClockAtAdmission(database, begun.expiresAt - 1, begun.expiresAt);
      expect(() =>
        operation === "chunk"
          ? appendSkillUploadChunkInDatabase(
              { uploadId: begun.uploadId, offset: 1, decoded: archive },
              options,
            )
          : claimSkillUploadInDatabase(
              { uploadId: begun.uploadId, leaseOwner: "admission-proof", installLeaseMs: 60_000 },
              options,
            ),
      ).toThrow("upload has expired");
      expect(admitted).toHaveBeenCalledOnce();
      expect(chunkCount(databasePath, begun.uploadId)).toBe(operation === "chunk" ? 1 : 0);
      expect(installLeaseCount(databasePath, begun.uploadId)).toBe(0);
    },
  );

  it.each([false, true])(
    "resamples sweep deletion at admission with a lease expiring during admission=%s",
    async (leased) => {
      const { databasePath } = await makeStore();
      const database = openOpenClawStateDatabase({ path: databasePath });
      const options = { database, path: databasePath };
      const begun = stageUpload(databasePath, "sweep-admission", Buffer.from("a"));
      const before = begun.expiresAt - 1;
      const after = begun.expiresAt + 1;
      if (leased) {
        database.db
          .prepare("UPDATE skill_uploads SET expires_at = ? WHERE upload_id = ?")
          .run(before - 1, begun.uploadId);
        database.db
          .prepare(
            "INSERT INTO state_leases (scope, lease_key, owner, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "skill-upload-install",
            begun.uploadId,
            "sweep-proof",
            begun.expiresAt,
            before,
            before,
          );
      }
      const admitted = advanceClockAtAdmission(database, before, after);
      expect(listExpiredSkillUploadsInDatabase(undefined, options)).toEqual(
        leased ? [begun.uploadId] : [],
      );
      expect(deleteExpiredSkillUploadInDatabase({ uploadId: begun.uploadId }, options)).toBe(
        "deleted",
      );
      expect(admitted).toHaveBeenCalledOnce();
      expect(uploadExists(databasePath, begun.uploadId)).toBe(false);
      expect(chunkCount(databasePath, begun.uploadId)).toBe(0);
      expect(installLeaseCount(databasePath, begun.uploadId)).toBe(0);
    },
  );

  it("keeps archive bytes out of metadata reads until the install claim", async () => {
    const { databasePath } = await makeStore();
    const options = {
      database: openOpenClawStateDatabase({ path: databasePath }),
      path: databasePath,
    };
    const db = stateDatabase(databasePath);
    const archiveReads: Array<{ bytes: number; inTransaction: boolean }> = [];
    const nativeBlobs = new WeakSet<Uint8Array>();
    const bufferFrom = vi.spyOn(Buffer, "from");
    const observeRow = (row: Record<string, unknown>) => {
      for (const bytes of [row.chunk_blob, row.archive_blob]) {
        if (bytes instanceof Uint8Array) {
          nativeBlobs.add(bytes);
        }
      }
      if (row.archive_blob instanceof Uint8Array) {
        archiveReads.push({
          bytes: row.archive_blob.byteLength,
          inTransaction: db.isTransaction,
        });
      }
    };
    const nativePrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = nativePrepare(sql);
      const nativeGet = statement.get.bind(statement);
      vi.spyOn(statement, "get").mockImplementation(
        new Proxy(nativeGet, {
          apply(get, _receiver, bindings) {
            const row = get(...bindings);
            if (row) {
              observeRow(row);
            }
            return row;
          },
        }),
      );
      const iterate = statement.iterate.bind(statement);
      vi.spyOn(statement, "iterate").mockImplementation(function* (...bindings) {
        for (const row of iterate(...bindings)) {
          observeRow(row);
          yield row;
        }
        return undefined;
      });
      return statement;
    });
    try {
      const firstChunk = Buffer.alloc(4 * 1024 * 1024, 0x61);
      const secondChunk = Buffer.alloc(4 * 1024 * 1024, 0x62);
      const archive = Buffer.concat([firstChunk, secondChunk]);
      const begin = beginSkillUploadInDatabase(
        {
          kind: "skill-archive",
          slug: "large-skill",
          sizeBytes: archive.length,
          keyHash: "large-upload",
          force: false,
          ttlMs: 60_000,
        },
        options,
      );
      appendSkillUploadChunkInDatabase(
        {
          uploadId: begin.uploadId,
          offset: 0,
          decoded: firstChunk,
        },
        options,
      );
      appendSkillUploadChunkInDatabase(
        {
          uploadId: begin.uploadId,
          offset: firstChunk.length,
          decoded: secondChunk,
        },
        options,
      );
      const staged = stateDatabase(databasePath)
        .prepare("SELECT length(archive_blob) AS bytes FROM skill_uploads WHERE upload_id = ?")
        .get(begin.uploadId) as { bytes: number };
      expect(staged.bytes).toBe(0);
      expect(chunkCount(databasePath, begin.uploadId)).toBe(2);

      commitSkillUploadInDatabase(
        { uploadId: begin.uploadId, requestedSha: sha256(archive) },
        options,
      );
      const committed = stateDatabase(databasePath)
        .prepare("SELECT length(archive_blob) AS bytes FROM skill_uploads WHERE upload_id = ?")
        .get(begin.uploadId) as { bytes: number };
      expect(committed.bytes).toBe(archive.length);
      expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
      expect(
        beginSkillUploadInDatabase(
          {
            kind: "skill-archive",
            slug: "large-skill",
            sizeBytes: archive.length,
            keyHash: "large-upload",
            force: false,
            ttlMs: 60_000,
          },
          options,
        ),
      ).toMatchObject({ uploadId: begin.uploadId, receivedBytes: archive.length });
      expect(commitSkillUploadInDatabase({ uploadId: begin.uploadId }, options)).toMatchObject({
        sha256: sha256(archive),
      });
      expect(() =>
        appendSkillUploadChunkInDatabase(
          {
            uploadId: begin.uploadId,
            offset: archive.length,
            decoded: Buffer.from("a"),
          },
          options,
        ),
      ).toThrow("upload is already committed");
      expect(archiveReads).toEqual([]);
      const claimed = claimSkillUploadInDatabase(
        {
          uploadId: begin.uploadId,
          leaseOwner: "metadata-proof",
          installLeaseMs: 60_000,
        },
        options,
      );
      expect(claimed.archive_blob.constructor).toBe(Uint8Array);
      expect(Buffer.compare(claimed.archive_blob, archive)).toBe(0);
      expect(archiveReads).toEqual([{ bytes: archive.length, inTransaction: true }]);
      const copiedBytes = bufferFrom.mock.calls.reduce((total, [value]) => {
        const input: unknown = value;
        return (
          total + (input instanceof Uint8Array && nativeBlobs.has(input) ? input.byteLength : 0)
        );
      }, 0);
      expect(copiedBytes).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each(["committed", "expired committed", "expired incomplete"] as const)(
    "reconciles chunks deleted before the metadata reread: %s",
    async (outcome) => {
      const { databasePath } = await makeStore();
      const archive = Buffer.from("concurrent-commit");
      const digest = sha256(archive);
      const begin = stageUpload(databasePath, "concurrent-commit-skill", archive, digest);
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let competingWriteFinished = false;
      let rereadObserved = false;
      uploadSqliteMocks.requireUploadMetadata.mockImplementation((uploadId, options) => {
        const row = uploadSqliteMocks.defaultRequireUploadMetadata!(uploadId, options);
        if (competingWriteFinished) {
          rereadObserved = true;
          if (outcome !== "committed") {
            now = begin.expiresAt;
          }
        }
        return row;
      });
      uploadSqliteMocks.readSkillUploadArchiveChunks.mockImplementationOnce((uploadId, options) => {
        const db = stateDatabase(databasePath);
        db.exec("BEGIN IMMEDIATE");
        try {
          if (outcome !== "expired incomplete") {
            db.prepare(
              "UPDATE skill_uploads SET archive_blob = ?, actual_sha256 = ?, committed = 1, committed_at = ? WHERE upload_id = ?",
            ).run(archive, digest, Date.now(), uploadId);
          }
          db.prepare("DELETE FROM skill_upload_chunks WHERE upload_id = ?").run(uploadId);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
        competingWriteFinished = true;
        return uploadSqliteMocks.defaultReadSkillUploadArchiveChunks!(uploadId, options);
      });
      const commit = () =>
        commitSkillUploadInDatabase(
          { uploadId: begin.uploadId, requestedSha: digest },
          { database: openOpenClawStateDatabase({ path: databasePath }), path: databasePath },
        );
      if (outcome === "committed") {
        expect(commit()).toMatchObject({
          uploadId: begin.uploadId,
          receivedBytes: archive.length,
          sha256: digest,
        });
      } else {
        expect(commit).toThrow(
          outcome === "expired committed"
            ? "upload has expired"
            : "uploaded archive chunks are incomplete",
        );
      }
      expect(rereadObserved).toBe(true);
      expect(uploadExists(databasePath, begin.uploadId)).toBe(outcome !== "expired committed");
      expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
    },
  );

  it("rejects publication when the upload expires after chunk assembly", async () => {
    const { databasePath } = await makeStore();
    const archive = Buffer.from("expires-during-commit");
    const begin = stageUpload(databasePath, "expires-during-commit", archive);
    const database = openOpenClawStateDatabase({ path: databasePath });
    let now = begin.expiresAt - 1;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    uploadSqliteMocks.readSkillUploadArchiveChunks.mockImplementationOnce((uploadId, options) => {
      const chunks = uploadSqliteMocks.defaultReadSkillUploadArchiveChunks!(uploadId, options);
      now = begin.expiresAt;
      return chunks;
    });
    expect(() =>
      commitSkillUploadInDatabase({ uploadId: begin.uploadId }, { database, path: databasePath }),
    ).toThrow("upload has expired");
    expect(uploadExists(databasePath, begin.uploadId)).toBe(false);
    expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
  });

  it.each([false, true])(
    "rechecks expiry after transaction admission with external install lease=%s",
    async (leased) => {
      const { databasePath } = await makeStore();
      const archive = Buffer.from("expires-during-admission");
      const begin = stageUpload(databasePath, "admission-expiry", archive);
      const database = openOpenClawStateDatabase({ path: databasePath });
      if (leased) {
        database.db
          .prepare(
            "INSERT INTO state_leases (scope, lease_key, owner, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(
            "skill-upload-install",
            begin.uploadId,
            "external-install",
            begin.expiresAt + 60_000,
            begin.expiresAt - 1,
            begin.expiresAt - 1,
          );
      }
      const admitted = advanceClockAtAdmission(database, begin.expiresAt - 1, begin.expiresAt);
      expect(() =>
        commitSkillUploadInDatabase({ uploadId: begin.uploadId }, { database, path: databasePath }),
      ).toThrow("upload has expired");
      expect(admitted).toHaveBeenCalledOnce();
      expect(uploadExists(databasePath, begin.uploadId)).toBe(leased);
      expect(chunkCount(databasePath, begin.uploadId)).toBe(leased ? 1 : 0);
      if (leased) {
        expect(
          database.db
            .prepare(
              "SELECT committed, length(archive_blob) AS bytes FROM skill_uploads WHERE upload_id = ?",
            )
            .get(begin.uploadId),
        ).toEqual({ committed: 0, bytes: 0 });
        expect(installLeaseCount(databasePath, begin.uploadId)).toBe(1);
      }
    },
  );
});
