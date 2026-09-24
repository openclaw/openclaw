import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { waitForFixtureFile } from "../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { sqliteWorkerPreloadEnv } from "./sqlite-worker-preload.test-support.js";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreWrite,
  type SqliteWorkerStore,
} from "./sqlite-worker-store.js";
import type { FixtureOpenInput, FixtureOperations } from "./sqlite-worker-store.test-support.js";
import {
  acquireStateDatabaseCoordinator,
  captureStateDatabaseCoordinatorRuntime,
  resolveStateDatabaseCoordinatorPath,
  StateDatabaseCoordinatorContentionError,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "./state-database-coordinator.js";

const stores = new Set<SqliteWorkerStore<FixtureOperations>>();
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all([...stores].map((store) => store.close()));
    } finally {
      stores.clear();
      cleanup();
    }
  }),
);

async function open(databasePath: string, input?: FixtureOpenInput) {
  const store = await openSqliteWorkerStore<FixtureOperations>({
    moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
    databasePath,
    input,
  });
  stores.add(store);
  return store;
}

it.each([
  { mib: 0, owner: "client" },
  { mib: 40, owner: "client" },
  { mib: 0, owner: "host" },
] as const)(
  "retains FIFO, cancellation, and $owner close while preparing a $mib MiB command",
  async ({ mib, owner }) => {
    const root = dirs.make("sqlite-worker-preparation-");
    const databasePath = path.join(root, "store.sqlite");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const store = await open(databasePath, { type: "prepare", markerPath, gatePath });
    const activeCancel = new AbortController();
    const queuedCancel = new AbortController();
    const value = mib ? "x".repeat(mib * 1024 * 1024) : "first";
    let settled = false;
    const active = store
      .execute({ type: "append", input: { value } }, { signal: activeCancel.signal })
      .then((receipt) => {
        settled = true;
        return receipt;
      });
    let canceled: Promise<unknown> | undefined;
    let following: Promise<unknown> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await Promise.race([
        waitForFixtureFile(markerPath, active),
        active.then(() => {
          throw new Error("Command executed before its code preparation");
        }),
      ]);
      expect(settled).toBe(false);
      canceled = store.execute(
        { type: "append", input: { value: "canceled" } },
        { signal: queuedCancel.signal },
      );
      const reason = new Error("Cancel the queued command");
      queuedCancel.abort(reason);
      await expect(canceled).rejects.toBe(reason);
      following = store.execute({ type: "append", input: { value: "second" } });
      activeCancel.abort(new Error("Dispatched preparation remains owned"));
      let closed = false;
      closing = (
        owner === "client" ? store.close() : drainGlobalSingletonLifecycleState("restart")
      ).then(() => {
        closed = true;
      });
      await expect(store.execute({ type: "read", input: undefined })).rejects.toMatchObject({
        code: "closed",
      });
      expect(closed).toBe(false);
      await writeFile(gatePath, "release preparation");
      const first = await active;
      expect(first).toMatchObject({
        writes: 1,
        readerOwnership: {
          preparation: [undefined, undefined],
          execution: { operation: "append", ownerKind: "worker", actorId: expect.any(Number) },
        },
      });
      expect(await following).toMatchObject({ writes: 2, readerOwnership: first.readerOwnership });
      await closing;
      expect(closed).toBe(true);
      const reopened = await open(databasePath);
      const digest = (text: string) => createHash("sha256").update(text).digest("hex");
      expect((await reopened.execute({ type: "read", input: undefined })).map(digest)).toEqual(
        [value, "second"].map(digest),
      );
    } finally {
      queuedCancel.abort();
      await writeFile(gatePath, "release for cleanup");
      await Promise.allSettled([active, canceled, following, closing]);
    }
  },
);

it.each(["revoked", "rejected"] as const)(
  "preserves uncommitted state after %s preparation and permits the next command",
  async (failure) => {
    const root = dirs.make("sqlite-worker-preparation-authority-");
    const databasePath = path.join(root, "store.sqlite");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const store = await open(databasePath, {
      type: "prepare",
      markerPath,
      gatePath,
      guarded: true,
      reject: failure === "rejected",
    });
    let current = true;
    const refused = new Error("Authority revoked during code preparation");
    const operation = runSqliteWorkerStoreWrite(
      store,
      (scope) => scope.execute({ type: "append", input: { value: "must not commit" } }),
      () => {
        if (!current) {
          throw refused;
        }
      },
      [databasePath],
    );
    const outcome = Promise.allSettled([operation]);
    try {
      await Promise.race([
        waitForFixtureFile(markerPath, operation),
        operation.then(() => {
          throw new Error("Command executed before its code preparation");
        }),
      ]);
      current = false;
      await writeFile(gatePath, "release preparation");
      const [result] = await outcome;
      expect(result).toMatchObject({
        status: "rejected",
        reason: {
          message: failure === "revoked" ? refused.message : "Fixture code preparation failed",
        },
      });
      expect(await store.execute({ type: "read", input: undefined })).toEqual([]);
      await store.close();
      const reopened = await open(databasePath);
      expect(await reopened.execute({ type: "read", input: undefined })).toEqual([]);
      expect(
        await reopened.execute({ type: "append", input: { value: "after refusal" } }),
      ).toMatchObject({ writes: 1 });
    } finally {
      await writeFile(gatePath, "release for cleanup");
      await outcome;
    }
  },
);

it.each(["abort-close", "reject", "reject-cleanup"] as const)(
  "settles %s during module preparation with worker-owned lifecycle custody",
  async (mode) => {
    const root = dirs.make("sqlite-worker-preparation-lifecycle-");
    const databasePath = path.join(root, "store.sqlite");
    const markerPath = path.join(root, "preparing");
    const gatePath = path.join(root, "release");
    const failedPath = path.join(root, "cleanup-failed");
    const context = {
      environment: { OPENCLAW_STATE_DIR: root },
      coordinatorRuntime: withStateDatabaseCoordinatorRuntimeDirectory(
        root,
        captureStateDatabaseCoordinatorRuntime,
      ),
    };
    const acquireIndependent = () =>
      withStateDatabaseCoordinatorRuntimeDirectory(context.coordinatorRuntime, () =>
        acquireStateDatabaseCoordinator({ databasePath, busyTimeoutMs: 0 }),
      );
    const broker = new SqliteWorkerBroker();
    const canceled = new AbortController();
    let active: Promise<FixtureOperations["append"]["output"]> | undefined;
    let following: Promise<string[]> | undefined;
    let closing: Promise<void> | undefined;
    try {
      if (mode === "reject-cleanup") {
        const coordinatorPath = resolveStateDatabaseCoordinatorPath({
          databasePath,
          runtimeDirectory: context.coordinatorRuntime.directory,
          uid: process.getuid?.(),
        });
        const preload = path.join(root, "cleanup-preload.cjs");
        await writeFile(
          preload,
          `const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  const fs = require("node:fs");
  const { DatabaseSync } = require("node:sqlite");
  let failedDatabase;
  let failed = false;
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.exec = function(sql) {
    if (!failed && sql === "ROLLBACK" && this.location() === ${JSON.stringify(coordinatorPath)} && fs.existsSync(${JSON.stringify(markerPath)})) {
      failed = true;
      failedDatabase = this;
      fs.writeFileSync(${JSON.stringify(failedPath)}, "one cleanup failure");
      throw new Error("Synthetic coordinator rollback failure");
    }
    return Reflect.apply(exec, this, [sql]);
  };
  const close = DatabaseSync.prototype.close;
  DatabaseSync.prototype.close = function(...args) {
    if (this === failedDatabase) {
      failedDatabase = undefined;
      throw new Error("Synthetic coordinator close failure");
    }
    return Reflect.apply(close, this, args);
  };
}
`,
        );
        for (const [key, value] of Object.entries(sqliteWorkerPreloadEnv(preload))) {
          vi.stubEnv(key, value);
        }
      }
      const posts = vi.spyOn(Worker.prototype, "postMessage");
      const store = await broker.open<FixtureOperations>(
        {
          moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
          databasePath,
          input: { type: "prepare", markerPath, gatePath, reject: mode !== "abort-close" },
        },
        context,
      );
      const worker = posts.mock.contexts[0];
      posts.mockRestore();
      if (!store || !(worker instanceof Worker)) {
        throw new Error("Expected the fixture's lifecycle worker");
      }
      let exited = false;
      worker.once("exit", () => {
        exited = true;
      });
      const warnings = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
      let settled = false;
      active = broker.runOperation(
        store,
        (scope) =>
          scope.execute(
            { type: "append", input: { value: "after preparation" } },
            { signal: canceled.signal },
          ),
        context,
        undefined,
        undefined,
        true,
      );
      const outcome = active.then(
        (value) => {
          settled = true;
          return { status: "fulfilled" as const, value, exited };
        },
        (reason: unknown) => {
          settled = true;
          return { status: "rejected" as const, reason, exited };
        },
      );
      await Promise.race([
        waitForFixtureFile(markerPath, active),
        active.then(() => {
          throw new Error("Command executed before its code preparation");
        }),
      ]);
      expect(settled).toBe(false);
      expect(() => acquireIndependent().release()).toThrow(StateDatabaseCoordinatorContentionError);
      following = store.execute({ type: "read", input: undefined });
      const followerOutcome = Promise.allSettled([following]);
      let closed = false;
      if (mode === "abort-close") {
        canceled.abort(new Error("Dispatched module preparation remains owned"));
        closing = store.close().then(() => {
          closed = true;
        });
        await expect(store.execute({ type: "read", input: undefined })).rejects.toMatchObject({
          code: "closed",
        });
        expect(settled).toBe(false);
        expect(closed).toBe(false);
      }
      await writeFile(gatePath, "release preparation");
      const result = await outcome;
      const [follower] = await followerOutcome;
      if (mode === "abort-close") {
        expect(result).toMatchObject({ status: "fulfilled", value: { writes: 1 } });
        expect(follower).toEqual({ status: "fulfilled", value: ["after preparation"] });
        await closing;
        expect(closed).toBe(true);
      } else {
        expect(result).toMatchObject({
          status: "rejected",
          reason: { message: "Fixture code preparation failed" },
          exited: mode === "reject-cleanup",
        });
        expect(result).not.toMatchObject({ reason: { code: "outcome-unknown" } });
        if (mode === "reject-cleanup") {
          expect(existsSync(failedPath)).toBe(true);
          expect(follower).toMatchObject({ status: "rejected", reason: { code: "unavailable" } });
          expect(warnings).toHaveBeenCalledWith(
            expect.objectContaining({
              message: "SQLite worker operation completed before coordinator cleanup failed",
            }),
          );
        } else {
          expect(follower).toEqual({ status: "fulfilled", value: [] });
          expect(await store.execute({ type: "read", input: undefined })).toEqual([]);
        }
        // Closing the actor first could hide a leaked coordinator lease.
        acquireIndependent().release();
        await store.close();
      }
      const reopened = await open(databasePath);
      expect(await reopened.execute({ type: "read", input: undefined })).toEqual(
        mode === "abort-close" ? ["after preparation"] : [],
      );
    } finally {
      await writeFile(gatePath, "release for cleanup");
      await Promise.allSettled([active, following, closing]);
      try {
        await broker.close();
      } finally {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
      }
    }
  },
);

type PreparedFixture = {
  read: { input: undefined; output: { preparation?: { key: string }; input: unknown } };
};

it("captures preparation once without changing backend identity for ordinary reuse", async () => {
  const root = dirs.make("openclaw-worker-opening-preparation-");
  const databasePath = path.join(root, "fixture.sqlite");
  const modulePath = path.join(root, "backend.mjs");
  await writeFile(
    modulePath,
    `import { writeFileSync } from "node:fs";
export function createSqliteWorkerBackend(input, context) {
  const preparation = context.preparation;
  writeFileSync(context.databasePath, preparation?.key ?? "ordinary");
  return { execute: () => ({ preparation, input }), close() {} };
}
`,
  );
  const broker = new SqliteWorkerBroker();
  const options = { moduleUrl: pathToFileURL(modulePath), databasePath, input: undefined };
  const preparation = { key: "captured" };
  try {
    const opening = broker.open<PreparedFixture>(options, undefined, undefined, {
      preparation,
    });
    preparation.key = "changed-after-admission";
    const first = await opening;
    assert.ok(first);
    const ordinary = await broker.open<PreparedFixture>(options);
    assert.ok(ordinary);
    const anotherPreparation = await broker.open<PreparedFixture>(options, undefined, undefined, {
      preparation: { key: "must-not-reinitialize" },
    });
    assert.ok(anotherPreparation);

    expect(await readFile(databasePath, "utf8")).toBe("captured");
    for (const store of [first, ordinary, anotherPreparation]) {
      expect(await store.execute({ type: "read", input: undefined })).toEqual({
        preparation: { key: "captured" },
        input: undefined,
      });
    }
    await Promise.all([first.close(), ordinary.close(), anotherPreparation.close()]);
  } finally {
    await broker.close();
  }
});
