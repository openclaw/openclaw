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
  return {
    databasePath,
    store: createSkillUploadStore({ path: databasePath, tempRootDir: root, ...options }),
  };
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
    const { databasePath, store } = await makeStore({ installLeaseHeartbeatMs: 47_123 });
    const archive = Buffer.from("close-during-install");
    const begin = await store.begin({
      kind: "skill-archive",
      slug: "closing-install",
      sizeBytes: archive.length,
    });
    await store.chunk({
      uploadId: begin.uploadId,
      offset: 0,
      dataBase64: archive.toString("base64"),
    });
    await store.commit({ uploadId: begin.uploadId });
    await closeOpenClawStateDatabaseAsync();
    const intervals = vi.spyOn(globalThis, "setInterval");
    const renewalSettled = observeSkillUploadRenewal();
    const sql = observeMainThreadSql();
    const entered = deferred();
    const release = deferred();
    const pinned = store.withCommittedUpload(begin.uploadId, async () => {
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
    expect(installLeaseCount(databasePath, begin.uploadId)).toBe(0);
    expect(uploadExists(databasePath, begin.uploadId)).toBe(true);
  });

  it("closes a failed release transport and retries retained exact-owner cleanup", async () => {
    const { databasePath, store } = await makeStore();
    const begun = await store.begin({ kind: "skill-archive", slug: "cleanup-retry", sizeBytes: 1 });
    await store.chunk({ uploadId: begun.uploadId, offset: 0, dataBase64: "YQ==" });
    await store.commit({ uploadId: begun.uploadId });
    let opened = 0;
    const closed = vi.fn();
    const openCleanup = stateWorker.openOpenClawStateWorkerCleanupStore;
    vi.spyOn(stateWorker, "openOpenClawStateWorkerCleanupStore").mockImplementation(
      async (...args) => {
        const cleanup = await openCleanup(...args);
        if (cleanup) {
          opened += 1;
          const close = cleanup.close.bind(cleanup);
          vi.spyOn(cleanup, "close").mockImplementation(async () => {
            await close();
            closed();
          });
        }
        return cleanup;
      },
    );
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
                      throw new Error("injected cleanup release refusal");
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
    await expect(store.withCommittedUpload(begun.uploadId, async () => undefined)).rejects.toThrow(
      "injected cleanup release refusal",
    );
    expect(opened).toBe(1);
    expect(closed).toHaveBeenCalledOnce();
    expect(installLeaseCount(databasePath, begun.uploadId)).toBe(1);
    await closeOpenClawStateDatabaseAsync();
    expect(installLeaseCount(databasePath, begun.uploadId)).toBe(0);
    expect(uploadExists(databasePath, begun.uploadId)).toBe(true);
  });
  it("settles an acknowledged release without reopening cleanup after close acknowledgement fails", async () => {
    const { databasePath, store } = await makeStore();
    const begun = await store.begin({
      kind: "skill-archive",
      slug: "closed-release",
      sizeBytes: 1,
    });
    await store.chunk({ uploadId: begun.uploadId, offset: 0, dataBase64: "YQ==" });
    await store.commit({ uploadId: begun.uploadId });
    const openCleanup = stateWorker.openOpenClawStateWorkerCleanupStore;
    let opens = 0;
    let closes = 0;
    vi.spyOn(stateWorker, "openOpenClawStateWorkerCleanupStore").mockImplementation(
      async (...args) => {
        if (++opens > 1) {
          throw new Error("New cleanup admission is unavailable");
        }
        const cleanup = await openCleanup(...args);
        if (!cleanup) {
          throw new Error("Expected the existing fixture database");
        }
        const close = cleanup.close.bind(cleanup);
        vi.spyOn(cleanup, "close").mockImplementation(async () => {
          await close();
          if (++closes === 1) {
            throw new Error("Injected close acknowledgement failure");
          }
        });
        return cleanup;
      },
    );
    await expect(store.withCommittedUpload(begun.uploadId, async () => undefined)).rejects.toThrow(
      "Injected close acknowledgement failure",
    );
    expect(installLeaseCount(databasePath, begun.uploadId)).toBe(0);
    await closeOpenClawStateDatabaseAsync();
    expect(opens).toBe(1);
    expect(closes).toBe(2);
    expect(uploadExists(databasePath, begun.uploadId)).toBe(true);
  });
  it("releases the same physical upload store through another locator", async () => {
    const { databasePath, store } = await makeStore();
    const begun = await store.begin({ kind: "skill-archive", slug: "alias-upload", sizeBytes: 1 });
    await store.chunk({ uploadId: begun.uploadId, offset: 0, dataBase64: "YQ==" });
    await store.commit({ uploadId: begun.uploadId });
    const alias = path.join(path.dirname(databasePath), "alias.sqlite");
    await fs.link(databasePath, alias);
    const aliased = createSkillUploadStore({
      path: alias,
      tempRootDir: path.dirname(databasePath),
    });
    await aliased.withCommittedUpload(begun.uploadId, async (record) => {
      expect(await fs.readFile(record.archivePath, "utf8")).toBe("a");
    });
    expect(installLeaseCount(databasePath, begun.uploadId)).toBe(0);
    expect(uploadExists(databasePath, begun.uploadId)).toBe(true);
  });
});
