/// <reference lib="es2024.sharedmemory" />

import { writeFileSync } from "node:fs";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { MessagePort, Worker, WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import { hasPersistedOpenClawAgentCanonicalValidation } from "../../state/openclaw-agent-canonical-validation-receipt.js";
import { assertNoOpenClawAgentDatabaseLeasesReadOnly } from "../../state/openclaw-agent-db-lease.js";
import * as lifecycle from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  hasOpenClawAgentCanonicalValidation,
  invalidateOpenClawAgentDatabaseValidation,
} from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { ensureSessionEntrySync } from "./session-accessor.sqlite-initial-entry.js";
import { hasPendingCanonicalSessionValidation } from "./session-canonical-validation.js";
import { runSessionStartupMigration } from "./startup-migration.js";

type TaskObservation = { worker: Worker; port: MessagePort; agentId: string };
const observer = vi.hoisted(() => ({
  workers: new Set<Worker>(),
  parents: new WeakMap<MessagePort, MessagePort>(),
  onTask: undefined as ((task: TaskObservation) => void) | undefined,
  beforeCreate: undefined as
    | ((filename: string | URL, options: WorkerOptions) => WorkerOptions)
    | undefined,
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
        super(
          filename,
          canonical ? (observer.beforeCreate?.(filename, options) ?? options) : options,
        );
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

function seedFleet(env: NodeJS.ProcessEnv, invalidFirst = false) {
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
  // Ordinary fixture writes have no durable canonical receipt; clear process-local proof.
  closeOpenClawAgentDatabasesForTest(env.OPENCLAW_STATE_DIR);
  return { agentIds, cfg };
}

function gateFirstCertificationPerTask() {
  type HeldRequest = { agentId: string; release: () => void };
  const tasks: Array<{
    worker: Worker;
    agentId: string;
    closed: boolean;
    exited: Deferred;
  }> = [];
  const held: HeldRequest[] = [];
  const heldReleases: HeldRequest[] = [];
  let bypass = false;
  let requestHeld = createDeferredCore();
  const notifyHeld = () => {
    requestHeld.resolve();
    requestHeld = createDeferredCore();
  };
  observer.onTask = ({ worker, port, agentId }) => {
    const observed: (typeof tasks)[number] = {
      worker,
      agentId,
      closed: false,
      exited: createDeferredCore(),
    };
    tasks.push(observed);
    worker.once("exit", () => {
      observed.exited.resolve();
    });
    port.on("message", (message: { type: string; settled?: boolean }) => {
      if (message.type === "closed") {
        observed.closed = message.settled === true;
      }
    });
    const postMessage = port.postMessage.bind(port);
    let gated = false;
    port.postMessage = (message: unknown, transferList) => {
      const options = Array.isArray(transferList) ? { transfer: transferList } : transferList;
      if (
        !bypass &&
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "release"
      ) {
        const release: HeldRequest = {
          agentId,
          release: () => {
            const index = heldReleases.indexOf(release);
            if (index !== -1) {
              heldReleases.splice(index, 1);
              postMessage(message, options);
            }
          },
        };
        heldReleases.push(release);
        notifyHeld();
        return;
      }
      if (
        gated ||
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "canonical-validation"
      ) {
        postMessage(message, options);
        return;
      }
      if (
        !("databaseOptions" in message) ||
        typeof message.databaseOptions !== "object" ||
        message.databaseOptions === null ||
        !("agentId" in message.databaseOptions) ||
        typeof message.databaseOptions.agentId !== "string"
      ) {
        throw new Error("Canonical validation request omitted its agent owner");
      }
      gated = true;
      expect(message.databaseOptions.agentId).toBe(agentId);
      if (bypass) {
        postMessage(message, options);
        return;
      }
      const request: HeldRequest = {
        agentId: observed.agentId,
        release: () => {
          const index = held.indexOf(request);
          if (index !== -1) {
            held.splice(index, 1);
            postMessage(message, options);
          }
        },
      };
      held.push(request);
      notifyHeld();
    };
  };
  return {
    held,
    heldReleases,
    tasks,
    waitFor: async (
      kind: "certification" | "release",
      count: number,
      startup: Promise<unknown>,
    ) => {
      const requests = kind === "certification" ? held : heldReleases;
      while (requests.length < count) {
        await Promise.race([
          requestHeld.promise,
          startup.then((result) => {
            throw result instanceof Error
              ? result
              : new Error(`Startup settled before ${count} ${kind} requests were held`);
          }),
        ]);
      }
    },
    releaseAll: () => {
      bypass = true;
      while (held.length > 0) {
        held[0]!.release();
      }
      while (heldReleases.length > 0) {
        heldReleases[0]!.release();
      }
    },
  };
}

it("reuses two workers while closing each database task before downstream maintenance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env);
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
    const maintenanceWaves = [createDeferredCore(), createDeferredCore()];
    const log = { info: vi.fn(), warn: vi.fn() };
    const startup = runSessionStartupMigration({
      cfg,
      env: state.env,
      log,
      deps: {
        migrateManagedWorktreeCanonicalWorkspaces: async ({ agentId, mode }) => {
          expect(mode).toBe("detect");
          const task = gate.tasks.find((entry) => entry.agentId === agentId);
          expect(task?.closed).toBe(true);
          expect(
            openOpenClawStateDatabase({ env: state.env })
              .db.prepare("SELECT lease_id FROM agent_database_leases WHERE agent_id = ?")
              .all(agentId),
          ).toEqual([]);
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
          const wave = maintenanceWaves[Math.floor(index / 2)];
          if (wave) {
            if (index % 2 === 1) {
              wave.resolve();
            }
            await wave.promise;
          }
          await yieldToEventLoop();
          return { found: 1, repaired: 0 };
        },
      },
    });
    void startup.catch(() => {});
    try {
      let admitted = 0;
      for (const [waveIndex, waveSize] of [2, 2, 1].entries()) {
        await gate.waitFor("certification", waveSize, startup);
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
        while (gate.held.length > 0) {
          gate.held[0]!.release();
        }
        await gate.waitFor("release", waveSize, startup);
        expect(gate.heldReleases).toHaveLength(waveSize);
        // Even a closed database cannot free the task until its parent releases the close owner.
        expect(gate.tasks).toHaveLength(admitted);
        expect(consumed).toHaveLength(admitted - waveSize);
        while (gate.heldReleases.length > 0) {
          gate.heldReleases[0]!.release();
        }
        const maintenanceWave = maintenanceWaves[waveIndex];
        if (maintenanceWave) {
          await Promise.race([maintenanceWave.promise, startup]);
        }
      }
      await startup;
      expect(observer.workers.size).toBe(2);
      expect(new Set(gate.tasks.map(({ agentId }) => agentId))).toEqual(new Set(agentIds));
      expect(consumed.toSorted()).toEqual(agentIds);
      expect(log.warn).toHaveBeenCalledExactlyOnceWith(
        "session: 5 managed-worktree session(s) need canonical workspace repair; run openclaw doctor --fix",
      );
      expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } finally {
      for (const wave of maintenanceWaves) {
        wave.resolve();
      }
      gate.releaseAll();
      await startup.catch(() => {});
    }
  });
});

it("reuses durable fleet receipts and recertifies only the store revoked by its parent", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env);
    const admitted: string[] = [];
    observer.onTask = ({ agentId }) => admitted.push(agentId);
    const startup = () =>
      runSessionStartupMigration({
        cfg,
        env: state.env,
        log: { info: vi.fn(), warn: vi.fn() },
        deps: {
          migrateManagedWorktreeCanonicalWorkspaces: async () => ({ found: 0, repaired: 0 }),
        },
      });

    await startup();
    expect(admitted.toSorted()).toEqual(agentIds);
    expect(observer.workers.size).toBe(2);
    for (const agentId of agentIds) {
      expect(
        withOpenClawAgentDatabaseReadOnly(hasPersistedOpenClawAgentCanonicalValidation, {
          agentId,
          env: state.env,
        }),
      ).toMatchObject({ found: true, value: true });
    }

    closeOpenClawAgentDatabasesForTest(state.env.OPENCLAW_STATE_DIR);
    await startup();
    expect(admitted).toHaveLength(5);
    expect(observer.workers.size).toBe(2);

    const revokedAgentId = agentIds[0]!;
    expect(
      withOpenClawAgentDatabaseReadOnly(
        (database) => {
          invalidateOpenClawAgentDatabaseValidation(database.path);
          return hasOpenClawAgentCanonicalValidation(database);
        },
        { agentId: revokedAgentId, env: state.env },
      ),
    ).toMatchObject({ found: true, value: false });
    await startup();
    expect(admitted.slice(5)).toEqual([revokedAgentId]);
    expect(observer.workers.size).toBe(3);
    expect(
      withOpenClawAgentDatabaseReadOnly(hasOpenClawAgentCanonicalValidation, {
        agentId: revokedAgentId,
        env: state.env,
      }),
    ).toMatchObject({ found: true, value: true });
    expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
    expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
  });
});

it("stops fleet admission on refusal and drains an already-started sibling before startup rejects", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env, true);
    const gate = gateFirstCertificationPerTask();
    const consumed: string[] = [];
    let settled = false;
    const startup = runSessionStartupMigration({
      cfg,
      env: state.env,
      log: { info: vi.fn(), warn: vi.fn() },
      deps: {
        migrateManagedWorktreeCanonicalWorkspaces: async ({ agentId, mode }) => {
          expect(mode).toBe("detect");
          consumed.push(agentId);
          return { found: 0, repaired: 0 };
        },
      },
    });
    const outcome = startup.then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await gate.waitFor("certification", 2, outcome);
      expect(gate.held).toHaveLength(2);
      const first = gate.held.find(({ agentId }) => agentId === agentIds[0]);
      const failedWorker = gate.tasks.find(({ agentId }) => agentId === agentIds[0]);
      expect(first).toBeDefined();
      expect(failedWorker).toBeDefined();
      first!.release();
      await failedWorker!.exited.promise;
      await yieldToEventLoop();
      expect(settled).toBe(false);
      expect(gate.tasks).toHaveLength(2);
      expect(gate.held.map(({ agentId }) => agentId)).toEqual([agentIds[1]]);
      expect(consumed).toEqual([]);

      gate.releaseAll();
      expect(await outcome).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("invalid persisted session row"),
        }),
      );
      expect(gate.tasks).toHaveLength(2);
      expect(consumed).toEqual([agentIds[1]]);
      expect([...observer.workers].every((worker) => worker.threadId === -1)).toBe(true);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } finally {
      gate.releaseAll();
      await outcome;
    }
  });
});

it("holds writer admission when a refused task's first native retirement fails", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env);
    const agentId = agentIds[0]!;
    const gate = gateFirstCertificationPerTask();
    const observeTask = observer.onTask;
    let revoked = false;
    observer.onTask = (task) => {
      observeTask?.(task);
      task.port.on("message", (message: { type: string }) => {
        if (message.type === "commit-request") {
          revoked = true;
        }
      });
    };
    let settled = false;
    const outcome = runSessionStartupMigration({
      cfg,
      env: state.env,
      agentIds: new Set([agentId]),
      log: { info: vi.fn(), warn: vi.fn() },
      assertCurrent: () => {
        if (revoked) {
          throw new Error("synthetic startup authority was revoked");
        }
      },
    }).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    const retryEntered = createDeferredCore();
    const releaseRetry = createDeferredCore();
    let following: Promise<unknown> | undefined;
    try {
      await gate.waitFor("certification", 1, outcome);
      expect(gate.held).toHaveLength(1);
      const worker = gate.tasks[0]!.worker;
      const terminate = worker.terminate.bind(worker);
      const retirement = vi
        .spyOn(worker, "terminate")
        .mockRejectedValueOnce(new Error("synthetic native retirement failed"))
        .mockImplementationOnce(async () => {
          retryEntered.resolve();
          await releaseRetry.promise;
          return terminate();
        });
      gate.releaseAll();
      await retryEntered.promise;
      let followed = false;
      following = runOpenClawAgentWriteAdmission({ agentId, env: state.env }, () => {
        followed = true;
      });
      await yieldToEventLoop();
      expect(revoked).toBe(true);
      expect(settled).toBe(false);
      expect(followed).toBe(false);
      expect(worker.threadId).toBeGreaterThan(0);
      releaseRetry.resolve();
      expect(await outcome).toEqual(
        expect.objectContaining({
          message: expect.stringContaining("synthetic startup authority was revoked"),
        }),
      );
      await following;
      expect(followed).toBe(true);
      expect(worker.threadId).toBe(-1);
      expect(retirement).toHaveBeenCalledTimes(2);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } finally {
      gate.releaseAll();
      releaseRetry.resolve();
      await Promise.allSettled([outcome, following]);
    }
  });
});

it.each(["active", "pre-ready"] as const)(
  "retries native retirement from a later close after %s startup failure",
  async (phase) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { agentIds, cfg } = seedFleet(state.env);
      const agentId = agentIds[0]!;
      const gate = gateFirstCertificationPerTask();
      const resources: Parameters<
        typeof lifecycle.registerOpenClawAgentDatabaseAsyncResource
      >[0][] = [];
      const register = lifecycle.registerOpenClawAgentDatabaseAsyncResource;
      vi.spyOn(lifecycle, "registerOpenClawAgentDatabaseAsyncResource").mockImplementation(
        (resource) => {
          if (resource.agentId === agentId) {
            resources.push(resource);
          }
          return register(resource);
        },
      );
      const proactiveFailed = createDeferredCore();
      const releaseRetirement = createDeferredCore();
      let laterRetryEntered = false;
      let terminateNative: (() => Promise<number>) | undefined;
      let retirementCalls: (() => number) | undefined;
      let earlyClose: Promise<unknown> | undefined;
      let earlyCloseSettled = false;
      let laterClose: Promise<unknown> | undefined;
      let following: Promise<unknown> | undefined;
      const startEarlyClose = () => {
        earlyClose = Promise.allSettled(resources.map((resource) => resource.close())).then(() => {
          earlyCloseSettled = true;
        });
      };
      const observeTask = observer.onTask;
      observer.onTask = (task) => {
        observeTask?.(task);
        const terminate = task.worker.terminate.bind(task.worker);
        terminateNative = terminate;
        const retirement = vi
          .spyOn(task.worker, "terminate")
          .mockRejectedValueOnce(new Error("synthetic first native retirement failed"))
          .mockImplementationOnce(async () => {
            proactiveFailed.resolve();
            throw new Error("synthetic proactive retirement failed");
          })
          .mockImplementationOnce(async () => {
            laterRetryEntered = true;
            await releaseRetirement.promise;
            return terminate();
          });
        retirementCalls = () => retirement.mock.calls.length;
        if (phase === "pre-ready") {
          startEarlyClose();
          throw new Error("synthetic dispatch failure before worker readiness");
        }
      };
      let settled = false;
      const outcome = runSessionStartupMigration({
        cfg,
        env: state.env,
        agentIds: new Set([agentId]),
        log: { info: vi.fn(), warn: vi.fn() },
      }).then(
        () => {
          settled = true;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      try {
        if (phase === "active") {
          await gate.waitFor("certification", 1, outcome);
          expect(gate.held).toHaveLength(1);
          startEarlyClose();
          gate.releaseAll();
        }
        await proactiveFailed.promise;
        await yieldToEventLoop();
        const worker = gate.tasks[0]!.worker;
        expect(resources.length).toBeGreaterThan(0);
        let followed = false;
        if (phase === "active") {
          following = runOpenClawAgentWriteAdmission({ agentId, env: state.env }, () => {
            followed = true;
          });
        }
        laterClose = Promise.allSettled(resources.map((resource) => resource.close()));
        await vi.waitFor(() => expect(laterRetryEntered).toBe(true));
        expect(settled).toBe(false);
        expect(earlyCloseSettled).toBe(false);
        expect(followed).toBe(false);
        expect(worker.threadId).toBeGreaterThan(0);
        releaseRetirement.resolve();
        expect(await outcome).toBeInstanceOf(Error);
        await Promise.all([earlyClose, laterClose, following]);
        expect(earlyCloseSettled).toBe(true);
        expect(followed).toBe(phase === "active");
        expect(worker.threadId).toBe(-1);
        expect(retirementCalls?.()).toBe(3);
        expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
      } finally {
        gate.releaseAll();
        releaseRetirement.resolve();
        await terminateNative?.();
        await Promise.allSettled([outcome, earlyClose, laterClose, following]);
      }
    });
  },
);

it("retains the idle pool's cleanup owner until shared-state retirement joins native exit", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env);
    const sharedPath = openOpenClawStateDatabase({ env: state.env }).path;
    const primaryFailure = new Error("synthetic idle pool retirement failed");
    const retryFailures = [new Error("first recovery failed"), new Error("second recovery failed")];
    let worker: Worker | undefined;
    let terminateNative: (() => Promise<number>) | undefined;
    let retirementCalls: (() => number) | undefined;
    observer.onTask = (task) => {
      worker = task.worker;
      terminateNative = task.worker.terminate.bind(task.worker);
      const retirement = vi.spyOn(task.worker, "terminate").mockRejectedValueOnce(primaryFailure);
      for (const failure of retryFailures) {
        retirement.mockRejectedValueOnce(failure);
      }
      retirementCalls = () => retirement.mock.calls.length;
    };
    try {
      await expect(
        runSessionStartupMigration({
          cfg,
          env: state.env,
          agentIds: new Set([agentIds[0]!]),
          log: { info: vi.fn(), warn: vi.fn() },
        }),
      ).rejects.toBe(primaryFailure);
      expect(worker?.threadId).toBeGreaterThan(0);
      expect(retirementCalls?.()).toBe(1);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
      for (const latestFailure of retryFailures) {
        const failure = await closeOpenClawStateDatabaseByPathAsync(sharedPath).catch(
          (error: unknown) => error,
        );
        if (!(failure instanceof AggregateError)) {
          throw new Error("Expected primary and latest retirement failures", { cause: failure });
        }
        expect(failure.errors).toHaveLength(2);
        expect(failure.errors[0]).toBe(primaryFailure);
        expect(failure.errors[1]).toBe(latestFailure);
        expect(failure.cause).toBe(latestFailure);
        expect(worker?.threadId).toBeGreaterThan(0);
      }
      await closeOpenClawStateDatabaseByPathAsync(sharedPath);
      expect(worker?.threadId).toBe(-1);
      expect(retirementCalls?.()).toBe(4);
    } finally {
      await terminateNative?.();
    }
  });
});

it("retries failed native retirement while shared-state drainage already owns the close", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env);
    const sharedPath = openOpenClawStateDatabase({ env: state.env }).path;
    const releaseRetirement = createDeferredCore();
    let retryEntered = false;
    let worker: Worker | undefined;
    let terminateNative: (() => Promise<number>) | undefined;
    let retirementCalls: (() => number) | undefined;
    let drainage: Promise<boolean> | undefined;
    let drainageOutcome: Promise<unknown> | undefined;
    let drained = false;
    observer.onTask = (task) => {
      worker = task.worker;
      const terminate = task.worker.terminate.bind(task.worker);
      terminateNative = terminate;
      const retirement = vi
        .spyOn(task.worker, "terminate")
        .mockRejectedValueOnce(new Error("synthetic overlapping retirement failed"))
        .mockImplementationOnce(async () => {
          retryEntered = true;
          await releaseRetirement.promise;
          return terminate();
        });
      retirementCalls = () => retirement.mock.calls.length;
      drainage = closeOpenClawStateDatabaseByPathAsync(sharedPath);
      drainageOutcome = drainage
        .catch((error: unknown) => error)
        .finally(() => {
          drained = true;
        });
      throw new Error("synthetic dispatch failure during shared-state drainage");
    };
    let settled = false;
    const outcome = runSessionStartupMigration({
      cfg,
      env: state.env,
      agentIds: new Set([agentIds[0]!]),
      log: { info: vi.fn(), warn: vi.fn() },
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await vi.waitFor(() => expect(retryEntered).toBe(true));
      expect(settled).toBe(false);
      expect(drained).toBe(false);
      expect(worker?.threadId).toBeGreaterThan(0);
      expect(closeOpenClawStateDatabaseByPathAsync(sharedPath)).toBe(drainage);
      releaseRetirement.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      expect(await drainageOutcome).toBe(true);
      expect(worker?.threadId).toBe(-1);
      expect(retirementCalls?.()).toBe(2);
      await closeOpenClawStateDatabaseByPathAsync(sharedPath);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } finally {
      releaseRetirement.resolve();
      await terminateNative?.();
      await Promise.allSettled([outcome, drainageOutcome]);
      await closeOpenClawStateDatabaseByPathAsync(sharedPath);
    }
  });
});

it("drains the database owner before terminating a worker whose lease receipt is pending", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { agentIds, cfg } = seedFleet(state.env);
    const agentId = agentIds[0]!;
    const shared = openOpenClawStateDatabase({ env: state.env });
    const gate = new Int32Array(new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT));
    const preload = state.path("lease-receipt-gate.cjs");
    writeFileSync(
      preload,
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
    observer.beforeCreate = (_filename, options) => ({
      ...options,
      execArgv: [...(options.execArgv ?? []), "--require", preload],
      workerData: { ...options.workerData, fixtureLeaseGate: gate.buffer },
    });
    const leaseReceived = createDeferredCore();
    const allowTermination = createDeferredCore();
    let worker: Worker | undefined;
    let terminateNative: (() => Promise<number>) | undefined;
    let terminationCalls = 0;
    observer.onTask = (task) => {
      worker = task.worker;
      const terminate = task.worker.terminate.bind(task.worker);
      terminateNative = terminate;
      vi.spyOn(task.worker, "terminate").mockImplementation(async () => {
        terminationCalls += 1;
        await allowTermination.promise;
        return terminate();
      });
      task.port.on("message", (message: { type: string }) => {
        if (message.type === "lease") {
          leaseReceived.resolve();
        }
      });
    };
    let settled = false;
    const outcome = runSessionStartupMigration({
      cfg,
      env: state.env,
      agentIds: new Set([agentId]),
      log: { info: vi.fn(), warn: vi.fn() },
    })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    let drainage: Promise<unknown> | undefined;
    let drained = false;
    const releaseLeaseReceipt = () => {
      Atomics.store(gate, 1, 1);
      Atomics.notify(gate, 1);
    };
    try {
      await Promise.race([
        Promise.resolve(Atomics.waitAsync(gate, 0, 0).value),
        outcome.then((result) => {
          throw result instanceof Error
            ? result
            : new Error("Startup completed before the worker reached its lease receipt");
        }),
      ]);
      expect(Atomics.load(gate, 0)).toBe(1);
      expect(
        shared.db
          .prepare("SELECT lease_id FROM agent_database_leases WHERE agent_id = ?")
          .all(agentId),
      ).toHaveLength(1);
      drainage = closeOpenClawStateDatabaseByPathAsync(shared.path)
        .catch((error: unknown) => error)
        .finally(() => {
          drained = true;
        });
      await yieldToEventLoop();
      expect(terminationCalls).toBe(0);
      expect(worker?.threadId).toBeGreaterThan(0);
      expect(settled).toBe(false);
      expect(drained).toBe(false);
      releaseLeaseReceipt();
      await leaseReceived.promise;
      allowTermination.resolve();
      expect(await outcome).toBeInstanceOf(Error);
      expect(await drainage).toBe(true);
      expect(worker?.threadId).toBe(-1);
      expect(() => assertNoOpenClawAgentDatabaseLeasesReadOnly({ env: state.env })).not.toThrow();
    } finally {
      releaseLeaseReceipt();
      Atomics.notify(gate, 0);
      if (Atomics.load(gate, 0) === 1) {
        await leaseReceived.promise;
      }
      allowTermination.resolve();
      await terminateNative?.();
      await Promise.allSettled([outcome, drainage]);
      await closeOpenClawStateDatabaseByPathAsync(shared.path);
    }
  });
});
