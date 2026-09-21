import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { commitSkillUploadInDatabase } from "./upload-store-commit.js";
import { createSkillUploadStore } from "./upload-store.test-support.js";

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
  return { databasePath, store: createSkillUploadStore({ path: databasePath, tempRootDir: root }) };
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

describe("skill upload commit kernel", () => {
  it.each(["committed", "expired committed", "expired incomplete"] as const)(
    "reconciles chunks deleted before the metadata reread: %s",
    async (outcome) => {
      const { databasePath, store } = await makeStore();
      const archive = Buffer.from("concurrent-commit");
      const digest = sha256(archive);
      const begin = await store.begin({
        kind: "skill-archive",
        slug: "concurrent-commit-skill",
        sizeBytes: archive.length,
        sha256: digest,
      });
      await store.chunk({
        uploadId: begin.uploadId,
        offset: 0,
        dataBase64: archive.toString("base64"),
      });
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
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("expires-during-commit");
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "expires-during-commit",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
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
      const { databasePath, store } = await makeStore();
      const archive = Buffer.from("expires-during-admission");
      const begin = await store.begin({
        kind: "skill-archive",
        slug: "admission-expiry",
        sizeBytes: archive.length,
      });
      await store.chunk({
        uploadId: begin.uploadId,
        offset: 0,
        dataBase64: archive.toString("base64"),
      });
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
      let now = begin.expiresAt - 1;
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let admitted = false;
      const execute = database.db.exec.bind(database.db);
      vi.spyOn(database.db, "exec").mockImplementation((sql) => {
        const result = execute(sql);
        if (sql === "BEGIN IMMEDIATE") {
          admitted = database.db.isTransaction;
          now = begin.expiresAt;
        }
        return result;
      });
      expect(() =>
        commitSkillUploadInDatabase({ uploadId: begin.uploadId }, { database, path: databasePath }),
      ).toThrow("upload has expired");
      expect(admitted).toBe(true);
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
