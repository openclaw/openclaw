/// <reference lib="es2024.sharedmemory" />

import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { MessagePort, Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it, vi, type MockInstance } from "vitest";
import { revokeSqliteDatabaseAdmissionsForPath } from "../../infra/sqlite-database-admission.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { hasPersistedOpenClawAgentCanonicalValidation } from "../../state/openclaw-agent-canonical-validation-receipt.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../../state/openclaw-agent-db-lease.js";
import * as lifecycle from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { hasOpenClawAgentCanonicalValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";
import { runSessionStartupMigration } from "./startup-migration.js";

type TaskObservation = { worker: Worker; port: MessagePort; agentId: string };
const observer = vi.hoisted(() => ({
  workers: new Set<Worker>(),
  parents: new WeakMap<MessagePort, MessagePort>(),
  onTask: undefined as ((task: TaskObservation) => void) | undefined,
  beforeCreate: undefined as ((options: WorkerOptions) => WorkerOptions) | undefined,
}));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    MessageChannel: class extends actual.MessageChannel {
      constructor() {
        super();
        observer.parents.set(this.port2, this.port1);
      }
    },
    Worker: class extends actual.Worker {
      constructor(filename: string | URL, options: WorkerOptions = {}) {
        const canonical = options.workerData?.operation === "canonical-validation-pool";
        super(filename, canonical ? (observer.beforeCreate?.(options) ?? options) : options);
        if (!canonical) {
          return;
        }
        observer.workers.add(this);
        const post = this.postMessage.bind(this);
        this.postMessage = (message, transferList) => {
          const task = message as {
            input: { databaseOptions: { agentId: string }; port: MessagePort };
          };
          const port = observer.parents.get(task.input.port);
          if (port) {
            observer.onTask?.({ worker: this, port, agentId: task.input.databaseOptions.agentId });
          }
          post(message, transferList);
        };
      }
    },
  };
});
afterEach(async () => {
  observer.onTask = undefined;
  observer.beforeCreate = undefined;
  vi.restoreAllMocks();
  await Promise.all([...observer.workers].map((worker) => worker.terminate()));
  observer.workers.clear();
});

function seedFleet(state: OpenClawTestState, invalidFirst = false) {
  const { env } = state;
  const agentIds = Array.from({ length: 5 }, (_, index) => `fleet-${index}`);
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      defaults: { sessionStore: { agentId: agentIds[0] } },
      entries: Object.fromEntries(agentIds.map((agentId) => [agentId, {}])),
    },
  };
  for (const [index, agentId] of agentIds.entries()) {
    for (let session = 0; session < (index === 0 ? 129 : 1); session += 1) {
      ensureSessionEntrySync(
        { agentId, env, sessionKey: `agent:${agentId}:retained-${session}` },
        { sessionId: `${agentId}-retained-${session}`, updatedAt: 1 },
      );
    }
    if (index === 0 && invalidFirst) {
      openOpenClawAgentDatabase({ agentId, env })
        .db.prepare("UPDATE session_nodes SET parent_session_key = ?")
        .run(`agent:${agentId}:changed`);
    }
    expect(
      hasPersistedOpenClawAgentCanonicalValidation(openOpenClawAgentDatabase({ agentId, env })),
    ).toBe(false);
  }
  // Exercise cold certification rather than reusing clean-close admission.
  closeOpenClawAgentDatabasesForTest(env.OPENCLAW_STATE_DIR);
  for (const agentId of agentIds) {
    revokeSqliteDatabaseAdmissionsForPath(resolveOpenClawAgentSqlitePath({ agentId, env }));
  }
  const log = { info: vi.fn(), warn: vi.fn() };
  const shared = openOpenClawStateDatabase({ env });
  type Startup = Parameters<typeof runSessionStartupMigration>[0];
  return {
    ...state,
    agentIds,
    cfg,
    log,
    shared,
    leases: (agentId: string) =>
      shared.db
        .prepare("SELECT lease_id FROM agent_database_leases WHERE agent_id = ?")
        .all(agentId),
    start: (ids?: string[], handoffDatabase?: Startup["handoffDatabase"]) =>
      runSessionStartupMigration({ cfg, env, log, agentIds: ids && new Set(ids), handoffDatabase }),
    closeShared: () => closeOpenClawStateDatabaseByPathAsync(shared.path),
    assertNoLeases: () =>
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env })).not.toThrow(),
  };
}

type Fleet = ReturnType<typeof seedFleet>;
function withFleet(run: (fleet: Fleet) => Promise<void>, invalidFirst = false) {
  return withOpenClawTestState({ scenario: "minimal" }, (state) =>
    run(seedFleet(state, invalidFirst)),
  );
}

function observeRetirement(
  configure: (
    mock: MockInstance<Worker["terminate"]>,
    terminate: Worker["terminate"],
    task: TaskObservation,
  ) => void,
) {
  const retirement: {
    worker?: Worker;
    mock?: MockInstance<Worker["terminate"]>;
    terminate?: Worker["terminate"];
  } = {};
  observer.onTask = (task) => {
    retirement.worker = task.worker;
    retirement.terminate = task.worker.terminate.bind(task.worker);
    retirement.mock = vi.spyOn(task.worker, "terminate");
    configure(retirement.mock, retirement.terminate, task);
  };
  return retirement;
}

function observeOutcome(promise: Promise<unknown>) {
  const result = { settled: false, outcome: promise.catch((error: unknown) => error) };
  result.outcome = result.outcome.finally(() => {
    result.settled = true;
  });
  return result;
}

function rejectIfSettled(startup: Promise<unknown>, message: string) {
  return startup.then((result) => {
    throw result instanceof Error ? result : new Error(message);
  });
}

type HeldRequest = { agentId: string; release: () => void };
type ObservedTask = { agentId: string; exited: Deferred };
function releaseHeld(requests: HeldRequest[]) {
  while (requests.length > 0) {
    requests[0]!.release();
  }
}

function gateFirstCertificationPerTask() {
  const tasks: ObservedTask[] = [];
  const held: HeldRequest[] = [];
  let bypass = false;
  let requestHeld = createDeferredCore();
  const hold = (requests: HeldRequest[], agentId: string, post: () => void) => {
    const request = {
      agentId,
      release: () => {
        const index = requests.indexOf(request);
        if (index !== -1) {
          requests.splice(index, 1);
          post();
        }
      },
    };
    requests.push(request);
    requestHeld.resolve();
    requestHeld = createDeferredCore();
  };
  observer.onTask = ({ worker, port, agentId }) => {
    const observed = { agentId, exited: createDeferredCore() };
    tasks.push(observed);
    worker.once("exit", () => {
      observed.exited.resolve();
    });
    const postMessage = port.postMessage.bind(port);
    let gated = false;
    port.postMessage = (message: unknown, transferList) => {
      const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
      const post = () => postMessage(message, options);
      if (typeof message !== "object" || message === null || !("type" in message)) {
        post();
        return;
      }
      if (gated || message.type !== "canonical-validation") {
        post();
        return;
      }
      expect(message).toMatchObject({ databaseOptions: { agentId } });
      gated = true;
      if (bypass) {
        post();
        return;
      }
      hold(held, agentId, post);
    };
  };
  return {
    held,
    tasks,
    waitFor: async (count: number, startup: Promise<unknown>) => {
      while (held.length < count) {
        await Promise.race([
          requestHeld.promise,
          rejectIfSettled(
            startup,
            `Startup settled before ${count} certification requests were held`,
          ),
        ]);
      }
    },
    releaseAll: () => {
      bypass = true;
      releaseHeld(held);
    },
  };
}

it("reuses two workers while closing each database task before runtime handoff", () =>
  withFleet(async (state) => {
    const { agentIds, start } = state;
    const gate = gateFirstCertificationPerTask();
    const resources: Parameters<typeof lifecycle.registerOpenClawAgentDatabaseAsyncResource>[0][] =
      [];
    const register = lifecycle.registerOpenClawAgentDatabaseAsyncResource;
    vi.spyOn(lifecycle, "registerOpenClawAgentDatabaseAsyncResource").mockImplementation(
      (resource) => {
        if (resource.agentId === agentIds[0]) {
          resources.push(resource);
        }
        return register(resource);
      },
    );
    const consumed: string[] = [];
    const handoffWaves = [createDeferredCore(), createDeferredCore()];
    const startup = start(undefined, async ({ agentId }) => {
      expect(state.leases(agentId)).toEqual([]);
      const proof = withOpenClawAgentDatabaseReadOnly(
        (database) => ({
          ready: hasOpenClawAgentCanonicalValidation(database),
          pending: hasPendingCanonicalSessionValidation(database),
          rows: database.db.prepare("SELECT COUNT(*) AS count FROM session_nodes").get()?.count,
        }),
        { agentId, env: state.env },
      );
      expect(proof).toMatchObject({
        found: true,
        value: { ready: true, pending: false, rows: agentId === agentIds[0] ? 129 : 1 },
      });
      const index = consumed.push(agentId) - 1;
      const wave = handoffWaves[Math.floor(index / 2)];
      if (index % 2 === 1) {
        wave?.resolve();
      }
      if (wave) {
        await wave.promise;
      }
      await yieldToEventLoop();
    });
    void startup.catch(() => {});
    try {
      let admitted = 0;
      for (const [waveIndex, waveSize] of [2, 2, 1].entries()) {
        await gate.waitFor(waveSize, startup);
        expect(gate.held).toHaveLength(waveSize);
        admitted += waveSize;
        expect(gate.tasks).toHaveLength(admitted);
        expect(observer.workers.size).toBe(2);
        if (waveIndex === 1) {
          expect(resources.length).toBeGreaterThan(0);
          for (const resource of resources) {
            resource.revoke();
            await resource.close();
          }
          expect([...observer.workers].every((worker) => worker.threadId > 0)).toBe(true);
          expect(gate.held).toHaveLength(waveSize);
        }
        releaseHeld(gate.held);
        const handoffWave = handoffWaves[waveIndex];
        if (handoffWave) {
          await Promise.race([handoffWave.promise, startup]);
        }
      }
      await startup;
      expect(observer.workers.size).toBe(2);
      expect(new Set(gate.tasks.map(({ agentId }) => agentId))).toEqual(new Set(agentIds));
      expect(consumed.toSorted()).toEqual(agentIds);
      expect(state.log.warn).not.toHaveBeenCalled();
      expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
      state.assertNoLeases();
    } finally {
      handoffWaves.forEach((wave) => wave.resolve());
      gate.releaseAll();
      await startup.catch(() => {});
    }
  }));

it("drains sibling startup work and the worker pool before closing cold database handles", () =>
  withFleet(async (state) => {
    const { agentIds, start } = state;
    state.cfg.session = { mainKey: "primary" };
    const startupAgents = agentIds.slice(0, 3);
    const gate = gateFirstCertificationPerTask();
    const closeDatabase = lifecycle.closeOpenClawAgentDatabaseByPathAsync;
    const coldCloses: [string, boolean][] = [];
    vi.spyOn(lifecycle, "closeOpenClawAgentDatabaseByPathAsync").mockImplementation((...args) => {
      coldCloses.push([args[0], [...observer.workers].every((worker) => worker.threadId === -1)]);
      return closeDatabase(...args);
    });
    const startup = start(startupAgents);
    void startup.catch(() => {});
    try {
      await gate.waitFor(2, startup);
      gate.held.find(({ agentId }) => agentId === startupAgents[0])!.release();
      // The third task starts only after the first completes; its sibling is still held.
      await gate.waitFor(2, startup);
      expect(gate.tasks).toHaveLength(3);
      expect(coldCloses).toEqual([]);

      gate.releaseAll();
      await startup;
      expect(coldCloses.toSorted(([a], [b]) => a.localeCompare(b))).toEqual(
        startupAgents
          .toSorted()
          .map((agentId) => [resolveOpenClawAgentSqlitePath({ agentId, env: state.env }), true]),
      );
      state.assertNoLeases();
    } finally {
      gate.releaseAll();
      await startup.catch(() => {});
    }
  }));

it("stops fleet admission on refusal and drains an already-started sibling before startup rejects", () =>
  withFleet(async (state) => {
    const { agentIds, start } = state;
    const gate = gateFirstCertificationPerTask();
    const closeDatabase = lifecycle.closeOpenClawAgentDatabaseByPathAsync;
    const close = vi
      .spyOn(lifecycle, "closeOpenClawAgentDatabaseByPathAsync")
      .mockImplementation((...args) => {
        expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
        return closeDatabase(...args);
      });
    const consumed: string[] = [];
    const startup = start(undefined, async ({ agentId }) => {
      consumed.push(agentId);
    });
    const observation = observeOutcome(startup);
    const { outcome } = observation;
    try {
      await gate.waitFor(2, outcome);
      expect(gate.held).toHaveLength(2);
      const first = gate.held.find(({ agentId }) => agentId === agentIds[0]);
      const failedWorker = gate.tasks.find(({ agentId }) => agentId === agentIds[0]);
      first!.release();
      await failedWorker!.exited.promise;
      await yieldToEventLoop();
      expect(observation.settled).toBe(false);
      expect(gate.tasks).toHaveLength(2);
      expect(gate.held.map(({ agentId }) => agentId)).toEqual([agentIds[1]]);
      expect(consumed).toEqual([]);
      expect(close).not.toHaveBeenCalled();

      gate.releaseAll();
      expect(await outcome).toMatchObject({
        message: expect.stringContaining("invalid persisted session row"),
      });
      expect(gate.tasks).toHaveLength(2);
      expect(consumed).toEqual([agentIds[1]]);
      expect(close).toHaveBeenCalledOnce();
      expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
      state.assertNoLeases();
    } finally {
      gate.releaseAll();
      await outcome;
    }
  }, true));

it("retains the idle pool's cleanup owner until shared-state retirement joins native exit", () =>
  withFleet(async (state) => {
    const { agentIds, start } = state;
    const previousExitHooks = new Set(process.rawListeners("beforeExit"));
    const primaryFailure = new Error("synthetic idle pool retirement failed");
    const retryFailures = [new Error("first recovery failed"), new Error("second recovery failed")];
    const retirement = observeRetirement((mock) => {
      mock.mockRejectedValueOnce(primaryFailure);
      for (const failure of retryFailures) {
        mock.mockRejectedValueOnce(failure);
      }
    });
    try {
      await expect(start(agentIds.slice(0, 1))).rejects.toBe(primaryFailure);
      expect(retirement.worker?.threadId).toBeGreaterThan(0);
      expect(retirement.mock?.mock.calls.length).toBe(1);
      state.assertNoLeases();
      const exitHooks = () =>
        process.rawListeners("beforeExit").filter((hook) => !previousExitHooks.has(hook));
      expect(exitHooks()).toHaveLength(1);
      const emitBeforeExit = () => exitHooks().forEach((hook) => hook.call(process, 0));
      emitBeforeExit();
      await yieldToEventLoop();
      expect(retirement.mock?.mock.calls.length).toBe(2);
      emitBeforeExit();
      await yieldToEventLoop();
      expect(retirement.mock?.mock.calls.length).toBe(2);
      expect(retirement.worker?.threadId).toBeGreaterThan(0);
      expect(await state.closeShared().catch((error: unknown) => error)).toBe(retryFailures[1]);
      expect(retirement.worker?.threadId).toBeGreaterThan(0);
      await state.closeShared();
      expect([retirement.worker?.threadId, retirement.mock?.mock.calls.length]).toEqual([-1, 4]);
    } finally {
      await retirement.terminate?.();
    }
  }));

it("retries failed native retirement while shared-state drainage already owns the close", () =>
  withFleet(async (state) => {
    const { agentIds, start } = state;
    const releaseRetirement = createDeferredCore();
    const retryEntered = createDeferredCore();
    let drainage: Promise<boolean> | undefined;
    let drainageOutcome: ReturnType<typeof observeOutcome> | undefined;
    const retirement = observeRetirement((mock, terminate) => {
      mock
        .mockRejectedValueOnce(new Error("synthetic overlapping retirement failed"))
        .mockImplementationOnce(async () => {
          retryEntered.resolve();
          await releaseRetirement.promise;
          return terminate();
        });
      drainage = state.closeShared();
      drainageOutcome = observeOutcome(drainage);
      throw new Error("synthetic dispatch failure during shared-state drainage");
    });
    const observation = observeOutcome(start(agentIds.slice(0, 1)));
    const { outcome } = observation;
    try {
      await Promise.race([
        retryEntered.promise,
        rejectIfSettled(outcome, "Startup settled before native retirement retry began"),
      ]);
      expect([observation.settled, drainageOutcome?.settled]).toEqual([false, false]);
      expect(retirement.worker?.threadId).toBeGreaterThan(0);
      expect(state.closeShared()).toBe(drainage);
      releaseRetirement.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      expect(await drainageOutcome?.outcome).toBe(true);
      expect([retirement.worker?.threadId, retirement.mock?.mock.calls.length]).toEqual([-1, 2]);
      await state.closeShared();
      state.assertNoLeases();
    } finally {
      releaseRetirement.resolve();
      await retirement.terminate?.();
      await Promise.allSettled([outcome, drainageOutcome?.outcome]);
      await state.closeShared();
    }
  }));

it("drains the database owner before terminating a worker whose lease receipt is pending", () =>
  withFleet(async (state) => {
    const { agentIds, start } = state;
    const agentId = agentIds[0]!;
    const gate = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    const preload = await state.writeText(
      "lease-receipt-gate.cjs",
      `
      const { MessagePort, workerData } = require('node:worker_threads');
      const gate = new Int32Array(workerData.fixtureLeaseGate);
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message, ...args) {
        if (message?.type === 'lease' && Atomics.compareExchange(gate, 0, 0, 1) === 0) {
          Atomics.notify(gate, 0);
          Atomics.wait(gate, 1, 0);
        }
        return Reflect.apply(post, this, [message, ...args]);
      };
    `,
    );
    observer.beforeCreate = (options) => ({
      ...options,
      execArgv: [...(options.execArgv ?? []), "--require", preload],
      workerData: { ...options.workerData, fixtureLeaseGate: gate.buffer },
    });
    const leaseReceived = createDeferredCore();
    const allowTermination = createDeferredCore();
    const retirement = observeRetirement((mock, terminate, task) => {
      mock.mockImplementation(async () => {
        await allowTermination.promise;
        return terminate();
      });
      task.port.on("message", (message: { type: string }) => {
        if (message.type === "lease") {
          leaseReceived.resolve();
        }
      });
    });
    const observation = observeOutcome(start([agentId]));
    const { outcome } = observation;
    let drainage: ReturnType<typeof observeOutcome> | undefined;
    const releaseLeaseReceipt = () => {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
    };
    try {
      await Promise.race([
        Promise.resolve(Atomics.waitAsync(gate, 0, 0).value),
        rejectIfSettled(outcome, "Startup completed before the worker reached its lease receipt"),
      ]);
      expect(Atomics.load(gate, 0)).toBe(1);
      expect(state.leases(agentId)).toHaveLength(1);
      drainage = observeOutcome(state.closeShared());
      await yieldToEventLoop();
      expect(retirement.mock?.mock.calls.length).toBe(0);
      expect(retirement.worker?.threadId).toBeGreaterThan(0);
      expect([observation.settled, drainage.settled]).toEqual([false, false]);
      releaseLeaseReceipt();
      await leaseReceived.promise;
      allowTermination.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      expect(await drainage.outcome).toBe(true);
      expect(retirement.worker?.threadId).toBe(-1);
      state.assertNoLeases();
    } finally {
      releaseLeaseReceipt();
      Atomics.notify(gate, 0);
      if (Atomics.load(gate, 0) === 1) {
        await leaseReceived.promise;
      }
      allowTermination.resolve();
      await retirement.terminate?.();
      await Promise.allSettled([outcome, drainage?.outcome]);
      await state.closeShared();
    }
  }));
