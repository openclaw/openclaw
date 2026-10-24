import { channel } from "node:diagnostics_channel";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as nextTurn } from "node:timers/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useSqliteWorkerFault } from "../../test/helpers/sqlite-worker-fault.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { throwSqliteLifecycleErrors } from "../infra/sqlite-lifecycle-errors.js";
import { observeSqliteWalPeriodicWork } from "../infra/sqlite-wal-scheduler.test-support.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import { readDatabasePathIdentitySync } from "../infra/sqlite-worker-identity.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import { openSqliteWorkerStore } from "../infra/sqlite-worker-store.js";
import type { FixtureOperations } from "../infra/sqlite-worker-store.test-support.js";
import {
  beginGatewayShutdownCleanup,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  closeOpenClawAgentDatabasesAsync,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import {
  isAgentDatabaseClosing,
  registerOpenClawAgentDatabaseAsyncResource,
  revokeAgentDatabaseResources,
} from "./openclaw-agent-db-resources.js";
import { withOpenClawAgentDatabaseWrite } from "./openclaw-agent-db-write.js";
import {
  openOpenClawAgentDatabase as openDatabase,
  closeOpenClawAgentDatabasesForTest,
  withOpenClawAgentDatabaseAdmission,
  withOpenClawAgentDatabaseAsync,
} from "./openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution as captureExecution } from "./openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore as openWorkerStore,
  openOpenClawAgentSqliteWorkerStoreV2 as openWorkerStoreV2,
  type OpenClawAgentSqliteWorkerStore,
  type OpenClawAgentSqliteWorkerStoreV2,
} from "./openclaw-agent-worker-store.js";
import { agentWorkerStoreFixtureEntrypoint } from "./openclaw-agent-worker-store.runtime.test-support.js";
import type {
  AgentWorkerFixtureOperations as AgentOperations,
  bindSqliteWorkerBackend,
} from "./openclaw-agent-worker-store.test-support.js";
import { waitForFixtureEntry } from "./openclaw-agent-worker-store.wait.test-support.js";
import { runOpenClawAgentWorkerWrite as runWorkerWrite } from "./openclaw-agent-write-admission.js";
import { retainOpenClawStateDatabaseForIdle } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const allow = () => undefined;
const append = (value: string, input: Omit<AgentOperations["append"]["input"], "value"> = {}) => ({
  type: "append" as const,
  input: { value, ...input },
});
const workerModule = (input?: Parameters<typeof bindSqliteWorkerBackend>[0]) => ({
  moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint),
  input,
});
const expectValues = (db: { prepare(sql: string): { all(): unknown } }, values: string[]) =>
  expect(db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual(
    values.map((value) => ({ value })),
  );

const leaseReader =
  (shared: ReturnType<typeof openOpenClawStateDatabase>, columns = "lease_id") =>
  (pathname = options.path) =>
    shared.db
      .prepare(`SELECT ${columns} FROM agent_database_leases WHERE path = ? ORDER BY lease_id`)
      .all(pathname);

async function openWorker(
  source: Parameters<typeof openWorkerStore>[1],
  input?: Parameters<typeof bindSqliteWorkerBackend>[0],
) {
  const worker = await openWorkerStore<AgentOperations>(options, source, workerModule(input));
  workers.add(worker);
  return worker;
}

const leaseCleanupFault = useSqliteWorkerFault([
  {
    name: "refuse_worker_lease_cleanup",
    match: /^delete from agent_database_leases\b/u,
    sql: `CREATE TEMP TRIGGER refuse_worker_lease_cleanup
      BEFORE DELETE ON main.agent_database_leases
      BEGIN SELECT RAISE(ABORT, 'controlled worker lease cleanup failure'); END;`,
  },
]);

// Vitest can enter teardown while a timed-out body is still closing its native owners.
const fixture = createFixtureLifetime();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await fixture.cleanup();
    await fixture.verifyCleanup(async () => {
      await Promise.all([...workers].map((worker) => worker.close()));
      workers.clear();
      await Promise.all([...executions].map((execution) => execution.release()));
      executions.clear();
      vi.restoreAllMocks();
      await closeOpenClawAgentDatabasesAsync(root);
      closeOpenClawAgentDatabasesForTest();
    });
    await fixture.cleanup();
    cleanup();
  }),
);
const workers = new Set<OpenClawAgentSqliteWorkerStore<AgentOperations>>();
const executions = new Set<OpenClawAgentDatabaseExecution>();
let sourceMode: "borrowed" | "captured" = "borrowed";
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await fixture.cleanup();
  await receipts.close();
});
let root: string;
let options: { agentId: string; path: string };
beforeEach(() => {
  root = fs.realpathSync(tempDirs.make("agent-worker-publication-"));
  options = { agentId: "main", path: path.join(root, "agent.sqlite") };
});
async function setup(input?: Parameters<typeof bindSqliteWorkerBackend>[0]) {
  const db = requireNativeSqliteDatabase(openDatabase(options).db);
  db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
  const execution = sourceMode === "captured" ? captureExecution(options) : undefined;
  if (execution) {
    executions.add(execution);
  }
  const worker = await openWorker(execution ? { execution } : db, {
    ...input,
    receiptBroadcastName: receipts.broadcastName,
  });
  return { db, worker };
}

it("leaves agent worker checkpoints to maintenance instead of foreground commits", async () => {
  const { worker } = await setup();
  expect(await worker.execute({ type: "inspect", input: "wal_autocheckpoint" }, allow)).toBe(0);
});

it("renews idle retention on reborrow", async () => {
  const { db, worker } = await setup();
  const shared = openOpenClawStateDatabase();
  const releaseState = retainOpenClawStateDatabaseForIdle(shared);
  const readLeases = leaseReader(shared);
  const hostLeases = readLeases();
  const publish = (value: string) => worker.run((scope) => scope.execute(append(value)), allow);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await publish("first");
    const retainedLeases = readLeases();
    expect(retainedLeases).toHaveLength(hostLeases.length + 1);

    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    const borrowed = captureExecution(options);
    executions.add(borrowed);
    await publish("reborrowed");
    expect(readLeases()).toEqual(retainedLeases);
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(readLeases()).toEqual(retainedLeases);
    await borrowed.release();
    executions.delete(borrowed);

    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(readLeases()).toEqual(retainedLeases);
    await vi.advanceTimersByTimeAsync(1);
    // A new request joins the expired generation's cleanup before reopening it.
    await publish("after idle");
    expect(readLeases()).toHaveLength(retainedLeases.length);
    expect(readLeases()).not.toEqual(retainedLeases);
    expectValues(db, ["first", "reborrowed", "after idle"]);
  } finally {
    vi.useRealTimers();
    releaseState();
  }
});

it("retains warm execution across fallback preparation", async () => {
  const { db, worker } = await setup();
  const firstThread = await worker.execute(append("before preparation"), allow);
  const lifetime = captureExecution(options);
  executions.add(lifetime);
  await worker.close();
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  let next: OpenClawAgentSqliteWorkerStore<AgentOperations> | undefined;
  const publication = (async () => {
    entered.resolve();
    await resume.promise;
    next = await openWorker(db);
    return next.run((scope) => scope.execute(append("after preparation")), allow);
  })();
  try {
    await entered.promise;
    markGatewayRestartDraining();
    resume.resolve();
    expect(await publication).toBe(firstThread);
    expectValues(db, ["before preparation", "after preparation"]);
    await next?.close();
    expect(db.isOpen).toBe(true);
    beginGatewayShutdownCleanup();
    await lifetime.release();
    expect(db.isOpen).toBe(false);
    expect(readSqliteDatabaseCleanClose(options.path)).toBe(true);
  } finally {
    resume.resolve();
    await Promise.allSettled([publication]);
    await Promise.allSettled([next?.close(), lifetime.release(), worker.close()]);
    executions.delete(lifetime);
    resetGatewayWorkAdmission();
  }
});

it.each([false, true])(
  "releases shutdown leases unless retained by an accepted sequence (%s)",
  async (retainGeneration) => {
    const { db, worker } = await setup();
    const execution = retainGeneration ? captureExecution(options) : undefined;
    if (execution) {
      executions.add(execution);
    }
    const shared = openOpenClawStateDatabase();
    const releaseState = retainOpenClawStateDatabaseForIdle(shared);
    const readLeases = leaseReader(shared);
    const hostLeases = readLeases();
    try {
      const firstThread = await worker.run(async (scope) => {
        const thread = await scope.execute(append("first"));
        markGatewayRestartDraining();
        return thread;
      }, allow);
      const retainedLeases = readLeases();
      const secondThread = await worker.execute(append("second"), allow);
      expect(secondThread).toBe(firstThread);
      expect(retainedLeases).toHaveLength(hostLeases.length + 1);
      expect(readLeases()).toEqual(retainedLeases);
      await worker.run((scope) => scope.execute(append("third")), allow);
      expect(readLeases()).toEqual(retainedLeases);
      beginGatewayShutdownCleanup();
      const cleanupThread = await worker.execute(append("cleanup"), allow);
      if (retainGeneration) {
        expect(cleanupThread).toBe(firstThread);
        expect(readLeases()).toEqual(retainedLeases);
      } else {
        expect(readLeases()).toEqual(hostLeases);
      }
      expectValues(db, ["first", "second", "third", "cleanup"]);
      await worker.close();
      await execution?.release();
      expect(db.isOpen).toBe(false);
      expect(readLeases()).toEqual([]);
      expect(readSqliteDatabaseCleanClose(options.path)).toBe(true);
    } finally {
      await worker.close();
      await execution?.release();
      if (execution) {
        executions.delete(execution);
      }
      resetGatewayWorkAdmission();
      releaseState();
    }
  },
);

it.each([false, true])(
  "certifies native close only after its WAL is empty (pinned: %s)",
  async (pinned) => {
    const { db, worker } = await setup();
    const releaseHost = retainAgentDatabase(db);
    let reader: DatabaseSync | undefined;
    try {
      await worker.execute(append("worker commit"), () => {});
      beginGatewayShutdownCleanup();
      await worker.close();
      if (pinned) {
        reader = new DatabaseSync(options.path, { readOnly: true });
        reader.exec("BEGIN");
        reader.prepare("SELECT value FROM worker_proof").all();
      }
      db.exec("INSERT INTO worker_proof VALUES ('after worker checkpoint')");
      const prepare = vi.spyOn(db, "prepare");
      const exec = vi.spyOn(db, "exec");
      await closeOpenClawAgentDatabasesAsync(root);
      expect(prepare).not.toHaveBeenCalled();
      // Retirement may change lock policy, but must not run host-thread data SQL.
      expect(exec.mock.calls).toEqual([["PRAGMA busy_timeout = 0"]]);
      expect(readSqliteDatabaseCleanClose(options.path)).toBe(!pinned);
      resetGatewayWorkAdmission();
      const reopened = openDatabase(options);
      expect(reopened.db.prepare("SELECT value FROM worker_proof ORDER BY rowid").all()).toEqual([
        { value: "worker commit" },
        { value: "after worker checkpoint" },
      ]);
    } finally {
      reader?.close();
      releaseHost();
      resetGatewayWorkAdmission();
    }
  },
);

it("closes siblings while a publication retains its database", ({ signal }) =>
  fixture.run(async () => {
    const { db, worker } = await setup();
    const heldPath = options.path;
    const healthy = openDatabase({
      agentId: "healthy",
      path: path.join(root, "healthy.sqlite"),
    });
    const shared = openOpenClawStateDatabase();
    const readLeases = leaseReader(shared);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const healthyClosed = createDeferredCore();
    const nativeClose = healthy.db.close.bind(healthy.db);
    vi.spyOn(healthy.db, "close").mockImplementation(() => {
      nativeClose();
      healthyClosed.resolve();
    });
    const publication = worker.run(async (scope) => {
      const result = await scope.execute(append("committed"));
      entered.resolve();
      await release.promise;
      return result;
    }, allow);
    let closing: Promise<void> | undefined;
    let closed = false;
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          entered.promise,
          publication,
          "Worker publication was not retained",
        ),
        signal,
      );
      expect(readLeases(heldPath)).toHaveLength(2);
      expect(readLeases(healthy.path)).toHaveLength(1);
      closing = closeOpenClawAgentDatabasesAsync(root).then(() => {
        closed = true;
      });
      await withinTest(
        awaitGateBeforeSettlement(
          healthyClosed.promise,
          closing,
          "Root close settled before the healthy database closed",
        ),
        signal,
      );
      expect(healthy.db.isOpen).toBe(false);
      expect(readLeases(healthy.path)).toEqual([]);
      expect(readSqliteDatabaseCleanClose(healthy.path)).toBe(true);
      expect(db.isOpen).toBe(true);
      expect(readLeases(heldPath)).toHaveLength(2);
      expect(readSqliteDatabaseCleanClose(heldPath)).toBe(false);
      expect(closed).toBe(false);
      expect(isAgentDatabaseClosing(healthy)).toBe(true);
      const later = { agentId: "late", path: path.join(root, "late.sqlite") };
      expect(() => openDatabase(later)).toThrow("resources are closing");
      await expect(withOpenClawAgentDatabaseAsync(later, (database) => database)).rejects.toThrow(
        "resources are closing",
      );
      await expect(
        withOpenClawAgentDatabaseAdmission(
          later,
          async (run) => run(() => {}),
          (database) => database,
        ),
      ).rejects.toThrow("resources are closing");
      expect(fs.existsSync(later.path)).toBe(false);
      expect(readLeases(later.path)).toEqual([]);
      expect(openDatabase(options).db).toBe(db);
      expect(() =>
        registerOpenClawAgentDatabaseAsyncResource({
          agentId: "new",
          path: path.join(root, "new.sqlite"),
          revoke() {},
          close: async () => {},
        }),
      ).toThrow("resources are closing");
      release.resolve();
      await withinTest(publication, signal);
      await withinTest(closing, signal);
      expect(db.isOpen).toBe(false);
      expect(readLeases(heldPath)).toEqual([]);
      expect(readSqliteDatabaseCleanClose(heldPath)).toBe(true);
      expect(isAgentDatabaseClosing(healthy)).toBe(false);
      expect(openDatabase(later).db.isOpen).toBe(true);
    } finally {
      release.resolve();
      await Promise.allSettled([publication, closing]);
    }
  }));

describe("pooled agent publication owner (captured source)", () => {
  beforeEach(() => {
    sourceMode = "captured";
  });
  it.for([
    { entry: "scope", outcome: "revoked" },
    { entry: "single", outcome: "success" },
  ] as const)(
    "awaits both nested preparation hooks before $outcome $entry publication admission",
    ({ entry, outcome }, { signal }) =>
      fixture.run(async () => {
        signal.throwIfAborted();
        const preparation = {
          codeMarker: path.join(root, "code-loading"),
          codeGate: path.join(root, "code-release"),
          commandMarker: path.join(root, "command-preparing"),
          commandGate: path.join(root, "command-release"),
        };
        const { db, worker } = await setup({ preparation });
        let current = true;
        const assertCurrent = () => {
          if (!current) {
            throw new Error("fixture authority revoked during preparation");
          }
        };
        const command = append("prepared");
        const work =
          entry === "single"
            ? worker.execute(command, assertCurrent)
            : worker.run((scope) => scope.execute(command), assertCurrent);
        void work.catch(allow);
        try {
          await waitForFixtureEntry(receipts, preparation.codeMarker, work, signal);
          expect(fs.existsSync(preparation.commandMarker)).toBe(false);
          expectValues(db, []);
          fs.writeFileSync(preparation.codeGate, "release code loading");
          await waitForFixtureEntry(receipts, preparation.commandMarker, work, signal);
          expectValues(db, []);
          current = outcome === "success";
          fs.writeFileSync(preparation.commandGate, "release command preparation");
          if (outcome === "revoked") {
            await expect(work).rejects.toThrow("fixture authority revoked during preparation");
            expectValues(db, []);
            await worker.run((scope) => scope.execute(append("retry")), allow);
            expectValues(db, ["retry"]);
          } else {
            expect(await work).toBeGreaterThan(0);
            expectValues(db, ["prepared"]);
          }
        } finally {
          fs.writeFileSync(preparation.codeGate, "release for cleanup");
          fs.writeFileSync(preparation.commandGate, "release for cleanup");
          await work.catch(allow);
        }
      }),
  );

  it("keeps reads responsive and sibling writes FIFO", ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const { db, worker } = await setup();
      const transactionMarker = path.join(root, "transaction");
      let ticks = 0;
      const timer = setInterval(() => ticks++, 10);
      const native = worker.run(
        (scope) => scope.execute(append("worker", { transactionMarker, delayMs: 250 })),
        allow,
      );
      try {
        await waitForFixtureEntry(receipts, transactionMarker, native, signal);
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
        expectValues(db, []);
        await nextTurn();
        expect(observed).toEqual([]);
        expect(await native).toBeGreaterThan(0);
        await Promise.all(writes);
        expect(ticks).toBeGreaterThan(5);
        expect(observed).toEqual(["first", "second"]);
        expectValues(db, ["worker", "first", "second"]);
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        clearInterval(timer);
        await native.catch(allow);
      }
    }));

  it("rolls back revoked authority and permits retry", ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      const { db, worker } = await setup();
      let current = true;
      const transactionMarker = path.join(root, "before-commit");
      const work = worker.run(
        (scope) => scope.execute(append("refused", { transactionMarker })),
        () => {
          if (!current) {
            throw new Error("fixture authority revoked");
          }
        },
      );
      void work.catch(allow);
      await waitForFixtureEntry(receipts, transactionMarker, work, signal);
      current = false;
      await expect(work).rejects.toThrow("fixture authority revoked");
      expectValues(db, []);
      await worker.run((scope) => scope.execute(append("retry")), allow);
      expectValues(db, ["retry"]);
    }));

  it.for(["scope", "single"] as const)(
    "drains accepted %s commits before closing",
    (entry, { signal }) =>
      fixture.run(async () => {
        signal.throwIfAborted();
        const { db, worker } = await setup();
        const commitMarker = path.join(root, "accepted-commit");
        const command = append("accepted", { commitMarker });
        const work =
          entry === "single"
            ? worker.execute(command, allow)
            : worker.run((scope) => scope.execute(command), allow);
        await waitForFixtureEntry(receipts, commitMarker, work, signal);
        let closed = false;
        const close = worker.close().then(() => {
          closed = true;
        });
        await nextTurn();
        expect(closed).toBe(false);
        await expect(worker.run(async () => 0, allow)).rejects.toThrow("closed");
        expect(await work).toBeGreaterThan(0);
        await close;
        expectValues(db, ["accepted"]);
      }),
  );

  it("keeps single commands in the shared FIFO while canceling a queued input", async () => {
    const { db, worker } = await setup();
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    const first = worker.run(async (scope) => {
      entered.resolve();
      await resume.promise;
      return scope.execute(append("first"));
    }, allow);
    await Promise.race([entered.promise, first]);
    const cancellation = new AbortController();
    const reason = new Error("Cancel the queued single publication");
    const canceled = worker.execute(append("canceled"), allow, { signal: cancellation.signal });
    const refused = expect(canceled).rejects.toBe(reason);
    cancellation.abort(reason);
    const following = worker.execute(append("following"), allow);
    resume.resolve();
    await Promise.all([first, refused, following]);
    expectValues(db, ["first", "following"]);
  });

  it("preserves command success despite binding cleanup failure", async () => {
    const { db, worker } = await setup({ closeFailure: "fixture binding cleanup failed" });
    expect(await worker.execute(append("committed"), allow)).toBeGreaterThan(0);
    expectValues(db, ["committed"]);
    const following = await openWorker(db);
    expect(await following.execute(append("follower"), allow)).toBeGreaterThan(0);
    expectValues(db, ["committed", "follower"]);
  });

  it.each(["ordinary", "admission"] as const)(
    "preserves %s errors when cleanup admission fails",
    async (failure) => {
      const { db, worker } = await setup({ cleanupAdmission: true });
      db.exec(`
        CREATE TRIGGER fail_command BEFORE INSERT ON worker_proof
        WHEN NEW.value = 'failed'
        BEGIN
          SELECT RAISE(ABORT, 'controlled command failure');
        END
      `);
      const commandRefusal = new Error("controlled command admission refusal");
      let commandRefusals = 0;
      let refusals = 0;
      const interception = probe.admission(admission, (request, grant, admit) => {
        if (failure === "admission" && request.stage === "transaction") {
          commandRefusals++;
          throw commandRefusal;
        }
        if (isRecord(request.facts) && request.facts.kind === "fixture-cleanup") {
          refusals++;
          throw new Error("controlled publication cleanup admission refusal");
        }
        admit(request, grant);
      });
      const result = worker.execute(append("failed"), allow);
      if (failure === "admission") {
        await expect(result).rejects.toBe(commandRefusal);
      } else {
        await expect(result).rejects.toThrow("controlled command failure");
      }
      expect(commandRefusals).toBe(failure === "admission" ? 1 : 0);
      expect(refusals).toBe(1);
      expectValues(db, []);
      interception.mockRestore();

      const following = await openWorker(db);
      expect(await following.execute(append("follower"), allow)).toBeGreaterThan(0);
      expectValues(db, ["follower"]);
    },
  );

  it("does not grant a cleanup transaction after a single read", async () => {
    const { db, worker } = await setup({ closeWriteValue: "must not commit" });
    await expect(worker.execute({ type: "inspect", input: undefined }, allow)).resolves.toBe(0);
    expectValues(db, []);
  });

  it("refuses factory entry without terminating siblings", async () => {
    const siblings = [];
    const resume = createDeferredCore();
    const held: Promise<void>[] = [];
    try {
      for (let index = 0; index < 4; index++) {
        options = { ...options, path: path.join(root, "agent-" + index + ".sqlite") };
        const sibling = await setup();
        siblings.push(sibling);
        const entered = createDeferredCore();
        const work = sibling.worker.run(async (scope) => {
          entered.resolve();
          await resume.promise;
          await scope.execute(append("survived"));
        }, allow);
        held.push(work);
        void work.catch(allow);
        await Promise.race([entered.promise, work]);
      }
      let refused = 0;
      const interception = probe.admission(admission, (request, grant, admit) => {
        if (request.stage === "open") {
          refused++;
          throw new Error("controlled opening revocation");
        }
        admit(request, grant);
      });
      options = { ...options, path: path.join(root, "refused.sqlite") };
      const openMarker = path.join(root, "factory-entered");
      const { worker: refusedWorker } = await setup({ openMarker });
      await expect(
        refusedWorker.run((scope) => scope.execute(append("refused")), allow),
      ).rejects.toThrow("controlled opening revocation");
      interception.mockRestore();
      expect(refused).toBe(1);
      expect(fs.existsSync(openMarker)).toBe(false);
      resume.resolve();
      await Promise.all(held);
      for (const { db } of siblings) {
        expectValues(db, ["survived"]);
      }
    } finally {
      resume.resolve();
      await Promise.allSettled(held);
    }
  });

  it("preserves commits and queued followers after cleanup refusal", async () => {
    const { db, worker } = await setup();
    const committed = createDeferredCore<number>();
    const release = createDeferredCore();
    let refuseCleanup = false;
    let refusals = 0;
    const interception = probe.admission(admission, (request, grant, admit) => {
      if (refuseCleanup && request.stage === "prepare") {
        refuseCleanup = false;
        refusals++;
        throw new Error("controlled publication cleanup admission refusal");
      }
      admit(request, grant);
    });
    const first = worker.run(async (scope) => {
      const result = await scope.execute(append("first"));
      committed.resolve(result);
      await release.promise;
      refuseCleanup = true;
      return result;
    }, allow);
    void first.catch(allow);
    let second: Promise<number> | undefined;
    const runFollower = () => worker.run((scope) => scope.execute(append("second")), allow);
    try {
      const result = await Promise.race([committed.promise, first]);
      expect(result).toBeGreaterThan(0);
      expectValues(db, ["first"]);
      // The test context captures this borrower before the first writer starts cleanup.
      second = runFollower();
      void second.catch(allow);
      release.resolve();
      expect(await first).toBe(result);
      expect(refusals).toBe(1);
      interception.mockRestore();

      expect(await second).toBeGreaterThan(0);
      expectValues(db, ["first", "second"]);
    } finally {
      release.resolve();
      await Promise.allSettled(second ? [first, second] : [first]);
      interception.mockRestore();
    }
  });

  it("retains failed lease cleanup for exact retry", async () => {
    const { db, worker } = await setup();
    const shared = openOpenClawStateDatabase();
    const readLeases = leaseReader(shared, "*");
    const hostLeases = readLeases();
    expect(hostLeases).toHaveLength(1);
    await worker.run((scope) => scope.execute(append("before cleanup")), allow);
    const retainedLeases = readLeases();
    const workerLeases = retainedLeases.filter(
      (row) => !hostLeases.some((host) => host.lease_id === row.lease_id),
    );
    expect(workerLeases).toHaveLength(1);
    const selection = { agentId: options.agentId, path: options.path };
    leaseCleanupFault.enable();
    const failures: unknown[] = [];
    try {
      const closing = await Promise.allSettled(revokeAgentDatabaseResources(selection));
      const causes = (error: unknown): unknown[] =>
        error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
      const cleanupErrors = closing.flatMap((result) =>
        result.status === "rejected" ? causes(result.reason) : [],
      );
      expect(cleanupErrors.length).toBeGreaterThan(0);
      for (const error of cleanupErrors) {
        expect(error).toMatchObject({ message: "controlled worker lease cleanup failure" });
      }
      expect(readLeases()).toEqual(retainedLeases);
      await expect(worker.run(async () => 0, allow)).rejects.toThrow("closed");
      const open = () => openWorker(db);
      await expect(open()).rejects.toThrow("resources are closing");
      expect(readLeases()).toEqual(retainedLeases);
      leaseCleanupFault.disable();
      const retried = await Promise.allSettled(revokeAgentDatabaseResources(selection));
      expect(retried).not.toContainEqual(expect.objectContaining({ status: "rejected" }));
      expect(readLeases()).toEqual(hostLeases);
      const recovered = await open();
      await recovered.run((scope) => scope.execute(append("after cleanup")), allow);
      expectValues(db, ["before cleanup", "after cleanup"]);
      expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    } catch (error) {
      failures.push(error);
    } finally {
      leaseCleanupFault.disable();
      const cleanup = await Promise.allSettled(revokeAgentDatabaseResources(selection));
      for (const result of cleanup) {
        if (result.status === "rejected") {
          failures.push(result.reason);
        }
      }
    }
    throwSqliteLifecycleErrors(failures, "Publication fixture and cleanup failed");
  });
  it("queues a real periodic maintenance tick behind publication", ({ signal }) =>
    fixture.run(async () => {
      signal.throwIfAborted();
      let capturing = false;
      const scheduled = observeSqliteWalPeriodicWork(() => capturing);
      const configure = sqliteWal.configureSqliteConnectionPragmas;
      vi.spyOn(sqliteWal, "configureSqliteConnectionPragmas").mockImplementation((db, policy) => {
        capturing = policy?.databasePath === options.path;
        try {
          return configure(db, policy);
        } finally {
          capturing = false;
        }
      });
      const { db, worker } = await setup().finally(scheduled.restore);
      const tick = scheduled.periodic;
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
        (scope) => scope.execute(append("published", { transactionMarker, delayMs: 250 })),
        allow,
      );
      await waitForFixtureEntry(receipts, transactionMarker, work, signal);
      const started = performance.now();
      const maintenance = Promise.resolve(tick());
      expect(performance.now() - started).toBeLessThan(100);
      expect(exec.mock.calls.some(([sql]) => sql.includes("incremental_vacuum"))).toBe(false);
      expect(freePages()).toBe(before);
      await work;
      await maintenance;
      await withOpenClawAgentDatabaseWrite(options, allow, db);
      expect(exec.mock.calls.some(([sql]) => sql.includes("incremental_vacuum"))).toBe(false);
      expect(before - freePages()).toBeGreaterThan(0);
      expect(before - freePages()).toBeLessThanOrEqual(512);
      expectValues(db, ["published"]);
    }));
});

type V2Worker = OpenClawAgentSqliteWorkerStoreV2<AgentOperations>;

async function openV2Worker(
  workerOptions: Partial<Parameters<typeof openWorkerStoreV2>[2]> = {},
  source: Parameters<typeof openWorkerStoreV2>[1] = { version: 2, assertCurrent: allow },
) {
  const worker = await openWorkerStoreV2<AgentOperations>(options, source, {
    ...workerModule(),
    ...workerOptions,
  });
  workers.add(worker);
  return worker;
}

function proofDatabase() {
  const { db } = openDatabase(options);
  db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
  return db;
}
async function expectReadmission(
  db: ReturnType<typeof proofDatabase>,
  worker: V2Worker,
  prior: string[] = [],
) {
  await expect(worker.execute(append("still refused"), allow)).rejects.toThrow();
  const recovered = await openV2Worker();
  expect(await recovered.execute(append("readmitted"), allow)).toBeGreaterThan(0);
  expectValues(db, [...prior, "readmitted"]);
}
function observeTerminal(worker: V2Worker) {
  const notify = vi.fn();
  const terminal = createDeferredCore();
  worker.terminalSignal.addEventListener(
    "abort",
    () => {
      notify(worker.terminalSignal.reason);
      terminal.resolve();
    },
    { once: true },
  );
  return { notify, terminal: terminal.promise };
}

it.each([false, true])(
  "V2 preserves absence and prepares alongside a captured creator: %s",
  async (concurrentCreator) => {
    if (concurrentCreator) {
      executions.add(
        captureExecution(options, {
          expectedCreationIdentity: readDatabasePathIdentitySync(options.path),
        }),
      );
    }
    const worker = await openV2Worker();
    if (!concurrentCreator) {
      expect(
        await worker.executeExisting({ type: "inspect", input: undefined }, allow),
      ).toBeUndefined();
    }
    expect(fs.existsSync(options.path)).toBe(false);
    await worker.prepare();
    expect(fs.existsSync(options.path)).toBe(true);
    const { db } = openDatabase(options);
    db.exec("CREATE TABLE worker_proof (value TEXT NOT NULL)");
    expect(await worker.execute(append("worker-owned"), allow)).toBeGreaterThan(0);
    expectValues(db, ["worker-owned"]);
    await worker.close();
    expect(worker.terminalSignal.aborted).toBe(false);
    await expect(worker.prepare()).rejects.toThrow("closed");
    await expect(worker.execute({ type: "inspect", input: undefined }, allow)).rejects.toThrow(
      "closed",
    );
  },
);

it.for(["owner revocation", "crash", "exit", "resource revocation"] as const)(
  "V2 settles %s and readmits through a fresh worker",
  async (failure, { signal }) => {
    const db = proofDatabase();
    let current = true;
    const worker =
      failure === "owner revocation"
        ? await openV2Worker(
            {
              onAdmitted(request) {
                if (request.stage === "transaction") {
                  current = false;
                }
              },
            },
            {
              version: 2,
              assertCurrent() {
                if (!current) {
                  throw new Error("V2 owner revoked");
                }
              },
            },
          )
        : await openV2Worker();
    const observed = observeTerminal(worker);
    if (failure === "owner revocation") {
      await expect(worker.execute(append("refused"), allow)).rejects.toThrow("V2 owner revoked");
    } else if (failure === "resource revocation") {
      let revoked: Promise<void> | undefined;
      let terminalBeforePublication: boolean | undefined;
      const committedAtNotification: unknown[] = [];
      worker.terminalSignal.addEventListener("abort", () => {
        committedAtNotification.push(db.prepare("SELECT value FROM worker_proof").all());
      });
      const accepted = worker.run(async (scope) => {
        const result = await scope.execute(append("accepted"));
        // Revoke after native COMMIT, but before publication settles.
        revoked = Promise.all(revokeAgentDatabaseResources(options)).then(allow);
        void revoked.catch(allow);
        terminalBeforePublication = worker.terminalSignal.aborted;
        return result;
      }, allow);
      expect(await withinTest(accepted, signal)).toBeGreaterThan(0);
      await withinTest(observed.terminal, signal);
      await revoked;
      expect(terminalBeforePublication).toBe(false);
      expect(committedAtNotification).toEqual([[{ value: "accepted" }]]);
    } else {
      const failed = worker.execute({ type: "failWorker", input: failure }, allow);
      const queued = worker.execute(append("must not write"), allow);
      expect(await withinTest(Promise.allSettled([failed, queued]), signal)).toEqual([
        { status: "rejected", reason: expect.any(Error) },
        { status: "rejected", reason: expect.any(Error) },
      ]);
      await withinTest(observed.terminal, signal);
      expect(worker.terminalSignal.aborted).toBe(true);
      expect(worker.terminalSignal.reason).toMatchObject({
        message: expect.stringMatching(/worker|exit|crash/i),
      });
    }
    await withinTest(observed.terminal, signal);
    expect(observed.notify).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
    const reason: unknown = worker.terminalSignal.reason;
    if (failure === "owner revocation") {
      expect(reason).toMatchObject({ message: "V2 owner revoked" });
      expectValues(db, []);
    } else if (failure === "crash" || failure === "exit") {
      await expect(worker.prepare()).rejects.toThrow();
    }
    await expectReadmission(db, worker, failure === "resource revocation" ? ["accepted"] : []);
    if (failure === "crash" || failure === "exit") {
      await worker.close();
      expect(worker.terminalSignal.reason).toBe(reason);
      expect(observed.notify).toHaveBeenCalledTimes(1);
    }
  },
);

it("attributes cold worker reservations to bounded commands and actual outer transactions", async () => {
  const reservationOptions = {
    agentId: "fixture",
    path: path.join(tempDirs.make("reservation-"), "agent.sqlite"),
  };
  const diagnostics = channel("openclaw.agent-database.reservation");
  const observations: unknown[] = [];
  const observe = (message: unknown) => observations.push(message);
  diagnostics.subscribe(observe);
  try {
    await runWorkerWrite(reservationOptions, async () => {
      const store = await openSqliteWorkerStore<FixtureOperations>({
        moduleUrl: new URL("../infra/sqlite-worker-store.test-support.ts", import.meta.url),
        databasePath: reservationOptions.path,
        input: undefined,
      });
      try {
        const execute = (
          type: FixtureOperations["database.domain.execute"]["input"]["command"]["type"],
          value: string,
        ) =>
          store.execute({
            type: "database.domain.execute",
            input: { command: { type, input: { value } } },
          });
        await execute("session.actor.appendTranscriptEvent", "synthetic-private-committed");
        await expect(
          execute("session.private-customer-command", "synthetic-private-rolled-back"),
        ).rejects.toThrow("Fixture transaction rolled back");
        expect(await store.execute({ type: "read", input: undefined })).toEqual([
          "synthetic-private-committed",
        ]);
      } finally {
        await store.close();
      }
    });
    expect(observations).toEqual([
      expect.objectContaining({
        operation: "worker",
        workerOperations: [
          "open",
          "session.actor.appendTranscriptEvent",
          "sessions",
          "execute",
          "close",
        ],
        transactionCount: 2,
      }),
    ]);
    const serialized = JSON.stringify(observations);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain(reservationOptions.path);
  } finally {
    diagnostics.unsubscribe(observe);
  }
});
