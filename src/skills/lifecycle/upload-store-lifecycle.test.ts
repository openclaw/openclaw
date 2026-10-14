import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sqliteWorker from "../../infra/sqlite-worker-store.js";
import { createDeferredCore as deferred } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import * as stateWorker from "../../state/openclaw-state-worker-store.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { createSkillUploadStore, observeSkillUploadRenewal } from "./upload-store.test-support.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
async function makeStore(options?: { installLeaseHeartbeatMs?: number }) {
  const root = dirs.make("openclaw-upload-lifetime-");
  const databasePath = path.join(root, "openclaw.sqlite");
  const store = createSkillUploadStore({ path: databasePath, tempRootDir: root, ...options });
  const { uploadId } = await store.begin({ kind: "skill-archive", slug: "fixture", sizeBytes: 1 });
  await store.chunk({ uploadId, offset: 0, dataBase64: "YQ==" });
  await store.commit({ uploadId });
  return { databasePath, store, uploadId };
}
function installLeaseCount(databasePath: string, uploadId: string) {
  return (
    openOpenClawStateDatabase({ path: databasePath })
      .db.prepare(
        "SELECT count(*) AS count FROM state_leases WHERE scope = 'skill-upload-install' AND lease_key = ?",
      )
      .get(uploadId) as { count: number }
  ).count;
}
function uploadExists(databasePath: string, uploadId: string) {
  return Boolean(
    openOpenClawStateDatabase({ path: databasePath })
      .db.prepare("SELECT 1 FROM skill_uploads WHERE upload_id = ?")
      .get(uploadId),
  );
}

describe("skill upload installation lifetime", () => {
  it("joins an accepted renewal and the install callback before closing and releasing its lease", async () => {
    const { databasePath, store, uploadId } = await makeStore({ installLeaseHeartbeatMs: 47_123 });
    await closeOpenClawStateDatabaseAsync();
    const intervals = vi.spyOn(globalThis, "setInterval");
    const renewalSettled = observeSkillUploadRenewal();
    const sql = observeMainThreadSql();
    const entered = deferred();
    const release = deferred();
    const pinned = store.withCommittedUpload(uploadId, async () => {
      entered.resolve();
      await release.promise;
    });
    let closing: Promise<unknown> | undefined;
    try {
      await entered.promise;
      const heartbeat = intervals.mock.calls.find(([, delay]) => delay === 47_123)?.[0];
      if (!heartbeat) {
        throw new Error("Install heartbeat was not scheduled");
      }
      heartbeat();
      let closed = false;
      closing = closeOpenClawStateDatabaseAsync().then(() => {
        closed = true;
      });
      await renewalSettled;
      expect(closed).toBe(false);
      release.resolve();
      await pinned;
      await closing;
      sql.expectIdle();
    } finally {
      release.resolve();
      await Promise.allSettled([pinned, closing]);
      sql.restore();
    }
    expect(installLeaseCount(databasePath, uploadId)).toBe(0);
    expect(uploadExists(databasePath, uploadId)).toBe(true);
  });

  it.each(["release", "close"] as const)(
    "retries exact-owner cleanup after %s fails",
    async (failure) => {
      const { databasePath, store, uploadId } = await makeStore();
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
          return cleanup;
        },
      );
      if (failure === "release") {
        let refused = false;
        const runOperation = sqliteWorker.runSqliteWorkerStoreOperation;
        vi.spyOn(sqliteWorker, "runSqliteWorkerStoreOperation").mockImplementation(
          new Proxy(runOperation, {
            apply(target, receiver, [worker, operation, ...rest]: Parameters<typeof runOperation>) {
              return Reflect.apply(target, receiver, [
                worker,
                (scope: Parameters<typeof operation>[0]) =>
                  operation({
                    execute: new Proxy(scope.execute, {
                      apply(execute, executeReceiver, args: Parameters<typeof scope.execute>) {
                        if (args[0].type === "skillUploads.release" && !refused) {
                          refused = true;
                          throw error;
                        }
                        return Reflect.apply(execute, executeReceiver, args);
                      },
                    }),
                  }),
                ...rest,
              ]);
            },
          }),
        );
      }
      await expect(store.withCommittedUpload(uploadId, async () => undefined)).rejects.toThrow(
        error,
      );
      expect(opened).toBe(1);
      expect(closed).toBe(1);
      expect(installLeaseCount(databasePath, uploadId)).toBe(failure === "release" ? 1 : 0);
      await closeOpenClawStateDatabaseAsync();
      expect(opened).toBe(failure === "release" ? 2 : 1);
      expect(closed).toBe(2);
      expect(installLeaseCount(databasePath, uploadId)).toBe(0);
      expect(uploadExists(databasePath, uploadId)).toBe(true);
    },
  );
  it("releases the same physical upload store through another locator", async () => {
    const { databasePath, uploadId } = await makeStore();
    const alias = path.join(path.dirname(databasePath), "alias.sqlite");
    await fs.link(databasePath, alias);
    const aliased = createSkillUploadStore({
      path: alias,
      tempRootDir: path.dirname(databasePath),
    });
    await aliased.withCommittedUpload(uploadId, async (record) => {
      expect(await fs.readFile(record.archivePath, "utf8")).toBe("a");
    });
    expect(installLeaseCount(databasePath, uploadId)).toBe(0);
    expect(uploadExists(databasePath, uploadId)).toBe(true);
  });
});
