import type { EventEmitter } from "node:events";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { StateDatabaseCoordinatorRuntime } from "../infra/state-database-coordinator.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  leaseHeartbeatState as state,
  type LeaseHeartbeatRequest,
  type LeaseHeartbeatWorkerData,
} from "./openclaw-state-lease-heartbeat-shared.js";
import {
  startOpenClawStateLeaseHeartbeat,
  type LeaseHeartbeatCleanup,
} from "./openclaw-state-lease-heartbeat.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";

type ControlledWorker = EventEmitter & {
  data: LeaseHeartbeatWorkerData;
  shared: BigInt64Array;
  messages: (LeaseHeartbeatRequest | null)[];
  finishExit: () => void;
};

const controls = vi.hoisted(() => {
  const events: string[] = [];
  const handleRelease = vi.fn(() => {
    events.push("handle-release");
  });
  const coordinator = {
    closed: false,
    release: vi.fn(() => {
      coordinator.closed = true;
      events.push("coordinator-release");
    }),
  };
  return {
    events,
    workers: [] as ControlledWorker[],
    constructorError: undefined as Error | undefined,
    handleRelease,
    coordinator,
    acquireHandle: vi.fn(() => ({ release: handleRelease })),
    retainCoordinator: vi.fn(() => coordinator),
    withRuntime: vi.fn((_runtime: StateDatabaseCoordinatorRuntime, operation: () => unknown) =>
      operation(),
    ),
  };
});

vi.mock("../infra/state-database-coordinator.js", () => ({
  acquireStateDatabaseHandleLease: controls.acquireHandle,
  retainHeldStateDatabaseCoordinator: controls.retainCoordinator,
  withStateDatabaseCoordinatorRuntimeDirectory: controls.withRuntime,
}));

vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase() {
    throw new Error("native SQLite is outside this controlled test");
  },
}));

vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/heartbeat.worker.js"),
  resolveRuntimeWorkerArgv: () => ["/synthetic/heartbeat.worker.js"],
}));

// Error graph semantics have separate codec tests; keep this lifetime fixture JS-only.
vi.mock("./openclaw-state-worker-error.js", () => ({
  hydrateOpenClawStateWorkerError: (error: unknown) => error,
  retainOpenClawStateWorkerErrorPayload() {},
}));

vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter implements ControlledWorker {
      data: LeaseHeartbeatWorkerData;
      shared: BigInt64Array;
      messages: (LeaseHeartbeatRequest | null)[] = [];
      stdout = { resume() {} };
      stderr = { resume() {} };
      private termination = createDeferredCore<number>();

      constructor(_url: URL, workerOptions: { workerData: LeaseHeartbeatWorkerData }) {
        super();
        controls.events.push("construct");
        if (controls.constructorError) {
          throw controls.constructorError;
        }
        this.data = structuredClone(workerOptions.workerData);
        this.shared = new BigInt64Array(this.data.shared);
        controls.workers.push(this);
      }

      postMessage(message: LeaseHeartbeatRequest | null) {
        this.messages.push(message);
      }

      terminate() {
        controls.events.push("terminate");
        return this.termination.promise;
      }

      finishExit() {
        controls.events.push("exit");
        this.emit("exit", 0);
        this.termination.resolve(0);
      }
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  controls.events.length = 0;
  controls.workers.length = 0;
  controls.coordinator.closed = false;
  controls.constructorError = undefined;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function options() {
  const databasePath = "/synthetic/state.sqlite";
  const startupContext: OpenClawStateWorkerContext = {
    admission: {
      databasePath,
      identity: { key: "file:12:34", canonicalPath: databasePath },
      assertCurrent: () => {
        controls.events.push("admission");
      },
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
    coordinatorRuntime: { directory: "/synthetic/coordinators", keepAlive: false },
  };
  return {
    path: databasePath,
    identity: { scope: "core:test", key: "command", owner: "original-owner" },
    leaseMs: 60_000,
    heartbeatMs: 20_000,
    expiresAt: Date.now() + 60_000,
    onLost: vi.fn(),
    startupContext,
  };
}

function constructedWorker(expiresAt = Date.now() + 60_000) {
  const worker = controls.workers[0];
  assert(worker, "Expected a controlled heartbeat worker");
  Atomics.store(worker.shared, state.expiresAt, BigInt(expiresAt));
  Atomics.store(worker.shared, state.status, state.ready);
  worker.emit("message", null);
  return worker;
}

async function finish(
  heartbeat: ReturnType<typeof startOpenClawStateLeaseHeartbeat>,
  worker: ControlledWorker,
) {
  const stopped = heartbeat.stop();
  worker.finishExit();
  await stopped;
}

describe("state lease heartbeat lifetime", () => {
  it("finishes release-only handle custody without replaying a successful release", async () => {
    let cleanup: LeaseHeartbeatCleanup | undefined;
    const heartbeat = startOpenClawStateLeaseHeartbeat({
      ...options(),
      startupContext: undefined,
      retainCleanup(value) {
        cleanup = value;
      },
    });
    const worker = constructedWorker();
    await heartbeat.ready;
    assert(cleanup);
    expect(cleanup.pending).toBe(true);
    await finish(heartbeat, worker);
    expect(cleanup.pending).toBe(false);
    await cleanup.close();
    expect(controls.handleRelease).toHaveBeenCalledOnce();
    expect(controls.coordinator.release).toHaveBeenCalledOnce();
  });

  it("retries only failed disposal after preserving a constructor error", async () => {
    const startupError = new Error("controlled constructor failure");
    const releaseError = new Error("controlled release failure");
    controls.constructorError = startupError;
    controls.handleRelease.mockImplementationOnce(() => {
      throw releaseError;
    });
    let cleanup: LeaseHeartbeatCleanup | undefined;
    let observed: unknown;
    try {
      startOpenClawStateLeaseHeartbeat({
        ...options(),
        startupContext: undefined,
        retainCleanup(value) {
          cleanup = value;
        },
      });
    } catch (error) {
      observed = error;
    }
    expect(observed).toMatchObject({ cause: startupError, errors: [startupError, releaseError] });
    expect(vi.getTimerCount()).toBe(0);
    assert(cleanup);
    expect(cleanup.pending).toBe(true);
    expect(controls.coordinator.release).not.toHaveBeenCalled();
    await cleanup.close();
    expect(cleanup.pending).toBe(false);
    expect(controls.handleRelease).toHaveBeenCalledTimes(2);
    expect(controls.coordinator.release).toHaveBeenCalledOnce();
    expect(controls.events.filter((event) => event === "construct")).toHaveLength(1);
  });

  it("reports an unexpected exit cleanup error once and retains unfinished disposal", async () => {
    const params = options();
    let cleanup: LeaseHeartbeatCleanup | undefined;
    const heartbeat = startOpenClawStateLeaseHeartbeat({
      ...params,
      retainCleanup(value) {
        cleanup = value;
      },
    });
    const worker = constructedWorker();
    await heartbeat.ready;
    const releaseError = new Error("controlled exit release failure");
    controls.coordinator.release.mockImplementationOnce(() => {
      throw releaseError;
    });
    worker.finishExit();
    try {
      expect(params.onLost).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ cause: releaseError }),
      );
      assert(cleanup);
      expect(cleanup.pending).toBe(true);
    } finally {
      await heartbeat.stop();
    }
    expect(cleanup.pending).toBe(false);
    expect(controls.coordinator.release).toHaveBeenCalledTimes(2);
    expect(controls.events).not.toContain("terminate");
  });

  it("cancels an idle async lease at its worker-observed durable expiry", async () => {
    const params = options();
    const heartbeat = startOpenClawStateLeaseHeartbeat(params);
    const worker = constructedWorker(Date.now() + 100);
    try {
      await heartbeat.ready;
      await vi.advanceTimersByTimeAsync(99);
      expect(params.onLost).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(params.onLost).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "state lease heartbeat lease expired" }),
      );
      expect(() => heartbeat.assertRunning()).toThrow("not running");
    } finally {
      await finish(heartbeat, worker);
    }
  });

  it("observes renewal without a parent message before deciding expiry", async () => {
    const params = options();
    const heartbeat = startOpenClawStateLeaseHeartbeat(params);
    const worker = constructedWorker(Date.now() + 100);
    try {
      await heartbeat.ready;
      await vi.advanceTimersByTimeAsync(50);
      Atomics.store(worker.shared, state.expiresAt, BigInt(Date.now() + 200));
      await vi.advanceTimersByTimeAsync(199);
      expect(params.onLost).not.toHaveBeenCalled();
      heartbeat.assertRunning();
      await vi.advanceTimersByTimeAsync(1);
      expect(params.onLost).toHaveBeenCalledOnce();
    } finally {
      await finish(heartbeat, worker);
    }
  });

  it("reports worker-observed loss only once across timer and error delivery", async () => {
    const params = options();
    const heartbeat = startOpenClawStateLeaseHeartbeat(params);
    const worker = constructedWorker(Date.now() + 100);
    try {
      await heartbeat.ready;
      Atomics.store(worker.shared, state.expiresAt, BigInt(Date.now() + 60_000));
      Atomics.store(worker.shared, state.status, state.lost);
      await vi.advanceTimersByTimeAsync(100);
      expect(params.onLost).toHaveBeenCalledExactlyOnceWith(
        new Error("state lease heartbeat is not running"),
      );
      worker.emit("error", new Error("later error delivery"));
      expect(params.onLost).toHaveBeenCalledOnce();
    } finally {
      await finish(heartbeat, worker);
    }
  });

  it("bounds an unanswered command even when the worker keeps renewing", async () => {
    const params = options();
    const heartbeat = startOpenClawStateLeaseHeartbeat(params);
    const worker = constructedWorker();
    try {
      await heartbeat.ready;
      const outcomes: unknown[] = [];
      const result = heartbeat.verify().then(
        (value) => outcomes.push(value),
        (error: unknown) => outcomes.push(error),
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(500);
      Atomics.store(worker.shared, state.expiresAt, BigInt(Date.now() + 120_000));
      await vi.advanceTimersByTimeAsync(499);
      expect(outcomes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(outcomes).toEqual([new Error("state lease heartbeat is not responsive")]);
      await result;
      expect(params.onLost).toHaveBeenCalledOnce();
    } finally {
      await finish(heartbeat, worker);
    }
  });

  it("rejects a late successful reply before its delayed timeout callback", async () => {
    const heartbeat = startOpenClawStateLeaseHeartbeat(options());
    const worker = constructedWorker();
    try {
      await heartbeat.ready;
      const result = heartbeat.verify();
      const outcome = result.catch((error: unknown) => error);
      await Promise.resolve();
      const request = worker.messages[0];
      assert(request);
      vi.spyOn(performance, "now").mockReturnValue(1_001);
      worker.emit("message", { id: request.id, ok: true, expiresAt: Date.now() + 60_000 });
      expect(await outcome).toEqual(new Error("state lease heartbeat is not responsive"));
    } finally {
      await finish(heartbeat, worker);
    }
  });

  it("accepts a timely reply after shared renewal extends the initial expiry", async () => {
    const params = options();
    const heartbeat = startOpenClawStateLeaseHeartbeat(params);
    const worker = constructedWorker(Date.now() + 100);
    try {
      await heartbeat.ready;
      const result = heartbeat.renew();
      await Promise.resolve();
      const request = worker.messages[0];
      assert(request);
      await vi.advanceTimersByTimeAsync(50);
      const expiry = Date.now() + 500;
      Atomics.store(worker.shared, state.expiresAt, BigInt(expiry));
      await vi.advanceTimersByTimeAsync(100);
      expect(params.onLost).not.toHaveBeenCalled();
      worker.emit("message", { id: request.id, ok: true, expiresAt: expiry });
      await expect(result).resolves.toBe(expiry);
    } finally {
      await finish(heartbeat, worker);
    }
  });
});
