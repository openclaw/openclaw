import { once, type EventEmitter } from "node:events";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  leaseHeartbeatState as state,
  type LeaseHeartbeatRequest,
  type LeaseHeartbeatParentMessage,
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
  messages: LeaseHeartbeatRequest[];
  finishExit: () => void;
  activation: ReturnType<typeof createDeferredCore<void>>;
  activationSeen: boolean;
};

const controls = vi.hoisted(() => ({
  constructions: 0,
  workers: [] as ControlledWorker[],
  constructorError: undefined as Error | undefined,
  processOwner: undefined as { assertCurrent(): void } | undefined,
  prepareAccess: vi.fn<() => Promise<() => void>>(),
}));

// This fixture controls transport lifetime independently of real filesystem ownership.
vi.mock("../infra/gateway-state-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/gateway-state-owner.js")>()),
  captureStateDatabaseAccess: async () => ({
    processOwner: controls.processOwner,
    prepareAccess: controls.prepareAccess,
  }),
}));

vi.mock("../infra/node-sqlite.js", () => ({
  openNodeSqliteDatabase() {
    throw new Error("native SQLite is outside this controlled test");
  },
}));

vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///synthetic/heartbeat.worker.js"),
  resolveRuntimeWorkerThreadExecArgv: () => [],
}));

// Error graph semantics have separate codec tests; keep this lifetime fixture JS-only.
vi.mock("./openclaw-state-worker-error.js", () => ({
  hydrateOpenClawStateWorkerError: (error: unknown) => error,
  retainOpenClawStateWorkerErrorPayload() {},
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const { EventEmitter } = await import("node:events");
  return {
    ...(await importOriginal<typeof import("node:worker_threads")>()),
    Worker: class extends EventEmitter implements ControlledWorker {
      data: LeaseHeartbeatWorkerData;
      shared: BigInt64Array;
      messages: LeaseHeartbeatRequest[] = [];
      activation = createDeferredCore();
      activationSeen = false;
      stdout = { resume() {} };
      stderr = { resume() {} };
      private termination = createDeferredCore<number>();

      constructor(_url: URL, workerOptions: { workerData: LeaseHeartbeatWorkerData }) {
        super();
        controls.constructions++;
        if (controls.constructorError) {
          throw controls.constructorError;
        }
        const { databaseAdmissionPort, ...data } = workerOptions.workerData;
        this.data = { ...structuredClone(data), databaseAdmissionPort };
        this.shared = new BigInt64Array(this.data.shared);
        controls.workers.push(this);
      }

      postMessage(message: LeaseHeartbeatParentMessage) {
        if ("startup" in message) {
          this.activationSeen = true;
          this.activation.resolve();
          return;
        }
        this.messages.push(message);
        this.emit("request");
      }

      terminate() {
        return this.termination.promise;
      }

      finishExit() {
        this.emit("exit", 0);
        this.termination.resolve(0);
      }
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  controls.constructions = 0;
  controls.workers.length = 0;
  controls.constructorError = undefined;
  controls.processOwner = undefined;
  controls.prepareAccess.mockResolvedValue(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

const startupRenewals: ReturnType<typeof createDeferredCore<number>>[] = [];

let activeHeartbeat: ReturnType<typeof startOpenClawStateLeaseHeartbeat> | undefined;

afterEach(async () => {
  for (const renewal of startupRenewals.splice(0)) {
    renewal.resolve(Date.now() + 1_000);
  }
  if (activeHeartbeat) {
    const stopped = activeHeartbeat.stop();
    controls.workers[0]!.finishExit();
    await stopped;
    activeHeartbeat = undefined;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function startupRenewal() {
  const renewal = createDeferredCore<number>();
  startupRenewals.push(renewal);
  return renewal;
}

function options() {
  const databasePath = "/synthetic/state.sqlite";
  const startupContext: OpenClawStateWorkerContext = {
    admission: {
      coordinationKey: "file:12:34",
      databasePath,
      identity: { key: "file:12:34", canonicalPath: databasePath },
      assertCurrent() {},
    },
    environment: { OPENCLAW_STATE_DIR: "/synthetic" },
  };
  return {
    path: databasePath,
    identity: { scope: "core:test", key: "command", owner: "original-owner" },
    leaseMs: 60_000,
    acquiredAt: Date.now(),
    heartbeatMs: 20_000,
    expiresAt: Date.now() + 60_000,
    onLost: vi.fn(),
    startupContext,
  };
}

function start(params: Parameters<typeof startOpenClawStateLeaseHeartbeat>[0] = options()) {
  return (activeHeartbeat = startOpenClawStateLeaseHeartbeat(params));
}

async function readyHeartbeat(
  expiresAt = Date.now() + 60_000,
  overrides: Partial<ReturnType<typeof options>> = {},
) {
  const params = { ...options(), ...overrides };
  const heartbeat = start(params);
  const worker = await constructedWorker(expiresAt);
  await heartbeat.ready;
  return { params, heartbeat, worker };
}

async function constructedWorker(expiresAt = Date.now() + 60_000) {
  const worker = controls.workers[0];
  assert(worker, "Expected a controlled heartbeat worker");
  if (worker.data.deferActivation && !worker.activationSeen) {
    worker.emit("message", { startup: "prepared" });
    await worker.activation.promise;
  }
  Atomics.store(worker.shared, state.expiresAt, BigInt(expiresAt));
  Atomics.store(worker.shared, state.status, state.ready);
  worker.emit("message", null);
  return worker;
}

async function request(worker: ControlledWorker, index = 0) {
  while (!worker.messages[index]) {
    await once(worker, "request");
  }
  const value = worker.messages[index];
  assert(value);
  return value;
}

function expectMessage(error: unknown, ...parts: string[]) {
  assert(error instanceof Error);
  for (const part of parts) {
    expect(error.message).toContain(part);
  }
}

describe("state lease heartbeat lifetime", () => {
  it.each(["failure", "uncertain"] as const)(
    "preserves heartbeat handoff after late startup renewal %s",
    async (settlement) => {
      const params = options();
      const observation = new BigInt64Array(
        new SharedArrayBuffer((state.ownerFence + 1) * BigInt64Array.BYTES_PER_ELEMENT),
      );
      const renewal = startupRenewal();
      const renew = vi.fn(() => renewal.promise);
      const heartbeat = start({
        ...params,
        leaseMs: 1_000,
        heartbeatMs: 250,
        expiresAt: Date.now() + 1_000,
        expiryObservation: observation,
        renewDuringStartup: renew,
      });
      const worker = controls.workers[0];
      assert(worker);
      await vi.advanceTimersByTimeAsync(250);
      expect(renew).toHaveBeenCalledOnce();
      Atomics.store(observation, state.expiresAt, BigInt(Date.now() + 1_000));
      await vi.advanceTimersByTimeAsync(751);
      expect(params.onLost).not.toHaveBeenCalled();
      worker.emit("message", { startup: "prepared" });
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.activationSeen).toBe(false);
      const failure =
        settlement === "uncertain"
          ? new AggregateError([
              Object.assign(new Error("Unknown startup renewal"), { code: "outcome-unknown" }),
            ])
          : new Error("Known startup renewal contention");
      renewal.reject(failure);
      await expect(renewal.promise).rejects.toBe(failure);
      await vi.advanceTimersByTimeAsync(0);
      if (settlement === "uncertain") {
        await expect(heartbeat.ready).rejects.toBeInstanceOf(AggregateError);
        expect(params.onLost).toHaveBeenCalledOnce();
        expect(worker.activationSeen).toBe(false);
        expect(Atomics.load(observation, state.status)).toBe(state.lost);
      } else {
        expect(worker.activationSeen).toBe(true);
        vi.setSystemTime(Date.now() - 900);
        const readyExpiry = Date.now() + 1_000;
        await constructedWorker(readyExpiry);
        await heartbeat.ready;
        expect(params.onLost).not.toHaveBeenCalled();
        expect(Atomics.load(observation, state.status)).toBe(state.ready);
        expect(Number(Atomics.load(observation, state.expiresAt))).toBe(readyExpiry);
      }
      expect(renew).toHaveBeenCalledOnce();
    },
  );

  it("joins pending startup renewal before settling heartbeat cleanup", async () => {
    const renewal = startupRenewal();
    let cleanup: LeaseHeartbeatCleanup | undefined;
    const heartbeat = start({
      ...options(),
      heartbeatMs: 250,
      renewDuringStartup: () => renewal.promise,
      retainCleanup: (owner) => {
        cleanup = owner;
      },
    });
    const worker = controls.workers[0];
    assert(worker);
    await vi.advanceTimersByTimeAsync(250);
    let settled = false;
    const stopped = heartbeat.stop().then((code) => {
      settled = true;
      return code;
    });
    worker.finishExit();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(cleanup?.pending).toBe(true);
    renewal.resolve(Date.now() + 1_000);
    await stopped;
    activeHeartbeat = undefined;
    expect(cleanup?.pending).toBe(false);
  });

  it("closes startup custody after a constructor failure without replay", async () => {
    const startupError = new Error("controlled constructor failure");
    controls.constructorError = startupError;
    let cleanup: LeaseHeartbeatCleanup | undefined;
    expect(() =>
      startOpenClawStateLeaseHeartbeat({
        ...options(),
        retainCleanup(value) {
          cleanup = value;
        },
      }),
    ).toThrow(startupError);
    expect(vi.getTimerCount()).toBe(0);
    assert(cleanup);
    expect(cleanup.pending).toBe(false);
    await cleanup.close();
    expect(controls.constructions).toBe(1);
  });

  it("expires an idle lease after shared renewal", async () => {
    const { params, heartbeat, worker } = await readyHeartbeat(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(50);
    Atomics.store(worker.shared, state.expiresAt, BigInt(Date.now() + 200));
    await vi.advanceTimersByTimeAsync(199);
    expect(params.onLost).not.toHaveBeenCalled();
    heartbeat.assertRunning();
    await vi.advanceTimersByTimeAsync(1);
    expect(params.onLost).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "state lease heartbeat lease expired" }),
    );
    expect(() => heartbeat.assertRunning()).toThrow("not running");
  });

  it("reports worker-observed loss only once across timer and error delivery", async () => {
    const { params, worker } = await readyHeartbeat(Date.now() + 100);
    Atomics.store(worker.shared, state.expiresAt, BigInt(Date.now() + 60_000));
    Atomics.store(worker.shared, state.status, state.lost);
    await vi.advanceTimersByTimeAsync(100);
    expect(params.onLost).toHaveBeenCalledExactlyOnceWith(
      new Error("state lease heartbeat is not running"),
    );
    worker.emit("error", new Error("later error delivery"));
    expect(params.onLost).toHaveBeenCalledOnce();
  });

  it("preserves raw worker errors with received loss diagnostics", async () => {
    const params = options();
    const heartbeat = start(params);
    const outcome = heartbeat.ready.catch((error: unknown) => error);
    const worker = controls.workers[0];
    assert(worker);
    const cause = new Error("synthetic storage failure");
    const error = Object.assign(new Error("worker activation failed", { cause }), {
      code: "ERR_SQLITE_ERROR",
      errcode: 266,
    });
    Atomics.store(worker.shared, state.status, state.lost);
    worker.emit("message", { loss: { path: "activation", outcome: "operation-error" } });
    expect(params.onLost).not.toHaveBeenCalled();
    worker.emit("error", error);
    worker.finishExit();
    expect(params.onLost).toHaveBeenCalledExactlyOnceWith(error);
    expect(await outcome).toBe(error);
    expect(error).toMatchObject({
      message: "worker activation failed (lossPath=activation, lossOutcome=operation-error)",
      code: "ERR_SQLITE_ERROR",
      errcode: 266,
    });
    expect(error.cause).toBe(cause);
  });

  it.each(["late", "renewed"] as const)("checks the deadline of a %s reply", async (ending) => {
    const { params, heartbeat, worker } = await readyHeartbeat(
      Date.now() + (ending === "late" ? 60_000 : 100),
    );
    const result = ending === "late" ? heartbeat.verify() : heartbeat.renew();
    const outcome = result.catch((error: unknown) => error);
    const reply = await request(worker);
    let expiry = Date.now() + 60_000;
    if (ending === "late") {
      vi.spyOn(performance, "now").mockReturnValue(60_001);
    } else {
      await vi.advanceTimersByTimeAsync(50);
      expiry = Date.now() + 500;
      Atomics.store(worker.shared, state.expiresAt, BigInt(expiry));
      await vi.advanceTimersByTimeAsync(100);
      expect(params.onLost).not.toHaveBeenCalled();
    }
    worker.emit("message", { id: reply.id, ok: true, expiresAt: expiry });
    if (ending === "late") {
      expect(await outcome).toMatchObject({
        message: expect.stringContaining(
          "phase=verify, trigger=reply, requestId=1, elapsedMs=60001, operationRemainingMs=-1",
        ),
      });
    } else {
      await expect(result).resolves.toBe(expiry);
    }
  });

  it.each(["reply-first", "deadline-first", "expired", "lost", "lost-before-request"] as const)(
    "validates verify after %s delivery",
    async (delivery) => {
      const { params, heartbeat, worker } = await readyHeartbeat();
      if (delivery === "lost-before-request") {
        Atomics.store(worker.shared, state.status, state.lost);
      }
      const outcome = heartbeat.verify().catch((error: unknown) => error);
      if (delivery === "lost-before-request") {
        const result = await outcome;
        expect(result).toMatchObject({
          message: "state lease heartbeat is not running",
          code: "OPENCLAW_STATE_LEASE_LOST",
        });
        expect(params.onLost).toHaveBeenCalledExactlyOnceWith(result);
        expect(worker.messages).toEqual([]);
        return;
      }
      const reply = await request(worker);
      let expiresAt = Number(Atomics.load(worker.shared, state.expiresAt));
      if (delivery === "deadline-first") {
        await vi.advanceTimersByTimeAsync(1_500);
      } else {
        vi.spyOn(performance, "now").mockReturnValue(1_500);
        vi.setSystemTime(Date.now() + 1_500);
      }
      if (delivery === "lost") {
        Atomics.store(worker.shared, state.status, state.lost);
        expiresAt = Date.now() + 60_000;
      } else if (delivery === "expired") {
        expiresAt = Date.now() - 1;
      }
      worker.emit("message", { id: reply.id, ok: true, expiresAt });
      const result = await outcome;
      if (delivery === "lost") {
        assert(result instanceof Error);
        expect(result).toMatchObject({
          message: "state lease heartbeat is not running",
          code: "OPENCLAW_STATE_LEASE_LOST",
        });
        expect(params.onLost).toHaveBeenCalledExactlyOnceWith(result);
      } else if (delivery === "expired") {
        expectMessage(
          result,
          "phase=verify, trigger=reply, requestId=1",
          "status=1",
          "returnedLeaseRemainingMs=-1",
        );
      } else {
        expect(result).toBe(expiresAt);
        expect(params.onLost).not.toHaveBeenCalled();
      }
    },
  );

  it("matches concurrent verification replies to their requests", async () => {
    const { params, heartbeat, worker } = await readyHeartbeat();
    const first = heartbeat.verify();
    const second = heartbeat.verify();
    await request(worker, 1);
    const firstRequest = worker.messages[0];
    const secondRequest = worker.messages[1];
    assert(firstRequest && secondRequest);
    const firstExpiry = Date.now() + 20_000;
    const secondExpiry = Date.now() + 30_000;
    worker.emit("message", { id: secondRequest.id, ok: true, expiresAt: secondExpiry });
    await expect(second).resolves.toBe(secondExpiry);
    worker.emit("message", { id: firstRequest.id, ok: true, expiresAt: firstExpiry });
    await expect(first).resolves.toBe(firstExpiry);
    expect(params.onLost).not.toHaveBeenCalled();
  });

  it.each(["reply", "ownership preparation"])(
    "bounds delayed %s even when its lease renews",
    async (delayed) => {
      const preparation = createDeferredCore<() => void>();
      if (delayed === "ownership preparation") {
        controls.processOwner = { assertCurrent() {} };
        controls.prepareAccess.mockReturnValue(preparation.promise);
      }
      const leaseMs = 3_000;
      const { params, heartbeat, worker } = await readyHeartbeat(Date.now() + leaseMs, {
        leaseMs,
        expiresAt: Date.now() + leaseMs,
      });
      const outcome = heartbeat.verify().catch((error: unknown) => error);
      if (delayed === "reply") {
        await request(worker);
      }
      await vi.advanceTimersByTimeAsync(1_500);
      expect(params.onLost).not.toHaveBeenCalled();
      Atomics.store(worker.shared, state.expiresAt, BigInt(Date.now() + leaseMs));
      await vi.advanceTimersByTimeAsync(1_500);
      expectMessage(
        await outcome,
        "phase=verify, trigger=deadline, requestId=1, elapsedMs=3000",
        "operationRemainingMs=0, leaseRemainingMs=1500",
        "status=1",
      );
      expect(params.onLost).toHaveBeenCalledOnce();
      preparation.resolve(() => {});
      await vi.advanceTimersByTimeAsync(0);
      if (delayed === "ownership preparation") {
        expect(controls.prepareAccess).toHaveBeenCalledOnce();
        expect(worker.messages).toEqual([]);
      }
    },
  );
});
