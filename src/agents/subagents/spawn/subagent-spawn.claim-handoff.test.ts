import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import type { SubagentRegistrationScope } from "../registry/subagent-registry.types.js";
import {
  createSubagentRegistrationScopeForTest,
  createSubagentSpawnTestConfig,
  loadSubagentSpawnModuleForTest,
} from "./subagent-spawn.test-helpers.js";

const callGateway = vi.fn();
const registerRun = vi.fn();
const resolveEngine = vi.fn();
const startQueuedRun = vi.fn();
let spawn: typeof import("./subagent-spawn.js").spawnSubagentDirect;
let collector: typeof import("./subagent-spawn-collector.js");
let scheduler: typeof import("../swarm/swarm-scheduler.js");
let schedulerTesting: (typeof import("../swarm/swarm-scheduler.test-support.js"))["testing"];
let admission: typeof import("../../../process/gateway-work-admission.js");

beforeAll(async () => {
  ({ spawnSubagentDirect: spawn } = await loadSubagentSpawnModuleForTest({
    callGatewayMock: callGateway,
    registerSubagentRunMock: registerRun,
    resolveContextEngineMock: resolveEngine,
    startQueuedSubagentRunMock: startQueuedRun,
    getRuntimeConfig: () =>
      createSubagentSpawnTestConfig(undefined, {
        tools: { swarm: { enabled: true, maxConcurrent: 1 } },
      }),
  }));
  collector = await import("./subagent-spawn-collector.js");
  ({ testing: schedulerTesting } = await import("../swarm/swarm-scheduler.test-support.js"));
  scheduler = await import("../swarm/swarm-scheduler.js");
  admission = await import("../../../process/gateway-work-admission.js");
});

beforeEach(() => {
  schedulerTesting.reset();
  registerRun.mockReset();
  startQueuedRun.mockReset().mockReturnValue(true);
  resolveEngine.mockReset();
  callGateway
    .mockReset()
    .mockImplementation(
      async (request: { method?: string; params?: { idempotencyKey?: string } }) =>
        request.method === "agent"
          ? { runId: request.params?.idempotencyKey, status: "accepted" }
          : { ok: true },
    );
});

afterEach(() => schedulerTesting.reset());

function expectCalls(count: number, ...mocks: { mock: { calls: readonly unknown[] } }[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

function observe(promise: Promise<unknown>) {
  const completed = vi.fn();
  return { completed, settled: promise.then(completed, completed) };
}

const spawnCollector = (task: string) =>
  spawn(
    { task, collect: true },
    { agentSessionKey: "agent:main:main", requesterRunId: "parent-run" },
  );

function claimFixture() {
  const gate = createDeferred();
  let claimed = true;
  const settle = vi.fn(async () => {});
  const rollback = vi.fn(async () => {});
  const dispose = vi.fn(async () => {});
  const scope = {
    ...createSubagentRegistrationScopeForTest({
      canLaunch: () => !claimed,
      settleFailedLaunch: settle,
      waitForClaim: () => (claimed ? gate.promise : undefined),
    }),
  };
  return {
    scope,
    settle,
    rollback,
    dispose,
    release: () => {
      claimed = false;
      gate.resolve();
    },
  };
}

function callbackFixture(f: ReturnType<typeof claimFixture>, failure?: Error) {
  const launch = vi.fn(async () => ({ response: { runId: "original", status: "accepted" } }));
  if (failure) {
    launch.mockRejectedValue(failure);
  }
  const cleanup = vi.fn(async () => ({ attachmentsRemoved: true, sessionDeleted: true }));
  const callbacks = collector.createCollectorLaunchCallbacks({
    childRunId: "original",
    childSessionKey: "agent:main:subagent:original",
    requesterSessionKey: "agent:main:main",
    registrationScope: f.scope,
    preparation: { rollback: f.rollback, dispose: f.dispose },
    provisionalSessionIdentity: {},
    launchChildRun: launch,
    recordParticipant: vi.fn(),
    emitSpawnLifecycleHooks: async () => {},
    cleanupFailedSpawn: cleanup,
  });
  return { launch, cleanup, callbacks };
}

function registerOwnedEngine(f: ReturnType<typeof claimFixture>, registered = () => {}) {
  registerRun.mockImplementation(
    async (
      _record: unknown,
      options: { retainOwnership: (scope: SubagentRegistrationScope) => void },
    ) => {
      options.retainOwnership(f.scope);
      registered();
    },
  );
  resolveEngine.mockResolvedValue({
    prepareSubagentSpawn: async () => ({ rollback: f.rollback }),
    dispose: f.dispose,
  });
}

async function nextTurn() {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

it("keeps one collector launch pending through reversible Gateway suspension", async () => {
  const f = claimFixture();
  f.release();
  const suspension = admission.tryBeginGatewaySuspendAdmission(() => {});
  if (!suspension) {
    throw new Error("Expected a fresh suspension admission");
  }
  expect(suspension.commit()).toBe(true);
  const { launch, cleanup, callbacks } = callbackFixture(f);
  const first = admission.runOutsideGatewayRootWorkAdmission(() => callbacks.start());
  const observed = observe(first);
  try {
    await nextTurn();
    expect(observed.completed).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
    expect(suspension.release()).toBe(true);
    await first;
    expectCalls(1, launch, startQueuedRun, f.dispose);
    expectCalls(0, f.rollback, f.settle, cleanup);
  } finally {
    suspension.rollback();
    suspension.release();
    await observed.settled;
  }
});

it.each([false, true])(
  "closes a claim-free failure scope with dispatchAttempted=%s",
  async (attempted) => {
    const f = claimFixture();
    f.release();
    const failure = new Error("transport refused");
    const { launch, cleanup, callbacks } = callbackFixture(f, failure);
    if (attempted) {
      await expect(callbacks.start()).rejects.toBe(failure);
    }
    const work = new AsyncWorkScope();
    work.beginClose();
    try {
      expect(await work.track(() => callbacks.onStartFailure(failure))).toBe(attempted);
      expectCalls(Number(attempted), f.settle, cleanup, f.rollback, launch);
    } finally {
      await work.drain();
    }
  },
);

it("settles a stopped activation through its retained scope before retiring the slot", async () => {
  const f = claimFixture();
  f.release();
  f.scope.canLaunch = () => false;
  let retired = false;
  f.scope.canCleanupSession = () => !retired;
  const settled = createDeferred();
  f.settle.mockImplementation(async () => {
    await settled.promise;
    retired = true;
  });
  registerOwnedEngine(f);
  const result = await spawnCollector("superseded original collector");
  try {
    expect(result.status).toBe("accepted");
    await vi.waitFor(() => expect(f.settle).toHaveBeenCalledOnce());
    expect(scheduler.isSwarmRunActive(result.runId!)).toBe(true);
    expect(f.rollback).not.toHaveBeenCalled();
    expect(
      callGateway.mock.calls.some(
        ([request]) => request.method === "agent" || request.method === "sessions.delete",
      ),
    ).toBe(false);
    settled.resolve();
    await vi.waitFor(() => expect(scheduler.isSwarmRunActive(result.runId!)).toBe(false));
    expect(f.settle).toHaveBeenCalledOnce();
    expect(f.rollback).not.toHaveBeenCalled();
  } finally {
    settled.resolve();
  }
});

it.each(["activation", "failure cleanup"])(
  "retains %s through a provisional claim",
  async (phase) => {
    const f = claimFixture();
    const registered = createDeferred();
    registerOwnedEngine(f, () => registered.resolve());
    const { launch, cleanup, callbacks } = callbackFixture(f);
    const activating = phase === "activation";
    const pending = activating
      ? spawnCollector("preserve prepared collector")
      : Promise.resolve(callbacks.onStartFailure(new Error("launch refused")));
    const observed = observe(pending);
    try {
      if (activating) {
        await registered.promise;
      }
      await nextTurn();
      expect(observed.completed).not.toHaveBeenCalled();
      expectCalls(0, f.rollback, ...(activating ? [f.dispose] : [launch, cleanup, f.settle]));
      if (activating) {
        expect(callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(false);
      }
      f.release();
      const result = await pending;
      if (activating) {
        expect(result).toMatchObject({ status: "accepted" });
        await vi.waitFor(() => expect(startQueuedRun).toHaveBeenCalledOnce());
        expectCalls(0, f.rollback);
      } else {
        expectCalls(1, cleanup, f.settle);
      }
    } finally {
      f.release();
      await observed.settled;
    }
  },
);
