import { createHash } from "node:crypto";
import path from "node:path";
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { commitSkillUploadInDatabase } from "./upload-store-commit.js";
import {
  beginSkillUploadInDatabase,
  appendSkillUploadChunkInDatabase,
  claimSkillUploadInDatabase,
  deleteExpiredSkillUploadInDatabase,
  listExpiredSkillUploadsInDatabase,
} from "./upload-store.kernel.js";
import * as uploadSqlite from "./upload-store.sqlite.js";

vi.mock("./upload-store.sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./upload-store.sqlite.js")>();
  return {
    ...actual,
    requireUploadMetadata: vi.fn(actual.requireUploadMetadata),
    readSkillUploadArchiveChunks: vi.fn(actual.readSkillUploadArchiveChunks),
  };
});

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(uploadSqlite.requireUploadMetadata).mockReset();
    vi.mocked(uploadSqlite.readSkillUploadArchiveChunks).mockReset();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
async function makeStore() {
  const root = tempDirs.make("openclaw-skill-upload-commit-");
  const databasePath = path.join(root, "openclaw.sqlite");
  const database = openOpenClawStateDatabase({ path: databasePath });
  const options = { database, path: databasePath };
  const { db } = database;
  const begin = (overrides: Partial<BeginParams> = {}) =>
    beginSkillUploadInDatabase(
      {
        kind: "skill-archive",
        slug: "test-skill",
        sizeBytes: 1,
        force: false,
        ttlMs: 60_000,
        ...overrides,
      },
      options,
    );
  const append = (uploadId: string, decoded: Buffer, offset = 0) =>
    appendSkillUploadChunkInDatabase({ uploadId, decoded, offset }, options);
  return {
    databasePath,
    database,
    options,
    beginUpload: begin,
    append,
    stage: (archive: Buffer, overrides: Partial<BeginParams> = {}) => {
      const upload = begin({ sizeBytes: archive.length, ...overrides });
      append(upload.uploadId, archive);
      return upload;
    },
    commit: (uploadId: string, requestedSha?: string) =>
      commitSkillUploadInDatabase({ uploadId, requestedSha }, options),
    claim: (uploadId: string, leaseOwner: string) =>
      claimSkillUploadInDatabase({ uploadId, leaseOwner, installLeaseMs: 60_000 }, options),
    read: (uploadId: string, columns: string) =>
      db.prepare(`SELECT ${columns} FROM skill_uploads WHERE upload_id = ?`).get(uploadId),
    lease: (uploadId: string, owner: string, expiry: number, now: number) =>
      db
        .prepare(
          "INSERT INTO state_leases (scope, lease_key, owner, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("skill-upload-install", uploadId, owner, expiry, now, now),
  };
}

type BeginParams = Parameters<typeof beginSkillUploadInDatabase>[0];

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

function countRows(databasePath: string, tableAndWhere: string, uploadId: string): number {
  return (
    stateDatabase(databasePath)
      .prepare(`SELECT count(*) AS count FROM ${tableAndWhere}`)
      .get(uploadId) as { count: number }
  ).count;
}
function chunkCount(databasePath: string, uploadId: string) {
  return countRows(databasePath, "skill_upload_chunks WHERE upload_id = ?", uploadId);
}
function installLeaseCount(databasePath: string, uploadId: string) {
  return countRows(
    databasePath,
    "state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
    uploadId,
  );
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
      const { database, beginUpload } = await makeStore();
      const admitted = advanceClockAtAdmission(database, Date.now(), now);
      expect(() => beginUpload({ slug: "invalid-clock" })).toThrow("invalid upload expiry");
      expect(admitted).toHaveBeenCalledOnce();
      expect(database.db.prepare("SELECT count(*) AS count FROM skill_uploads").get()).toEqual({
        count: 0,
      });
    },
  );

  it.each(["idempotency", "capacity"] as const)(
    "starts the full TTL and evaluates %s after admission",
    async (boundary) => {
      const { databasePath, database, beginUpload, read } = await makeStore();
      const before = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(before);
      const request = { slug: "admitted-begin", ttlMs: 60_000 };
      const first = beginUpload({ ...request, keyHash: "same-key" });
      if (boundary === "capacity") {
        for (let index = 1; index < 32; index += 1) {
          beginUpload(request);
        }
      }
      const admitted = advanceClockAtAdmission(database, before, first.expiresAt);
      const next = beginUpload({
        ...request,
        ...(boundary === "idempotency" ? { keyHash: "same-key" } : {}),
      });
      expect(admitted).toHaveBeenCalledOnce();
      expect(next.uploadId).not.toBe(first.uploadId);
      expect(next.expiresAt).toBe(first.expiresAt + request.ttlMs);
      expect(read(next.uploadId, "created_at, expires_at")).toEqual({
        created_at: first.expiresAt,
        expires_at: next.expiresAt,
      });
      if (boundary === "idempotency") {
        expect(uploadExists(databasePath, first.uploadId)).toBe(false);
      }
    },
  );

  it.each([
    { operation: "chunk", leased: false },
    { operation: "claim", leased: false },
    { operation: "commit", leased: false },
    { operation: "commit", leased: true },
  ] as const)(
    "rejects $operation across native admission expiry with external lease=$leased",
    async ({ operation, leased }) => {
      const { databasePath, database, beginUpload, append, commit, claim, read, lease } =
        await makeStore();
      const archive = Buffer.from("a");
      const begun = beginUpload({
        slug: "admitted-expiry",
        sizeBytes: operation === "chunk" ? 2 : 1,
      });
      append(begun.uploadId, archive);
      if (operation === "claim") {
        commit(begun.uploadId);
      }
      if (leased) {
        lease(begun.uploadId, "external-install", begun.expiresAt + 60_000, begun.expiresAt - 1);
      }
      const admitted = advanceClockAtAdmission(database, begun.expiresAt - 1, begun.expiresAt);
      expect(() => {
        if (operation === "chunk") {
          return append(begun.uploadId, archive, 1);
        }
        if (operation === "claim") {
          return claim(begun.uploadId, "admission-proof");
        }
        return commit(begun.uploadId);
      }).toThrow("upload has expired");
      expect(admitted).toHaveBeenCalledOnce();
      expect(chunkCount(databasePath, begun.uploadId)).toBe(
        operation === "chunk" || leased ? 1 : 0,
      );
      expect(installLeaseCount(databasePath, begun.uploadId)).toBe(leased ? 1 : 0);
      if (operation === "commit") {
        expect(uploadExists(databasePath, begun.uploadId)).toBe(leased);
      }
      if (leased) {
        expect(read(begun.uploadId, "committed, length(archive_blob) AS bytes")).toEqual({
          committed: 0,
          bytes: 0,
        });
      }
    },
  );

  it.each([false, true])(
    "resamples sweep deletion at admission with a lease expiring during admission=%s",
    async (leased) => {
      const { databasePath, database, options, stage, lease } = await makeStore();
      const begun = stage(Buffer.from("a"));
      const before = begun.expiresAt - 1;
      const after = begun.expiresAt + 1;
      if (leased) {
        database.db
          .prepare("UPDATE skill_uploads SET expires_at = ? WHERE upload_id = ?")
          .run(before - 1, begun.uploadId);
        lease(begun.uploadId, "sweep-proof", begun.expiresAt, before);
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
    const { databasePath, beginUpload, append, commit, claim, read } = await makeStore();
    const db = requireNativeSqliteDatabase(stateDatabase(databasePath));
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
    const firstChunk = Buffer.alloc(4 * 1024 * 1024, 0x61);
    const secondChunk = Buffer.alloc(4 * 1024 * 1024, 0x62);
    const archive = Buffer.concat([firstChunk, secondChunk]);
    const request = { sizeBytes: archive.length, keyHash: "large-upload" };
    const begin = beginUpload(request);
    append(begin.uploadId, firstChunk);
    append(begin.uploadId, secondChunk, firstChunk.length);
    expect(read(begin.uploadId, "length(archive_blob) AS bytes")).toEqual({ bytes: 0 });
    expect(chunkCount(databasePath, begin.uploadId)).toBe(2);

    commit(begin.uploadId, sha256(archive));
    expect(read(begin.uploadId, "length(archive_blob) AS bytes")).toEqual({
      bytes: archive.length,
    });
    expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
    expect(beginUpload(request)).toMatchObject({
      uploadId: begin.uploadId,
      receivedBytes: archive.length,
    });
    expect(commit(begin.uploadId)).toMatchObject({
      sha256: sha256(archive),
    });
    expect(() => append(begin.uploadId, Buffer.from("a"), archive.length)).toThrow(
      "upload is already committed",
    );
    expect(archiveReads).toEqual([]);
    const claimed = claim(begin.uploadId, "metadata-proof");
    expect(claimed.archive_blob.constructor).toBe(Uint8Array);
    expect(Buffer.compare(claimed.archive_blob, archive)).toBe(0);
    expect(archiveReads).toEqual([{ bytes: archive.length, inTransaction: true }]);
    const copiedBytes = bufferFrom.mock.calls.reduce((total, [value]) => {
      const input: unknown = value;
      return total + (input instanceof Uint8Array && nativeBlobs.has(input) ? input.byteLength : 0);
    }, 0);
    expect(copiedBytes).toBe(0);
  });

  it.each(["committed", "expired committed", "expired incomplete"] as const)(
    "reconciles chunks deleted before the metadata reread: %s",
    async (outcome) => {
      const originalSqlite = await vi.importActual<typeof uploadSqlite>("./upload-store.sqlite.js");
      const { databasePath, stage, commit: commitUpload } = await makeStore();
      const archive = Buffer.from("concurrent-commit");
      const digest = sha256(archive);
      const begin = stage(archive, { sha256: digest });
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let competingWriteFinished = false;
      let rereadObserved = false;
      vi.mocked(uploadSqlite.requireUploadMetadata).mockImplementation((uploadId, options) => {
        const row = originalSqlite.requireUploadMetadata(uploadId, options);
        if (competingWriteFinished) {
          rereadObserved = true;
          if (outcome !== "committed") {
            now = begin.expiresAt;
          }
        }
        return row;
      });
      vi.mocked(uploadSqlite.readSkillUploadArchiveChunks).mockImplementationOnce(
        (uploadId, options) => {
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
          return originalSqlite.readSkillUploadArchiveChunks(uploadId, options);
        },
      );
      const commit = () => commitUpload(begin.uploadId, digest);
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
});
