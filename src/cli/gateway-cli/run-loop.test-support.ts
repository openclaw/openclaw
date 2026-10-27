import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { expect, it, vi, type Mock, type MockInstance } from "vitest";
import type { GatewayServer } from "../../gateway/server-public.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectCallCount } from "./run-loop-cleanup.test-support.js";

type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;

export function createGatewayLogger() {
  return {
    isEnabled: vi.fn(() => false),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

export type UpdateRespawnFixtures =
  typeof import("./run-loop-mocks.test-support.js").runLoopFixture & {
    managedUpdateSuccessorOwner: ManagedUpdateOwner;
    isGatewayWorkAdmissionClosed: () => boolean;
    withIsolatedSignals: typeof withIsolatedSignals;
    createSignaledStart: typeof createSignaledStart;
    createRuntimeWithExitSignal: typeof createRuntimeWithExitSignal;
    waitForStart: typeof waitForStart;
    waitForLoopCondition: typeof waitForLoopCondition;
    setPlatform: typeof setPlatform;
    originalPlatformDescriptor: typeof originalPlatformDescriptor;
  };

export const createActiveWorkSnapshot = (
  counts: Partial<GatewayActiveWorkSnapshot["counts"]> = {},
  blockers: GatewayActiveWorkSnapshot["blockers"] = [],
): GatewayActiveWorkSnapshot => {
  const resolvedCounts = {
    queueSize: 0,
    pendingReplies: 0,
    embeddedRuns: 0,
    backgroundExecSessions: 0,
    cronRuns: 0,
    agentRuns: 0,
    acpRuns: 0,
    mediaRuns: 0,
    rootRequests: 0,
    sessionAdmissions: 0,
    sessionMutations: 0,
    chatRuns: 0,
    queuedTurns: 0,
    terminalPersistence: 0,
    terminalSessions: 0,
    lifecycleWrites: 0,
    ...counts,
    totalActive: 0,
  };
  resolvedCounts.totalActive = Object.values(resolvedCounts).reduce(
    (total, count) => total + count,
    0,
  );
  return {
    idle: resolvedCounts.totalActive === 0,
    counts: resolvedCounts,
    blockers,
    writeCustody: [],
  };
};

export function expectRestartCloseCall(
  close: Mock<GatewayServer["close"]>,
  maxDrainTimeoutMs: number,
) {
  expect(close).toHaveBeenCalledWith(
    expect.objectContaining({
      reason: "gateway restarting",
      restartExpectedMs: 1500,
      drainTimeoutMs: expect.any(Number),
    }),
  );
  const closeArgs = close.mock.calls[0]?.[0];
  expect(closeArgs?.drainTimeoutMs).toBeLessThanOrEqual(maxDrainTimeoutMs);
  expect(closeArgs?.drainTimeoutMs).toBeGreaterThanOrEqual(0);
}

export function createSignaledStart(
  close: GatewayServer["close"],
  startupSettled = Promise.resolve(),
) {
  const started = createDeferredCore();
  const start = vi.fn<Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"]>(
    async () => {
      started.resolve();
      return createGatewayServer(close, startupSettled);
    },
  );
  return { start, started: started.promise };
}

export const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

export function setPlatform(platform: string) {
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

const LOOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR2"] as const;
type LoopSignal = (typeof LOOP_SIGNALS)[number];

export async function withIsolatedSignals(
  run: (helpers: { captureSignal: (signal: LoopSignal) => () => void }) => Promise<void>,
) {
  const existingListeners = new Map(
    LOOP_SIGNALS.map((signal) => [signal, new Set(process.listeners(signal))]),
  );
  const added = (signal: LoopSignal) =>
    process.listeners(signal).filter((listener) => !existingListeners.get(signal)!.has(listener));
  const captureSignal = (signal: LoopSignal) => {
    const listener = added(signal).at(-1);
    if (!listener) {
      throw new Error(`expected new ${signal} listener`);
    }
    return () => listener(signal);
  };
  try {
    await run({ captureSignal });
  } finally {
    for (const signal of LOOP_SIGNALS) {
      for (const listener of added(signal)) {
        process.removeListener(signal, listener);
      }
    }
  }
}

/** Existing exit-order assertions observe the joined result, never drive process exit. */
export async function runGatewayLoop({
  runtime,
  ...params
}: Parameters<typeof import("./run-loop.js").runGatewayLoop>[0] & {
  runtime: { exit: (code: number) => void };
}): Promise<number> {
  const actual = await import("./run-loop.js");
  const code = await actual.runGatewayLoop(params);
  runtime.exit(code);
  return code;
}

export function createRuntimeWithExitSignal(exitCallOrder?: string[]) {
  const exited = createDeferredCore<number>();
  const runtime = {
    exit: vi.fn((code: number) => {
      exitCallOrder?.push("exit");
      exited.resolve(code);
    }),
  };
  return { runtime, exited: exited.promise };
}

export function createLifecycleGate(onEnter?: () => void) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const wait = async () => {
    onEnter?.();
    entered.resolve();
    await release.promise;
  };
  return { entered: entered.promise, release: release.resolve, reject: release.reject, wait };
}

export async function withLifecycleClock(run: () => Promise<void>) {
  vi.useFakeTimers();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  try {
    await run();
  } finally {
    clock.mockRestore();
    vi.useRealTimers();
  }
}

export function expectUncalled(...mocks: MockInstance[]) {
  for (const mock of mocks) {
    expect(mock).not.toHaveBeenCalled();
  }
}

export async function advanceWithoutCalls(ms: number, ...mocks: MockInstance[]) {
  await vi.advanceTimersByTimeAsync(ms);
  expectUncalled(...mocks);
}

export function systemdReply(timeout = "30s") {
  return { code: 0, stdout: `LoadState=loaded\nTimeoutStopUSec=${timeout}`, stderr: "" };
}

export function expectStopCloseCall(close: Mock<GatewayServer["close"]>) {
  expect(close).toHaveBeenCalledWith({
    retainSharedState: true,
    reason: "gateway stopping",
    restartExpectedMs: null,
  });
}

export function createCloseMock() {
  return vi.fn<GatewayServer["close"]>(async (_opts) => {});
}

export function createGatewayServer(
  close: GatewayServer["close"],
  startupSettled = Promise.resolve(),
) {
  return {
    getTailscaleIngressEndpoint: () => undefined,
    close,
    startupSettled,
  } satisfies GatewayServer;
}

export async function waitForStart(started: Promise<void>) {
  await started;
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

export async function waitForLoopCondition(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
  throw new Error(message);
}

export type UpdateRespawnResultFixture =
  | {
      mode: "spawned";
      pid?: number;
      child: EventEmitter & {
        kill: (signal?: NodeJS.Signals) => unknown;
        pid?: number;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
    }
  | { mode: "disabled" | "failed"; detail?: string };

export function createUpdateRespawnChild(pid = 7777) {
  return Object.assign(new EventEmitter(), {
    pid,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((_signal?: NodeJS.Signals) => true),
  });
}

export function registerUpdateRespawnProgressTests(f: UpdateRespawnFixtures) {
  it.each([
    { waitOutcome: "healthy", elapsedMs: 20_000, closeMs: 0, sentinelStatus: "ok" },
    { waitOutcome: "still-starting", elapsedMs: 300_000, closeMs: 40_000, sentinelStatus: "ok" },
    { waitOutcome: "still-starting", elapsedMs: 300_000, closeMs: 0, sentinelStatus: "error" },
  ] as const)(
    "leaves a $waitOutcome replacement running after $elapsedMs ms",
    async ({ waitOutcome, elapsedMs, closeMs, sentinelStatus }) => {
      vi.clearAllMocks();
      f.peekGatewayRestartReason.mockReturnValue("update.run");
      f.consumeGatewayRestartIntent.mockReturnValueOnce({ reason: "update.run", force: true });
      const child = createUpdateRespawnChild(process.pid);
      f.readRestartSentinelReadOnly.mockResolvedValueOnce({
        version: 1,
        revision: 1,
        payload: { kind: "update", status: sentinelStatus, ts: 1, stats: {} },
      });
      f.respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: process.pid,
        child,
      });
      f.waitForGatewayHealthyRestart.mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, elapsedMs);
        });
        return f.respawnHealth({ healthy: waitOutcome === "healthy", waitOutcome, elapsedMs });
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, closeMs);
          });
        });
        const { start, runtime, exited } = await f.createSignaledLoopHarness(undefined, false, {
          close,
          lockPort: 18789,
        });
        const restartSignal = captureSignal("SIGUSR2");

        vi.useFakeTimers();
        restartSignal();
        await advanceWithoutCalls(10_000, runtime.exit, child.kill);
        await vi.advanceTimersByTimeAsync(closeMs + elapsedMs - 10_000);

        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
        await expect(exited).resolves.toBe(0);
        expectCallCount(0, child.kill, f.markUpdateRestartSentinelFailure);
        expectCallCount(1, f.respawnGatewayProcessForUpdate, start);
        if (waitOutcome === "still-starting" && sentinelStatus !== "error") {
          expect(f.writeRestartSentinelIfUnchanged).toHaveBeenCalledWith(
            expect.objectContaining({
              expectedRevision: 1,
              payload: expect.objectContaining({
                status: "skipped",
                stats: { reason: "still-starting" },
              }),
            }),
          );
        } else {
          expect(f.writeRestartSentinelIfUnchanged).not.toHaveBeenCalled();
        }
        expect(f.writeGatewayRestartHandoff).not.toHaveBeenCalled();
      });
    },
  );
}
