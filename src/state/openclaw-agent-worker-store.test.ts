import fs from "node:fs";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db-lifecycle.js";
import { revokeAgentDatabaseResources } from "./openclaw-agent-db-resources.js";
import { withOpenClawAgentDatabaseWrite } from "./openclaw-agent-db-write.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesForTest,
} from "./openclaw-agent-db.js";
import {
  captureOpenClawAgentDatabaseExecution,
  type OpenClawAgentDatabaseExecution,
} from "./openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "./openclaw-agent-worker-store.js";
import { agentWorkerStoreFixtureEntrypoint } from "./openclaw-agent-worker-store.runtime.test-support.js";
import type {
  AgentWorkerFixtureOperations,
  bindSqliteWorkerBackend,
} from "./openclaw-agent-worker-store.test-support.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workers = new Set<OpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations>>();
const executions = new Set<OpenClawAgentDatabaseExecution>();
let sourceMode: "borrowed" | "captured" = "borrowed";
let root: string;
let options: { agentId: string; path: string };
beforeEach(() => {
  root = fs.realpathSync(tempDirs.make("agent-worker-publication-"));
  options = { agentId: "main", path: path.join(root, "agent.sqlite") };
});
afterEach(async () => {
  await Promise.all([...workers].map((worker) => worker.close()));
  workers.clear();
  await Promise.all([...executions].map((execution) => execution.release()));
  executions.clear();
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync(root);
  closeOpenClawAgentDatabasesForTest();
});
async function setup(input?: Parameters<typeof bindSqliteWorkerBackend>[0]) {
  const { db } = openOpenClawAgentDatabase(options);
  db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
  const execution =
    sourceMode === "captured" ? captureOpenClawAgentDatabaseExecution(options) : undefined;
  if (execution) {
    executions.add(execution);
  }
  const worker = await openOpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations>(
    options,
    execution ? { execution } : db,
    {
      moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint),
      input,
    },
  );
  workers.add(worker);
  return { db, worker };
}
async function waitForMarker(marker: string, work: Promise<unknown>) {
  const deadline = performance.now() + 5000;
  let settled = false;
  void work
    .finally(() => {
      settled = true;
    })
    .catch(() => undefined);
  while (!fs.existsSync(marker)) {
    if (settled) {
      await work;
      throw new Error("Worker settled before entering the fixture barrier");
    }
    if (performance.now() > deadline) {
      throw new Error("Worker did not enter the fixture barrier");
    }
    await nextTurn();
  }
}

describe.each(["borrowed", "captured"] as const)(
  "pooled agent publication owner (%s source)",
  (mode) => {
    beforeEach(() => {
      sourceMode = mode;
    });
    it.each(["success", "revoked"] as const)(
      "awaits both nested preparation hooks before %s publication admission",
      async (outcome) => {
        const preparation = {
          codeMarker: path.join(root, "code-loading"),
          codeGate: path.join(root, "code-release"),
          commandMarker: path.join(root, "command-preparing"),
          commandGate: path.join(root, "command-release"),
        };
        const { db, worker } = await setup({ preparation });
        let current = true;
        const admitted = createDeferredCore();
        const work = worker.run(
          (scope) => {
            admitted.resolve();
            return scope.execute({ type: "append", input: { value: "prepared" } });
          },
          () => {
            if (!current) {
              throw new Error("fixture authority revoked during preparation");
            }
          },
        );
        void work.catch(() => undefined);
        try {
          await Promise.race([admitted.promise, work]);
          await waitForMarker(preparation.codeMarker, work);
          expect(fs.existsSync(preparation.commandMarker)).toBe(false);
          expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
          fs.writeFileSync(preparation.codeGate, "release code loading");
          await waitForMarker(preparation.commandMarker, work);
          expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
          current = outcome === "success";
          fs.writeFileSync(preparation.commandGate, "release command preparation");
          if (outcome === "revoked") {
            await expect(work).rejects.toThrow("fixture authority revoked during preparation");
            expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
            await worker.run(
              (scope) => scope.execute({ type: "append", input: { value: "retry" } }),
              () => undefined,
            );
            expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([
              { value: "retry" },
            ]);
          } else {
            expect(await work).toBeGreaterThan(0);
            expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([
              { value: "prepared" },
            ]);
          }
        } finally {
          fs.writeFileSync(preparation.codeGate, "release for cleanup");
          fs.writeFileSync(preparation.commandGate, "release for cleanup");
          await work.catch(() => undefined);
        }
      },
    );

    it("keeps control reads responsive and admits sibling writes in FIFO order after native settlement", async () => {
      const { db, worker } = await setup();
      const transactionMarker = path.join(root, "transaction");
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const native = worker.run(
        (scope) =>
          scope.execute({
            type: "append",
            input: { value: "worker", transactionMarker, delayMs: 250 },
          }),
        () => undefined,
      );
      try {
        await waitForMarker(transactionMarker, native);
        const observed: string[] = [];
        const writes = ["first", "second"].map((value) =>
          withOpenClawAgentDatabaseWrite(
            options,
            () => {
              observed.push(value);
              db.prepare("INSERT INTO worker_proof(value) VALUES (?)").run(value);
            },
            db,
          ),
        );
        expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
        await nextTurn();
        expect(observed).toEqual([]);
        expect(await native).toBeGreaterThan(0);
        await Promise.all(writes);
        expect(ticks).toBeGreaterThan(5);
        expect(observed).toEqual(["first", "second"]);
        expect(db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
          { value: "worker" },
          { value: "first" },
          { value: "second" },
        ]);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        clearInterval(timer);
        await native.catch(() => undefined);
      }
    });

    it("rolls back authority revoked before commit and keeps the owner reusable", async () => {
      const { db, worker } = await setup();
      let current = true;
      const transactionMarker = path.join(root, "before-commit");
      const work = worker.run(
        (scope) =>
          scope.execute({ type: "append", input: { value: "refused", transactionMarker } }),
        () => {
          if (!current) {
            throw new Error("fixture authority revoked");
          }
        },
      );
      void work.catch(() => undefined);
      await waitForMarker(transactionMarker, work);
      current = false;
      await expect(work).rejects.toThrow("fixture authority revoked");
      expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([]);
      await worker.run(
        (scope) => scope.execute({ type: "append", input: { value: "retry" } }),
        () => undefined,
      );
      expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "retry" }]);
    });

    it("drains an accepted commit grant when close revokes later work", async () => {
      const { db, worker } = await setup();
      const commitMarker = path.join(root, "accepted-commit");
      const work = worker.run(
        (scope) => scope.execute({ type: "append", input: { value: "accepted", commitMarker } }),
        () => undefined,
      );
      await waitForMarker(commitMarker, work);
      let closed = false;
      const close = worker.close().then(() => {
        closed = true;
      });
      await nextTurn();
      expect(closed).toBe(false);
      await expect(
        worker.run(
          async () => 0,
          () => undefined,
        ),
      ).rejects.toThrow("closed");
      expect(await work).toBeGreaterThan(0);
      await close;
      expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "accepted" }]);
    });
    it("refuses opening before the native factory without terminating pooled siblings", async () => {
      const siblings = [];
      const resume = createDeferredCore();
      const held: Promise<void>[] = [];
      try {
        for (let index = 0; index < 4; index++) {
          options = { ...options, path: path.join(root, "agent-" + index + ".sqlite") };
          const sibling = await setup();
          siblings.push(sibling);
          const entered = createDeferredCore();
          const work = sibling.worker.run(
            async (scope) => {
              entered.resolve();
              await resume.promise;
              await scope.execute({ type: "append", input: { value: "survived" } });
            },
            () => undefined,
          );
          held.push(work);
          void work.catch(() => undefined);
          await Promise.race([entered.promise, work]);
        }
        const create = admission.createSqliteWorkerOperationAdmission;
        let refused = 0;
        const interception = vi
          .spyOn(admission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            create((request, grant) => {
              if (request.stage === "open") {
                refused++;
                throw new Error("controlled opening revocation");
              }
              admit(request, grant);
            }, attachment),
          );
        options = { ...options, path: path.join(root, "refused.sqlite") };
        const openMarker = path.join(root, "factory-entered");
        const { worker: refusedWorker } = await setup({ openMarker });
        await expect(
          refusedWorker.run(
            (scope) => scope.execute({ type: "append", input: { value: "refused" } }),
            () => undefined,
          ),
        ).rejects.toThrow("controlled opening revocation");
        interception.mockRestore();
        expect(refused).toBe(1);
        expect(fs.existsSync(openMarker)).toBe(false);
        resume.resolve();
        await Promise.all(held);
        for (const { db } of siblings) {
          expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([
            { value: "survived" },
          ]);
        }
      } finally {
        resume.resolve();
        await Promise.allSettled(held);
      }
    });

    it.each(["independent", "queued"] as const)(
      "preserves a committed result and admits a %s follower after cleanup admission is refused",
      async (follower) => {
        const { db, worker } = await setup();
        const committed = createDeferredCore<number>();
        const release = createDeferredCore();
        const create = admission.createSqliteWorkerOperationAdmission;
        let refuseCleanup = false;
        let refusals = 0;
        const interception = vi
          .spyOn(admission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            create((request, grant) => {
              if (refuseCleanup && request.stage === "prepare") {
                refuseCleanup = false;
                refusals++;
                throw new Error("controlled publication cleanup admission refusal");
              }
              admit(request, grant);
            }, attachment),
          );
        const first = worker.run(
          async (scope) => {
            const result = await scope.execute({ type: "append", input: { value: "first" } });
            committed.resolve(result);
            await release.promise;
            refuseCleanup = true;
            return result;
          },
          () => undefined,
        );
        void first.catch(() => undefined);
        let second: Promise<number> | undefined;
        const runFollower = () =>
          worker.run(
            (scope) => scope.execute({ type: "append", input: { value: "second" } }),
            () => undefined,
          );
        try {
          const result = await Promise.race([committed.promise, first]);
          expect(result).toBeGreaterThan(0);
          expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "first" }]);
          if (follower === "queued") {
            // The test context captures this borrower before the first writer starts cleanup.
            second = runFollower();
            void second.catch(() => undefined);
          }
          release.resolve();
          expect(await first).toBe(result);
          expect(refusals).toBe(1);
          interception.mockRestore();

          second ??= runFollower();
          expect(await second).toBeGreaterThan(0);
          expect(db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
            { value: "first" },
            { value: "second" },
          ]);
        } finally {
          release.resolve();
          await Promise.allSettled(second ? [first, second] : [first]);
          interception.mockRestore();
        }
      },
    );

    it("retains exact canonical lease cleanup after failure and releases it on retry", async () => {
      const { db, worker } = await setup();
      const shared = openOpenClawStateDatabase();
      const readLeases = () =>
        shared.db
          .prepare("SELECT * FROM agent_database_leases WHERE path = ? ORDER BY lease_id")
          .all(options.path);
      const hostLeases = readLeases();
      expect(hostLeases).toHaveLength(1);
      await worker.run(
        (scope) => scope.execute({ type: "append", input: { value: "before cleanup" } }),
        () => undefined,
      );
      const retainedLeases = readLeases();
      const workerLeases = retainedLeases.filter(
        (row) => !hostLeases.some((host) => host.lease_id === row.lease_id),
      );
      expect(workerLeases).toHaveLength(1);
      const leaseId = workerLeases[0]?.lease_id;
      if (typeof leaseId !== "string") {
        throw new Error("Expected the canonical worker's new lease");
      }
      const literal = shared.db.prepare("SELECT quote(?) AS literal").get(leaseId)?.literal;
      if (typeof literal !== "string") {
        throw new Error("Expected an escaped SQLite lease identifier");
      }
      const selection = { agentId: options.agentId, path: options.path };
      shared.db.exec(`CREATE TRIGGER refuse_worker_lease_cleanup
      BEFORE DELETE ON agent_database_leases WHEN OLD.lease_id = ${literal}
      BEGIN SELECT RAISE(ABORT, 'controlled worker lease cleanup failure'); END`);
      const failures: unknown[] = [];
      try {
        const closing = await Promise.allSettled(revokeAgentDatabaseResources(selection));
        expect(closing).toContainEqual({
          status: "rejected",
          reason: expect.objectContaining({
            errors: expect.arrayContaining([
              expect.objectContaining({ message: "controlled worker lease cleanup failure" }),
            ]),
          }),
        });
        expect(readLeases()).toEqual(retainedLeases);
        await expect(
          worker.run(
            async () => 0,
            () => undefined,
          ),
        ).rejects.toThrow("closed");
        const open = () =>
          openOpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations>(options, db, {
            moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint),
            input: undefined,
          });
        await expect(open()).rejects.toThrow("resources are closing");
        expect(readLeases()).toEqual(retainedLeases);
        shared.db.exec("DROP TRIGGER refuse_worker_lease_cleanup");
        const retried = await Promise.allSettled(revokeAgentDatabaseResources(selection));
        expect(retried).not.toContainEqual(expect.objectContaining({ status: "rejected" }));
        expect(readLeases()).toEqual(hostLeases);
        const recovered = await open();
        workers.add(recovered);
        await recovered.run(
          (scope) => scope.execute({ type: "append", input: { value: "after cleanup" } }),
          () => undefined,
        );
        expect(db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
          { value: "before cleanup" },
          { value: "after cleanup" },
        ]);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } catch (error) {
        failures.push(error);
      } finally {
        try {
          shared.db.exec("DROP TRIGGER IF EXISTS refuse_worker_lease_cleanup");
        } catch (error) {
          failures.push(error);
        }
        const cleanup = await Promise.allSettled(revokeAgentDatabaseResources(selection));
        for (const result of cleanup) {
          if (result.status === "rejected") {
            failures.push(result.reason);
          }
        }
      }
      if (failures.length === 1) {
        throw failures[0];
      }
      if (failures.length > 1) {
        throw new AggregateError(failures, "Publication fixture and cleanup failed", {
          cause: failures[0],
        });
      }
    });
    it("queues a real periodic maintenance tick behind publication", async () => {
      let tick: (() => void) | undefined;
      let capturing = false;
      const configure = sqliteWal.configureSqliteConnectionPragmas;
      vi.spyOn(sqliteWal, "configureSqliteConnectionPragmas").mockImplementation((db, policy) => {
        capturing = policy?.databasePath === options.path;
        try {
          return configure(db, policy);
        } finally {
          capturing = false;
        }
      });
      const interval = globalThis.setInterval;
      vi.spyOn(globalThis, "setInterval").mockImplementation((handler, milliseconds, ...args) => {
        if (capturing && typeof handler === "function") {
          tick = () => handler(...args);
        }
        return interval(handler, milliseconds, ...args);
      });
      const { db, worker } = await setup();
      if (!tick) {
        throw new Error("Expected the canonical agent maintenance timer");
      }
      db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
        VALUES ('maintenance-proof', 'pages', zeroblob(4194304), 1);
        DELETE FROM cache_entries WHERE scope = 'maintenance-proof';`);
      const freePages = () =>
        Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count ?? 0);
      const before = freePages();
      expect(before).toBeGreaterThan(512);
      const exec = vi.spyOn(db, "exec");
      const transactionMarker = path.join(root, "maintenance-transaction");
      const work = worker.run(
        (scope) =>
          scope.execute({
            type: "append",
            input: { value: "published", transactionMarker, delayMs: 250 },
          }),
        () => undefined,
      );
      await waitForMarker(transactionMarker, work);
      const started = performance.now();
      tick();
      expect(performance.now() - started).toBeLessThan(100);
      expect(exec.mock.calls.some(([sql]) => sql.includes("incremental_vacuum"))).toBe(false);
      expect(freePages()).toBe(before);
      await work;
      await withOpenClawAgentDatabaseWrite(options, () => undefined, db);
      expect(exec.mock.calls.some(([sql]) => sql.includes("incremental_vacuum"))).toBe(true);
      expect(before - freePages()).toBeGreaterThan(0);
      expect(before - freePages()).toBeLessThanOrEqual(512);
      expect(db.prepare("SELECT value FROM worker_proof").all()).toEqual([{ value: "published" }]);
    });
  },
);
