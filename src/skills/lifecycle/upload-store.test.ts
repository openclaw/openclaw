import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createDeferredCore as deferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { commitSkillUploadInDatabase } from "./upload-store-commit.js";
import { SkillUploadRequestError } from "./upload-store-error.js";
import { defaultSkillUploadStore } from "./upload-store.js";
import { beginSkillUploadInDatabase } from "./upload-store.kernel.js";
import {
  deleteExpiredSkillUploadUnlessLeasedInDatabase,
  renewSkillUploadInstallLease,
} from "./upload-store.sqlite.js";
import {
  observeExpiredUploadInventory,
  observeSkillUploadRenewal,
  useSkillUploadStoreLocation,
} from "./upload-store.test-support.js";

const ACTIVE_UPLOAD_LIMIT = 32;

const tempDirs = createTempDirTracker();

async function makeStore() {
  const root = tempDirs.make("openclaw-skill-upload-store-");
  const databasePath = path.join(root, "openclaw.sqlite");
  useSkillUploadStoreLocation(databasePath, root);
  return { root, databasePath, store: defaultSkillUploadStore };
}

function beginUpload(store: typeof defaultSkillUploadStore, slug: string, sizeBytes = 3) {
  return store.begin({ kind: "skill-archive", slug, sizeBytes });
}
function sendChunk(
  store: typeof defaultSkillUploadStore,
  uploadId: string,
  bytes: Buffer,
  offset = 0,
) {
  return store.chunk({ uploadId, offset, dataBase64: bytes.toString("base64") });
}

async function committedUpload(
  store: typeof defaultSkillUploadStore,
  slug: string,
  databasePath?: string,
) {
  const upload = await store.begin({ kind: "skill-archive", slug, sizeBytes: 3 });
  await store.chunk({ uploadId: upload.uploadId, offset: 0, dataBase64: "YWJj" });
  if (databasePath) {
    commitStagedFixture(databasePath, upload.uploadId);
  } else {
    await store.commit({ uploadId: upload.uploadId });
  }
  return upload;
}

function stateDatabase(databasePath: string) {
  return openOpenClawStateDatabase({ path: databasePath }).db;
}

function uploadCount(databasePath: string): number {
  return (
    stateDatabase(databasePath).prepare("SELECT count(*) AS count FROM skill_uploads").get() as {
      count: number;
    }
  ).count;
}

function uploadExists(databasePath: string, uploadId: string): boolean {
  return Boolean(
    stateDatabase(databasePath)
      .prepare("SELECT 1 AS found FROM skill_uploads WHERE upload_id = ?")
      .get(uploadId),
  );
}

function expireUpload(databasePath: string, uploadId: string) {
  stateDatabase(databasePath)
    .prepare("UPDATE skill_uploads SET expires_at = 1 WHERE upload_id = ?")
    .run(uploadId);
}

function chunkCount(databasePath: string, uploadId: string): number {
  const row = stateDatabase(databasePath)
    .prepare("SELECT count(*) AS count FROM skill_upload_chunks WHERE upload_id = ?")
    .get(uploadId);
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

function commitStagedFixture(databasePath: string, uploadId: string) {
  const database = openOpenClawStateDatabase({ path: databasePath });
  return commitSkillUploadInDatabase({ uploadId }, { database, path: databasePath });
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function holdUpload(store: typeof defaultSkillUploadStore, uploadId: string) {
  const entered = deferred();
  const release = deferred();
  const pinned = store.withCommittedUpload(uploadId, async () => {
    entered.resolve();
    await release.promise;
    return true;
  });
  return { entered, release, pinned };
}

async function expectUploadError(
  promise: Promise<unknown>,
  message: string | RegExp,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(SkillUploadRequestError);
  await expect(promise).rejects.toMatchObject({
    message: typeof message === "string" ? message : expect.stringMatching(message),
  });
}

async function expectMissingPath(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("skill upload store", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    tempDirs.cleanup();
  });

  it("stores chunks, commits one archive blob, and materializes only for the action", async () => {
    const { root, databasePath, store } = await makeStore();
    const archive = Buffer.from("zip-bytes");
    const digest = sha256(archive);
    const request = {
      kind: "skill-archive" as const,
      slug: "demo-skill",
      sizeBytes: archive.length,
      sha256: digest,
      idempotencyKey: "same-upload",
    };
    const begin = await store.begin(request);
    const repeated = await store.begin(request);
    expect(repeated.uploadId).toBe(begin.uploadId);

    await sendChunk(store, begin.uploadId, archive.subarray(0, 3));
    expect(chunkCount(databasePath, begin.uploadId)).toBe(1);
    const chunk = await sendChunk(store, begin.uploadId, archive.subarray(3), 3);
    expect(chunk.receivedBytes).toBe(archive.length);

    const commit = await store.commit({ uploadId: begin.uploadId, sha256: digest });
    expect(commit).toMatchObject({
      uploadId: begin.uploadId,
      receivedBytes: archive.length,
      sha256: digest,
    });
    expect(chunkCount(databasePath, begin.uploadId)).toBe(0);
    const persisted = stateDatabase(databasePath)
      .prepare(
        "SELECT archive_blob, committed, actual_sha256 FROM skill_uploads WHERE upload_id = ?",
      )
      .get(begin.uploadId) as {
      archive_blob: Uint8Array;
      committed: number;
      actual_sha256: string;
    };
    expect(Buffer.from(persisted.archive_blob)).toEqual(archive);
    expect(persisted).toMatchObject({ committed: 1, actual_sha256: digest });

    let materializedPath = "";
    const record = await store.withCommittedUpload(begin.uploadId, async (committedRecord) => {
      materializedPath = committedRecord.archivePath;
      expect(await fs.readFile(materializedPath)).toEqual(archive);
      if (process.platform !== "win32") {
        expect((await fs.stat(materializedPath)).mode & 0o777).toBe(0o600);
      }
      return committedRecord;
    });
    expect(record).toMatchObject({ slug: "demo-skill", force: false, actualSha256: digest });
    await expectMissingPath(materializedPath);
    await expectMissingPath(path.join(root, "tmp", "skill-uploads"));
  });

  it("rejects traversal slugs and missing uploads", async () => {
    const { store } = await makeStore();
    await expectUploadError(
      store.begin({ kind: "skill-archive", slug: "../escape", sizeBytes: 1 }),
      "Invalid skill slug: ../escape",
    );
    await expectUploadError(
      store.withCommittedUpload(randomUUID(), async (record) => record),
      /^upload not found: /,
    );
  });

  it("preserves the upload base64 dialect and rejects offset, size, and sha mismatches", async () => {
    const { store } = await makeStore();
    const archive = Buffer.from("abc");
    const begin = await beginUpload(store, "demo-skill", archive.length);
    for (const dataBase64 of ["", "YQ", "Y Q=", "YQ==YQ==", "YQ==?", "YQ==="]) {
      await expectUploadError(
        store.chunk({ uploadId: begin.uploadId, offset: 0, dataBase64 }),
        "invalid dataBase64",
      );
    }
    await expectUploadError(
      sendChunk(store, begin.uploadId, archive.subarray(0, 1), 1),
      "upload offset mismatch: expected 0, got 1",
    );
    await expectUploadError(
      sendChunk(store, begin.uploadId, Buffer.from("abcd")),
      "upload chunk exceeds declared size",
    );
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      // Uploads trim outer whitespace and accept nonzero pad bits in padded base64.
      dataBase64: " \tYWJ=\n",
    });
    await expectUploadError(
      store.commit({ uploadId: begin.uploadId }),
      "upload size mismatch: expected 3, got 2",
    );

    const second = await beginUpload(store, "second-skill", archive.length);
    await sendChunk(store, second.uploadId, archive);
    await expectUploadError(
      store.commit({ uploadId: second.uploadId, sha256: "0".repeat(64) }),
      "upload sha256 mismatch",
    );
  });

  it("accepts exactly one concurrent chunk at the same offset", async () => {
    const { databasePath, store } = await makeStore();
    const begin = await beginUpload(store, "concurrent-skill", 2);
    const results = await Promise.allSettled([
      sendChunk(store, begin.uploadId, Buffer.from("a")),
      sendChunk(store, begin.uploadId, Buffer.from("b")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: "upload offset mismatch: expected 1, got 0" }),
    });
    expect(chunkCount(databasePath, begin.uploadId)).toBe(1);
  });

  it("creates one row for concurrent idempotent begins and rejects conflicts", async () => {
    const { databasePath, store } = await makeStore();
    const params = {
      kind: "skill-archive" as const,
      slug: "idem-skill",
      sizeBytes: 3,
      idempotencyKey: "same-key",
    };
    const [first, second] = await Promise.all([store.begin(params), store.begin(params)]);
    expect(second.uploadId).toBe(first.uploadId);
    expect(uploadCount(databasePath)).toBe(1);
    await expectUploadError(
      store.begin({ ...params, slug: "different-skill" }),
      "idempotencyKey conflicts with a different upload",
    );
  });

  it("rejects idempotent commit when committed metadata is missing the actual sha", async () => {
    const { databasePath, store } = await makeStore();
    const begin = await committedUpload(store, "corrupt-skill");
    stateDatabase(databasePath)
      .prepare("UPDATE skill_uploads SET actual_sha256 = NULL WHERE upload_id = ?")
      .run(begin.uploadId);
    await expectUploadError(
      store.commit({ uploadId: begin.uploadId }),
      "committed upload is missing sha256",
    );
  });

  it("limits active uploads", async () => {
    const { databasePath, store } = await makeStore();
    const database = openOpenClawStateDatabase({ path: databasePath });
    const capacityReads = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["capacity"],
      (sql) => (/from "skill_uploads" where "expires_at" >/u.test(sql) ? "capacity" : null),
    );
    try {
      for (let i = 0; i < ACTIVE_UPLOAD_LIMIT; i += 1) {
        await store.begin({ kind: "skill-archive", slug: `active-${i}`, sizeBytes: 1 });
      }
      const rejectAtCapacity = () =>
        beginSkillUploadInDatabase(
          { kind: "skill-archive", slug: "too-many", sizeBytes: 1, force: false, ttlMs: 60_000 },
          { database },
        );
      let capacityError: unknown;
      try {
        rejectAtCapacity();
      } catch (error) {
        capacityError = error;
      }
      expect(capacityError).toBeInstanceOf(SkillUploadRequestError);
      expect(capacityError).toHaveProperty("message", "too many active skill uploads");
      expect(capacityReads.counts.capacity).toBeGreaterThan(0);
      expect(capacityReads.rowCounts.capacity).toBeLessThanOrEqual(1);
    } finally {
      capacityReads.restore();
    }
  });

  it("expires unfinished and committed uploads", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");
    const begin = await beginUpload(store, "demo-skill", archive.length);
    expireUpload(databasePath, begin.uploadId);
    await expectUploadError(sendChunk(store, begin.uploadId, archive), "upload has expired");
    expect(uploadCount(databasePath)).toBe(0);

    const committed = await committedUpload(store, "committed-skill", databasePath);
    expireUpload(databasePath, committed.uploadId);
    await expectUploadError(
      store.withCommittedUpload(committed.uploadId, async (record) => record),
      "upload has expired",
    );
    expect(uploadCount(databasePath)).toBe(0);
  });

  it("does not sweep an upload while an install holds its lease", async () => {
    const { databasePath, store } = await makeStore();
    const committed = await committedUpload(store, "pinned-skill", databasePath);

    const { entered, release, pinned } = holdUpload(store, committed.uploadId);
    await entered.promise;
    expireUpload(databasePath, committed.uploadId);
    const inventoryRead = observeExpiredUploadInventory();
    const sweep = store.begin({ kind: "skill-archive", slug: "sweep-trigger", sizeBytes: 1 });
    try {
      await inventoryRead;
      expect(uploadCount(databasePath)).toBe(1);
      expect(installLeaseCount(databasePath, committed.uploadId)).toBe(1);
    } finally {
      release.resolve();
    }
    await expect(pinned).resolves.toBe(true);
    const swept = await sweep;
    expect(uploadExists(databasePath, committed.uploadId)).toBe(false);
    expect(uploadExists(databasePath, swept.uploadId)).toBe(true);
    expect(uploadCount(databasePath)).toBe(1);
  });

  it("rechecks chunk expiry after cleanup waits on another install", async () => {
    const { databasePath, store } = await makeStore();
    const archive = Buffer.from("abc");
    const pinnedUpload = await committedUpload(store, "blocking-skill", databasePath);
    const pending = await beginUpload(store, "waiting-skill", archive.length);

    const { entered, release, pinned } = holdUpload(store, pinnedUpload.uploadId);
    await entered.promise;
    expireUpload(databasePath, pinnedUpload.uploadId);
    const inventoryRead = observeExpiredUploadInventory();
    const chunk = sendChunk(store, pending.uploadId, archive);
    try {
      await inventoryRead;
      expect(uploadExists(databasePath, pending.uploadId)).toBe(true);
      expect(chunkCount(databasePath, pending.uploadId)).toBe(0);
      expireUpload(databasePath, pending.uploadId);
    } finally {
      release.resolve();
    }
    await pinned;
    await expectUploadError(chunk, "upload has expired");
    expect(uploadExists(databasePath, pending.uploadId)).toBe(false);
  });

  it("renews the install lease and preserves an expired leased upload", async () => {
    const { databasePath, store } = await makeStore();
    const committed = await committedUpload(store, "heartbeat-skill", databasePath);

    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const intervals = vi.spyOn(globalThis, "setInterval");
    const renewalSettled = observeSkillUploadRenewal();
    const { entered, release, pinned } = holdUpload(store, committed.uploadId);
    try {
      await entered.promise;
      const db = stateDatabase(databasePath);
      db.prepare(
        "UPDATE state_leases SET heartbeat_at = 1 WHERE scope = 'skill-upload-install' AND lease_key = ?",
      ).run(committed.uploadId);
      const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
      if (!heartbeat) {
        throw new Error("Install heartbeat was not scheduled");
      }
      heartbeat();
      await renewalSettled;
      const renewed = db
        .prepare(
          "SELECT heartbeat_at, expires_at FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .get(committed.uploadId) as { heartbeat_at: number; expires_at: number };
      expect(renewed.heartbeat_at).toBeGreaterThan(1);
      expect(renewed.expires_at - renewed.heartbeat_at).toBe(900_000);

      expireUpload(databasePath, committed.uploadId);
      expect(
        runOpenClawStateWriteTransaction(
          ({ db: transactionDb }) =>
            deleteExpiredSkillUploadUnlessLeasedInDatabase(transactionDb, {
              uploadId: committed.uploadId,
              nowMs: renewed.heartbeat_at,
            }),
          { path: databasePath },
        ),
      ).toBe("leased");
      expect(uploadCount(databasePath)).toBe(1);
      expect(installLeaseCount(databasePath, committed.uploadId)).toBe(1);
    } finally {
      release.resolve();
      try {
        await pinned;
      } finally {
        vi.useRealTimers();
      }
    }
    expect(installLeaseCount(databasePath, committed.uploadId)).toBe(0);
  });

  it("does not renew an expired install lease", async () => {
    const { databasePath, store } = await makeStore();
    const committed = await committedUpload(store, "expired-heartbeat-skill");

    await store.withCommittedUpload(committed.uploadId, async () => {
      const db = stateDatabase(databasePath);
      const lease = db
        .prepare(
          "SELECT owner FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
        )
        .get(committed.uploadId) as { owner: string };
      const heartbeatAt = Date.now();
      db.prepare(
        "UPDATE state_leases SET expires_at = ? WHERE scope = 'skill-upload-install' AND lease_key = ?",
      ).run(heartbeatAt - 1, committed.uploadId);
      expect(
        renewSkillUploadInstallLease({
          uploadId: committed.uploadId,
          owner: lease.owner,
          installLeaseMs: 60_000,
          options: { path: databasePath },
        }),
      ).toBe(false);
    });
  });

  it("lets the install lease owner remove the upload", async () => {
    const { databasePath, store } = await makeStore();
    const committed = await committedUpload(store, "consumed-skill");
    let archivePath = "";
    await store.withCommittedUpload(committed.uploadId, async (record, controls) => {
      archivePath = record.archivePath;
      await controls.remove();
    });
    await expectMissingPath(archivePath);
    expect(uploadCount(databasePath)).toBe(0);
    expect(installLeaseCount(databasePath, committed.uploadId)).toBe(0);
  });

  it.each(["replaced", "expired"])("does not remove an upload with a %s lease", async (kind) => {
    const { databasePath, store } = await makeStore();
    const committed = await committedUpload(store, "lost-lease-skill");

    await store.withCommittedUpload(committed.uploadId, async (_record, controls) => {
      const db = stateDatabase(databasePath);
      const now = Date.now();
      if (kind === "replaced") {
        db.prepare(
          "UPDATE state_leases SET owner = ?, expires_at = ?, updated_at = ? WHERE scope = 'skill-upload-install' AND lease_key = ?",
        ).run("replacement-owner", now + 60_000, now, committed.uploadId);
      } else {
        db.prepare(
          "UPDATE state_leases SET expires_at = ? WHERE scope = 'skill-upload-install' AND lease_key = ?",
        ).run(now - 1, committed.uploadId);
      }
      await expectUploadError(controls.remove(), "upload install lease is no longer active");
    });

    expect(uploadCount(databasePath)).toBe(1);
    if (kind === "replaced") {
      expect(
        stateDatabase(databasePath)
          .prepare(
            "SELECT owner FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
          )
          .get(committed.uploadId),
      ).toMatchObject({ owner: "replacement-owner" });
    }
  });
});
