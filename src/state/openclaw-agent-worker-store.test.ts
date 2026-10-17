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
import { readSqliteDatabaseCleanClose as readCleanClose } from "../infra/sqlite-database-admission.js";
import { SQLITE_IDLE_HANDLE_TTL_MS } from "../infra/sqlite-handle-lifecycle.js";
import { observeSqliteWalPeriodicWork } from "../infra/sqlite-wal-scheduler.test-support.js";
import * as sqliteWal from "../infra/sqlite-wal.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../infra/sqlite-worker-owner-probe.test-support.js";
import {
  beginGatewayShutdownCleanup,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createDeferredCore } from "../shared/deferred.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  closeOpenClawAgentDatabasesAsync as closeDatabases,
  retainAgentDatabase,
} from "./openclaw-agent-db-lifecycle.js";
import {
  captureAgentDatabaseCloseFence,
  registerOpenClawAgentDatabaseAsyncResource,
  revokeAgentDatabaseResources,
} from "./openclaw-agent-db-resources.js";
import { withOpenClawAgentDatabaseWrite as withWrite } from "./openclaw-agent-db-write.js";
import {
  openOpenClawAgentDatabase as openDatabase,
  closeOpenClawAgentDatabasesForTest,
  withOpenClawAgentDatabaseAdmission as withDatabaseAdmission,
  withOpenClawAgentDatabaseAsync as withDatabaseAsync,
} from "./openclaw-agent-db.js";
import type { OpenClawAgentDatabaseExecution } from "./openclaw-agent-execution-contract.js";
import { captureOpenClawAgentDatabaseExecution as captureExecution } from "./openclaw-agent-execution.js";
import {
  openOpenClawAgentSqliteWorkerStore as openWorkerStore,
  type OpenClawAgentSqliteWorkerStore,
} from "./openclaw-agent-worker-store.js";
import { agentWorkerStoreFixtureEntrypoint } from "./openclaw-agent-worker-store.runtime.test-support.js";
import type {
  AgentWorkerFixtureOperations,
  bindSqliteWorkerBackend,
} from "./openclaw-agent-worker-store.test-support.js";
import { waitForFixtureEntry } from "./openclaw-agent-worker-store.wait.test-support.js";
import { retainOpenClawStateDatabaseForIdle } from "./openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "./openclaw-state-db.js";

const allow = () => {};

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
      await closeDatabases(root);
      closeOpenClawAgentDatabasesForTest();
    });
    await fixture.cleanup();
    cleanup();
  }),
);
const workers = new Set<OpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations>>();
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
function publish(
  worker: OpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations>,
  command: ReturnType<typeof append>,
) {
  return worker.run((scope) => scope.execute(command), allow);
}
function append(
  value: string,
  extra: Omit<AgentWorkerFixtureOperations["append"]["input"], "value"> = {},
) {
  return { type: "append" as const, input: { value, ...extra } };
}
function expectValues(db: Pick<DatabaseSync, "prepare">, ordered: boolean, ...values: string[]) {
  const order = ordered ? " ORDER BY rowid" : "";
  expect(db.prepare(`SELECT value FROM worker_proof${order}`).all()).toEqual(
    values.map((value) => ({ value })),
  );
}
function queryLeases(
  shared: ReturnType<typeof openOpenClawStateDatabase>,
  pathname = options.path,
  allColumns = false,
) {
  return shared.db
    .prepare(
      `SELECT ${allColumns ? "*" : "lease_id"} FROM agent_database_leases WHERE path = ? ORDER BY lease_id`,
    )
    .all(pathname);
}
async function openWorker(
  source: Parameters<typeof openWorkerStore>[1],
  input?: Parameters<typeof bindSqliteWorkerBackend>[0],
) {
  const worker = await openWorkerStore<AgentWorkerFixtureOperations>(options, source, {
    moduleUrl: resolveRuntimeWorkerUrl(agentWorkerStoreFixtureEntrypoint),
    input,
  });
  workers.add(worker);
  return worker;
}
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

it("retains an idle agent executor for thirty minutes and renews the window after reborrowing", async () => {
  const { db, worker } = await setup();
  const shared = openOpenClawStateDatabase();
  const releaseState = retainOpenClawStateDatabaseForIdle(shared);
  const leases = () => queryLeases(shared);
  const hostLeases = leases();
  const publishValue = (value: string) =>
    worker.run((scope) => scope.execute({ type: "append", input: { value } }), allow);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    await publishValue("first");
    const retainedLeases = leases();
    expect(retainedLeases).toHaveLength(hostLeases.length + 1);

    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    const borrowed = captureExecution(options);
    executions.add(borrowed);
    await publishValue("reborrowed");
    expect(leases()).toEqual(retainedLeases);
    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS);
    expect(leases()).toEqual(retainedLeases);
    await borrowed.release();
    executions.delete(borrowed);

    await vi.advanceTimersByTimeAsync(SQLITE_IDLE_HANDLE_TTL_MS - 1);
    expect(leases()).toEqual(retainedLeases);
    await vi.advanceTimersByTimeAsync(1);
    // A new request joins the expired generation's cleanup before reopening it.
    await publishValue("after idle");
    expect(leases()).toHaveLength(retainedLeases.length);
    expect(leases()).not.toEqual(retainedLeases);
    expectValues(db, true, "first", "reborrowed", "after idle");
  } finally {
    vi.useRealTimers();
    releaseState();
  }
});

it("retains a warm executor through a fallback wait between publication generations", async () => {
  const { db, worker } = await setup();
  const firstThread = await worker.execute(append("before preparation"), allow);
  const lifetime = captureExecution(options);
  executions.add(lifetime);
  await worker.close();
  const entered = createDeferredCore();
  const resume = createDeferredCore();
  let next: OpenClawAgentSqliteWorkerStore<AgentWorkerFixtureOperations> | undefined;
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
    expectValues(db, true, "before preparation", "after preparation");
    await next?.close();
    expect(db.isOpen).toBe(true);
    beginGatewayShutdownCleanup();
    await lifetime.release();
    expect(db.isOpen).toBe(false);
    expect(readCleanClose(options.path)).toBe(true);
  } finally {
    resume.resolve();
    await Promise.allSettled([publication]);
    await Promise.allSettled([next?.close(), lifetime.release(), worker.close()]);
    executions.delete(lifetime);
    resetGatewayWorkAdmission();
  }
});

it.each([false, true])(
  "releases settled publication leases at shutdown cleanup unless an accepted sequence retains them (%s)",
  async (retainGeneration) => {
    const { db, worker } = await setup();
    const execution = retainGeneration ? captureExecution(options) : undefined;
    if (execution) {
      executions.add(execution);
    }
    const shared = openOpenClawStateDatabase();
    const releaseState = retainOpenClawStateDatabaseForIdle(shared);
    const leases = () => queryLeases(shared);
    const hostLeases = leases();
    try {
      const firstThread = await worker.run(async (scope) => {
        const thread = await scope.execute(append("first"));
        markGatewayRestartDraining();
        return thread;
      }, allow);
      const retainedLeases = leases();
      const secondThread = await worker.execute(append("second"), allow);
      expect(secondThread).toBe(firstThread);
      expect(retainedLeases).toHaveLength(hostLeases.length + 1);
      expect(leases()).toEqual(retainedLeases);
      await publish(worker, append("third"));
      expect(leases()).toEqual(retainedLeases);
      beginGatewayShutdownCleanup();
      const cleanupThread = await worker.execute(append("cleanup"), allow);
      if (retainGeneration) {
        expect(cleanupThread).toBe(firstThread);
        expect(leases()).toEqual(retainedLeases);
      } else {
        expect(leases()).toEqual(hostLeases);
      }
      expectValues(db, true, "first", "second", "third", "cleanup");
      await worker.close();
      await execution?.release();
      expect(db.isOpen).toBe(false);
      expect(leases()).toEqual([]);
      expect(readCleanClose(options.path)).toBe(true);
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
      await closeDatabases(root);
      expect(prepare).not.toHaveBeenCalled();
      // Retirement may change lock policy, but must not run host-thread data SQL.
      expect(exec.mock.calls).toEqual([["PRAGMA busy_timeout = 0"]]);
      expect(readCleanClose(options.path)).toBe(!pinned);
      resetGatewayWorkAdmission();
      const reopened = openDatabase(options);
      expectValues(reopened.db, true, "worker commit", "after worker checkpoint");
    } finally {
      reader?.close();
      releaseHost();
      resetGatewayWorkAdmission();
    }
  },
);

it("records a clean sibling receipt while an admitted worker publication still owns its database", ({
  signal,
}) =>
  fixture.run(async () => {
    const { db, worker } = await setup();
    const heldPath = options.path;
    const healthy = openDatabase({
      agentId: "healthy",
      path: path.join(root, "healthy.sqlite"),
    });
    const shared = openOpenClawStateDatabase();
    const readLeases = (pathname: string) =>
      shared.db.prepare("SELECT lease_id FROM agent_database_leases WHERE path = ?").all(pathname);
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
      closing = closeDatabases(root).then(() => {
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
      expect(readCleanClose(healthy.path)).toBe(true);
      expect(db.isOpen).toBe(true);
      expect(readLeases(heldPath)).toHaveLength(2);
      expect(readCleanClose(heldPath)).toBe(false);
      expect(closed).toBe(false);
      expect(captureAgentDatabaseCloseFence(healthy)).toBeDefined();
      const later = { agentId: "late", path: path.join(root, "late.sqlite") };
      expect(() => openDatabase(later)).toThrow("resources are closing");
      await expect(withDatabaseAsync(later, (database) => database)).rejects.toThrow(
        "resources are closing",
      );
      await expect(
        withDatabaseAdmission(
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
      expect(readCleanClose(heldPath)).toBe(true);
      expect(captureAgentDatabaseCloseFence(healthy)).toBeUndefined();
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
          expectValues(db, false);
          fs.writeFileSync(preparation.codeGate, "release code loading");
          await waitForFixtureEntry(receipts, preparation.commandMarker, work, signal);
          expectValues(db, false);
          current = outcome === "success";
          fs.writeFileSync(preparation.commandGate, "release command preparation");
          if (outcome === "revoked") {
            await expect(work).rejects.toThrow("fixture authority revoked during preparation");
            expectValues(db, false);
            await publish(worker, append("retry"));
            expectValues(db, false, "retry");
          } else {
            expect(await work).toBeGreaterThan(0);
            expectValues(db, false, "prepared");
          }
        } finally {
          fs.writeFileSync(preparation.codeGate, "release for cleanup");
          fs.writeFileSync(preparation.commandGate, "release for cleanup");
          await work.catch(allow);
        }
      }),
  );

  it("keeps control reads responsive and admits sibling writes in FIFO order after native settlement", ({
    signal,
  }) =>
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
          withWrite(
            options,
            () => {
              observed.push(value);
              db.prepare("INSERT INTO worker_proof(value) VALUES (?)").run(value);
            },
            db,
          ),
        );
        expectValues(db, false);
        await nextTurn();
        expect(observed).toEqual([]);
        expect(await native).toBeGreaterThan(0);
        await Promise.all(writes);
        expect(ticks).toBeGreaterThan(5);
        expect(observed).toEqual(["first", "second"]);
        expectValues(db, true, "worker", "first", "second");
        expect(db.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
      } finally {
        clearInterval(timer);
        await native.catch(allow);
      }
    }));

  it("rolls back authority revoked before commit and keeps the owner reusable", ({ signal }) =>
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
      expectValues(db, false);
      await publish(worker, append("retry"));
      expectValues(db, false, "retry");
    }));

  it.for(["scope", "single"] as const)(
    "drains an accepted %s commit grant when close revokes later work",
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
        expectValues(db, false, "accepted");
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
    expectValues(db, true, "first", "following");
  });

  it("preserves a single-command result through native binding cleanup failure", async () => {
    const { db, worker } = await setup({ closeFailure: "fixture binding cleanup failed" });
    expect(await worker.execute(append("committed"), allow)).toBeGreaterThan(0);
    expectValues(db, false, "committed");
    const following = await openWorker(db);
    expect(await following.execute(append("follower"), allow)).toBeGreaterThan(0);
    expectValues(db, true, "committed", "follower");
  });

  it.each(["ordinary", "admission"] as const)(
    "preserves a single-command %s error after cleanup admission is refused",
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
      expectValues(db, false);
      interception.mockRestore();

      const following = await openWorker(db);
      expect(await following.execute(append("follower"), allow)).toBeGreaterThan(0);
      expectValues(db, false, "follower");
    },
  );

  it("does not grant a cleanup transaction after a single read", async () => {
    const { db, worker } = await setup({ closeWriteValue: "must not commit" });
    await expect(worker.execute({ type: "inspect", input: undefined }, allow)).resolves.toBe(0);
    expectValues(db, false);
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
        expectValues(db, false, "survived");
      }
    } finally {
      resume.resolve();
      await Promise.allSettled(held);
    }
  });

  it("preserves a committed result and admits a queued follower after cleanup admission is refused", async () => {
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
    const runFollower = () => publish(worker, append("second"));
    try {
      const result = await Promise.race([committed.promise, first]);
      expect(result).toBeGreaterThan(0);
      expectValues(db, false, "first");
      // Capture this borrower before the first writer starts cleanup.
      second = runFollower();
      void second.catch(allow);
      release.resolve();
      expect(await first).toBe(result);
      expect(refusals).toBe(1);
      interception.mockRestore();

      expect(await second).toBeGreaterThan(0);
      expectValues(db, true, "first", "second");
    } finally {
      release.resolve();
      await Promise.allSettled(second ? [first, second] : [first]);
      interception.mockRestore();
    }
  });

  it("retains exact canonical lease cleanup after failure and releases it on retry", async () => {
    const { db, worker } = await setup();
    const shared = openOpenClawStateDatabase();
    const leases = () => queryLeases(shared, options.path, true);
    const hostLeases = leases();
    expect(hostLeases).toHaveLength(1);
    await publish(worker, append("before cleanup"));
    const retainedLeases = leases();
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
      expect(leases()).toEqual(retainedLeases);
      await expect(worker.run(async () => 0, allow)).rejects.toThrow("closed");
      const open = () => openWorker(db);
      await expect(open()).rejects.toThrow("resources are closing");
      expect(leases()).toEqual(retainedLeases);
      leaseCleanupFault.disable();
      const retried = await Promise.allSettled(revokeAgentDatabaseResources(selection));
      expect(retried).not.toContainEqual(expect.objectContaining({ status: "rejected" }));
      expect(leases()).toEqual(hostLeases);
      const recovered = await open();
      await recovered.run((scope) => scope.execute(append("after cleanup")), allow);
      expectValues(db, true, "before cleanup", "after cleanup");
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
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Publication fixture and cleanup failed", {
        cause: failures[0],
      });
    }
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
      await withWrite(options, allow, db);
      expect(exec.mock.calls.some(([sql]) => sql.includes("incremental_vacuum"))).toBe(false);
      expect(before - freePages()).toBeGreaterThan(0);
      expect(before - freePages()).toBeLessThanOrEqual(512);
      expectValues(db, false, "published");
    }));
});
