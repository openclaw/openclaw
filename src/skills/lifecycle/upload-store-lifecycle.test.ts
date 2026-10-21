import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqliteWorker from "../../infra/sqlite-worker-store.js";
import { createDeferredCore as deferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { defaultSkillUploadStore as store } from "./upload-store.js";
import {
  observeSkillUploadRenewal,
  useSkillUploadStoreLocation,
} from "./upload-store.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
async function makeStore() {
  const root = dirs.make("openclaw-upload-lifetime-");
  const databasePath = path.join(root, "openclaw.sqlite");
  useSkillUploadStoreLocation(databasePath, root);
  const { uploadId } = await store.begin({ kind: "skill-archive", slug: "fixture", sizeBytes: 1 });
  await store.chunk({ uploadId, offset: 0, dataBase64: "YQ==" });
  await store.commit({ uploadId });
  return { databasePath, uploadId };
}
function uploadState(databasePath: string, uploadId: string) {
  return openOpenClawStateDatabase({ path: databasePath })
    .db.prepare(`
    SELECT (SELECT count(*) FROM state_leases
      WHERE scope = 'skill-upload-install' AND lease_key = ?) AS leases,
      EXISTS(SELECT 1 FROM skill_uploads WHERE upload_id = ?) AS present
  `)
    .get(uploadId, uploadId);
}

it("joins an accepted renewal and the install callback before closing and releasing its lease", async () => {
  const { databasePath, uploadId } = await makeStore();
  await closeOpenClawStateDatabaseAsync();
  const intervals = vi.spyOn(globalThis, "setInterval");
  const renewalSettled = observeSkillUploadRenewal();
  const sql = observeMainThreadSql();
  const [entered, release] = [deferred(), deferred()];
  const pinned = store.withCommittedUpload(uploadId, async () => {
    entered.resolve();
    await release.promise;
  });
  let closing: Promise<unknown> | undefined;
  try {
    await entered.promise;
    const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 30_000)?.[0];
    if (!heartbeat) {
      throw new Error("Install heartbeat was not scheduled");
    }
    heartbeat();
    const closed = vi.fn();
    closing = closeOpenClawStateDatabaseAsync().then(closed);
    await renewalSettled;
    expect(closed).not.toHaveBeenCalled();
    release.resolve();
    await Promise.all([pinned, closing]);
    sql.expectIdle();
  } finally {
    release.resolve();
    await Promise.allSettled([pinned, closing]);
    sql.restore();
  }
  expect(uploadState(databasePath, uploadId)).toEqual({ leases: 0, present: 1 });
});

it.each(["release", "close"] as const)("retries owner cleanup on %s failure", async (failure) => {
  const { databasePath, uploadId } = await makeStore();
  const error = new Error(`injected ${failure} failure`);
  let opened = 0;
  let closed = 0;
  const openCleanup = stateWorker.openOpenClawStateWorkerCleanupStore;
  vi.spyOn(stateWorker, "openOpenClawStateWorkerCleanupStore").mockImplementation(
    async (...args) => {
      if (++opened > 1 && failure === "close") {
        throw new Error("New cleanup admission is unavailable");
      }
      const cleanup = await openCleanup(...args);
      if (!cleanup) {
        throw new Error("Expected the existing fixture database");
      }
      const close = cleanup.close.bind(cleanup);
      vi.spyOn(cleanup, "close").mockImplementation(async () => {
        await close();
        if (++closed === 1 && failure === "close") {
          throw error;
        }
      });
      if (failure === "release" && opened === 1) {
        // Cleanup opens after the install operation settles; its next operation releases the lease.
        vi.spyOn(sqliteWorker, "runSqliteWorkerStoreOperation").mockRejectedValueOnce(error);
      }
      return cleanup;
    },
  );
  const install = store.withCommittedUpload(uploadId, async () => undefined);
  await expect(install).rejects.toThrow(error);
  expect({ opened, closed }).toEqual({ opened: 1, closed: 1 });
  expect(uploadState(databasePath, uploadId)).toMatchObject({
    leases: failure === "release" ? 1 : 0,
  });
  await closeOpenClawStateDatabaseAsync();
  expect({ opened, closed }).toEqual({ opened: failure === "release" ? 2 : 1, closed: 2 });
  expect(uploadState(databasePath, uploadId)).toEqual({ leases: 0, present: 1 });
});
it("releases the same physical upload store through another locator", async () => {
  const { databasePath, uploadId } = await makeStore();
  const alias = path.join(path.dirname(databasePath), "alias.sqlite");
  await fs.link(databasePath, alias);
  useSkillUploadStoreLocation(alias, path.dirname(databasePath));
  await store.withCommittedUpload(uploadId, async (record) => {
    expect(await fs.readFile(record.archivePath, "utf8")).toBe("a");
  });
  expect(uploadState(databasePath, uploadId)).toEqual({ leases: 0, present: 1 });
});
