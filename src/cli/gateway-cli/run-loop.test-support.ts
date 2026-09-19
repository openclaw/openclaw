import { EventEmitter } from "node:events";
import { expect, it, vi, type Mock } from "vitest";
import type { GatewayServer } from "../../gateway/server-public.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import type { GatewayRestartSnapshot } from "../daemon-cli/restart-health.js";

type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;
type GatewayStart = Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"];
type ExitRuntime = { log: Mock; error: Mock; exit: Mock<(code: number) => void> };
export type UpdateRespawnFixtures = {
  waitForGatewayActiveWork: Mock<
    typeof import("../../infra/gateway-active-work.js").waitForGatewayActiveWork
  >;
  peekGatewaySigusr1RestartReason: Mock<() => string | undefined>;
  respawnGatewayProcessForUpdate: Mock<
    (opts?: { env?: NodeJS.ProcessEnv }) => UpdateRespawnResultFixture
  >;
  waitForGatewayHealthyRestart: Mock<
    typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart
  >;
  respawnHealth: (overrides?: Partial<GatewayRestartSnapshot>) => GatewayRestartSnapshot;
  readRestartSentinelReadOnly: Mock<
    typeof import("../../infra/restart-sentinel.js").readRestartSentinelReadOnly
  >;
  writeRestartSentinelIfUnchanged: Mock<
    typeof import("../../infra/restart-sentinel.js").writeRestartSentinelIfUnchanged
  >;
  restartGatewayProcessWithFreshPid: Mock<
    (opts?: { env?: NodeJS.ProcessEnv }) => {
      mode: "supervised" | "disabled" | "failed";
      detail?: string;
      exitCode?: number;
      handoffSpawned?: Promise<boolean>;
    }
  >;
  withIsolatedSignals: (
    run: (helpers: {
      captureSignal: (signal: "SIGTERM" | "SIGINT" | "SIGUSR1") => () => void;
    }) => Promise<void>,
  ) => Promise<void>;
  createSignaledStart: (close: GatewayServer["close"]) => {
    start: Mock<GatewayStart>;
    started: Promise<void>;
  };
  createRuntimeWithExitSignal: () => { runtime: ExitRuntime; exited: Promise<number> };
  runLoopWithStart: (params: {
    start: Mock<GatewayStart>;
    runtime: ExitRuntime;
    lockPort?: number;
    completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
  }) => Promise<unknown>;
  waitForStart: (started: Promise<void>) => Promise<void>;
  waitForLoopCondition: (predicate: () => boolean, message: string) => Promise<void>;
  createSignaledLoopHarness: () => Promise<{
    start: Mock<GatewayStart>;
    runtime: ExitRuntime;
    exited: Promise<number>;
  }>;
  markUpdateRestartSentinelFailure: Mock<(reason: string) => Promise<null>>;
  writeGatewayRestartHandoffSync: { mockReturnValueOnce: (value: null) => unknown };
  consumeGatewaySigusr1RestartIntent: Mock<() => GatewayRestartIntent | null>;
  managedUpdateSuccessorOwner: ManagedUpdateOwner;
  isForegroundUpdateHandoff: Mock<(identity: ManagedUpdateOwner) => boolean>;
  requestManagedServiceUpdateHandoffPark: Mock<(identity: ManagedUpdateOwner) => Promise<boolean>>;
  hasManagedProviderLocalServices: Mock<() => boolean>;
  stopManagedProviderLocalServices: Mock<() => Promise<void>>;
  cancelManagedServiceUpdateHandoff: Mock<
    (identity: ManagedUpdateOwner) => Promise<false | "restored-in-process" | "restart-after-exit">
  >;
  acquireGatewayLock: Mock<
    (opts?: { port?: number }) => Promise<{ release: Mock<() => Promise<void>> }>
  >;
  completeForegroundUpdateHandoffAfterClose: Mock<
    typeof import("../../infra/update-managed-service-handoff.js").completeForegroundUpdateHandoffAfterClose
  >;
  killProcessTree: Mock;
  flushLogger: Mock<() => Promise<void>>;
  gatewayLog: { warn: Mock; info: Mock };
  isGatewayWorkAdmissionClosed: () => boolean;
  consumeGatewayRestartIntentPayloadSync: Mock<
    () => { reason?: string; force?: boolean; waitMs?: number } | null
  >;
  commitManagedServiceUpdateHandoff: Mock<
    (identity: ManagedUpdateOwner, outcome?: "update" | "restore") => Promise<boolean>
  >;
  setPlatform: (platform: string) => void;
  expectRestartHandoffCall: (expected: {
    restartKind: "full-process" | "update-process";
    reason: string | undefined;
    supervisorMode: "external" | "launchd";
  }) => void;
  originalPlatformDescriptor: PropertyDescriptor | undefined;
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
    activeTasks: 0,
    rootRequests: 0,
    sessionAdmissions: 0,
    sessionMutations: 0,
    chatRuns: 0,
    queuedTurns: 0,
    terminalPersistence: 0,
    terminalSessions: 0,
    totalActive: 0,
    ...counts,
  };
  resolvedCounts.totalActive = Object.entries(resolvedCounts).reduce(
    (total, [key, count]) => total + (key === "totalActive" ? 0 : count),
    0,
  );
  return { idle: resolvedCounts.totalActive === 0, counts: resolvedCounts, blockers };
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
  let resolveStarted: (() => void) | null = null;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const start = vi.fn<Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"]>(
    async () => {
      resolveStarted?.();
      return { getTailscaleIngressEndpoint: () => undefined, close, startupSettled };
    },
  );
  return { start, started };
}

export const shutdownBudgetCases: {
  signal: "SIGTERM" | "SIGUSR1";
  honorsAbort: boolean;
  supervisor: "systemd" | "external-systemd" | "launchd" | "foreground";
  waitMs?: number;
  installedStopMs?: number;
}[] = [
  { signal: "SIGTERM", honorsAbort: false, supervisor: "systemd", installedStopMs: 90_000 },
  {
    signal: "SIGTERM",
    honorsAbort: false,
    supervisor: "external-systemd",
    installedStopMs: 90_000,
  },
  {
    signal: "SIGUSR1",
    honorsAbort: false,
    supervisor: "external-systemd",
    installedStopMs: 90_000,
  },
  { signal: "SIGTERM", honorsAbort: false, supervisor: "systemd" },
  { signal: "SIGTERM", honorsAbort: false, supervisor: "foreground" },
  { signal: "SIGTERM", honorsAbort: true, supervisor: "systemd" },
  { signal: "SIGUSR1", honorsAbort: false, supervisor: "systemd" },
  { signal: "SIGTERM", honorsAbort: false, supervisor: "launchd" },
  { signal: "SIGUSR1", honorsAbort: false, supervisor: "launchd" },
  { signal: "SIGUSR1", honorsAbort: false, supervisor: "systemd", waitMs: 0 },
  { signal: "SIGUSR1", honorsAbort: false, supervisor: "systemd", waitMs: 600_000 },
];

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

const LOOP_SIGNALS = ["SIGTERM", "SIGINT", "SIGUSR1"] as const;
type LoopSignal = (typeof LOOP_SIGNALS)[number];

function removeNewSignalListeners(signal: LoopSignal, existing: Set<(...args: unknown[]) => void>) {
  for (const listener of process.listeners(signal)) {
    const fn = listener as (...args: unknown[]) => void;
    if (!existing.has(fn)) {
      process.removeListener(signal, fn);
    }
  }
}

function addedSignalListener(
  signal: LoopSignal,
  existing: Set<(...args: unknown[]) => void>,
): (() => void) | null {
  const listeners = process.listeners(signal) as Array<(...args: unknown[]) => void>;
  for (let i = listeners.length - 1; i >= 0; i -= 1) {
    const listener = listeners[i];
    if (listener && !existing.has(listener)) {
      return listener as () => void;
    }
  }
  return null;
}

export async function withIsolatedSignals(
  run: (helpers: { captureSignal: (signal: LoopSignal) => () => void }) => Promise<void>,
) {
  const existingListeners = Object.fromEntries(
    LOOP_SIGNALS.map((signal) => [
      signal,
      new Set(process.listeners(signal) as Array<(...args: unknown[]) => void>),
    ]),
  ) as Record<LoopSignal, Set<(...args: unknown[]) => void>>;
  const captureSignal = (signal: LoopSignal) => {
    const listener = addedSignalListener(signal, existingListeners[signal]);
    if (!listener) {
      throw new Error(`expected new ${signal} listener`);
    }
    return () => listener();
  };
  try {
    await run({ captureSignal });
  } finally {
    for (const signal of LOOP_SIGNALS) {
      removeNewSignalListeners(signal, existingListeners[signal]);
    }
  }
}

export function createRuntimeWithExitSignal(exitCallOrder?: string[]) {
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      exitCallOrder?.push("exit");
      resolveExit(code);
    }),
  };
  return { runtime, exited };
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

export function registerUpdateRespawnProgressTests({
  runLoopWithStart,
  peekGatewaySigusr1RestartReason,
  consumeGatewaySigusr1RestartIntent,
  respawnGatewayProcessForUpdate,
  readRestartSentinelReadOnly,
  waitForGatewayHealthyRestart,
  respawnHealth,
  markUpdateRestartSentinelFailure,
  writeRestartSentinelIfUnchanged,
  writeGatewayRestartHandoffSync,
}: {
  runLoopWithStart: (params: {
    start: ReturnType<typeof createSignaledStart>["start"];
    runtime: ReturnType<typeof createRuntimeWithExitSignal>["runtime"];
    lockPort: number;
  }) => Promise<unknown>;
  peekGatewaySigusr1RestartReason: Mock<() => string | undefined>;
  consumeGatewaySigusr1RestartIntent: Mock<() => GatewayRestartIntent | null>;
  respawnGatewayProcessForUpdate: Mock<
    (_opts?: { env?: NodeJS.ProcessEnv }) => UpdateRespawnResultFixture
  >;
  readRestartSentinelReadOnly: Mock<
    typeof import("../../infra/restart-sentinel.js").readRestartSentinelReadOnly
  >;
  waitForGatewayHealthyRestart: Mock<
    typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart
  >;
  respawnHealth: (overrides?: Partial<GatewayRestartSnapshot>) => GatewayRestartSnapshot;
  markUpdateRestartSentinelFailure: Mock<(reason: string) => Promise<null>>;
  writeRestartSentinelIfUnchanged: Mock<
    typeof import("../../infra/restart-sentinel.js").writeRestartSentinelIfUnchanged
  >;
  writeGatewayRestartHandoffSync: Mock;
}) {
  it.each([
    { waitOutcome: "healthy", elapsedMs: 20_000, closeMs: 0, sentinelStatus: "ok" },
    { waitOutcome: "still-starting", elapsedMs: 300_000, closeMs: 40_000, sentinelStatus: "ok" },
    { waitOutcome: "still-starting", elapsedMs: 300_000, closeMs: 0, sentinelStatus: "error" },
  ] as const)(
    "leaves a $waitOutcome replacement running after $elapsedMs ms",
    async ({ waitOutcome, elapsedMs, closeMs, sentinelStatus }) => {
      vi.clearAllMocks();
      peekGatewaySigusr1RestartReason.mockReturnValue("update.run");
      consumeGatewaySigusr1RestartIntent.mockReturnValueOnce({ reason: "update.run", force: true });
      const kill = vi.fn();
      readRestartSentinelReadOnly.mockResolvedValueOnce({
        version: 1,
        revision: 1,
        payload: { kind: "update", status: sentinelStatus, ts: 1, stats: {} },
      });
      respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: process.pid,
        child: Object.assign(createUpdateRespawnChild(process.pid), { kill }),
      });
      waitForGatewayHealthyRestart.mockImplementationOnce(async (params) => {
        expect(params).toMatchObject({
          child: { pid: process.pid, exitCode: null, signalCode: null },
          port: 18789,
          probeHosts: ["127.0.0.1"],
          requireRunningService: true,
          requirePluginHealth: false,
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, elapsedMs);
        });
        return respawnHealth({ healthy: waitOutcome === "healthy", waitOutcome, elapsedMs });
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn(async () => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, closeMs);
          });
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime, lockPort: 18789 });
        await waitForStart(started);
        const sigusr1 = captureSignal("SIGUSR1");

        vi.useFakeTimers();
        sigusr1();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(closeMs + elapsedMs - 10_000);

        expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(0);
        await expect(exited).resolves.toBe(0);
        expect(kill).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).toHaveBeenCalledTimes(1);
        expect(start).toHaveBeenCalledTimes(1);
        expect(markUpdateRestartSentinelFailure).not.toHaveBeenCalled();
        if (waitOutcome === "still-starting" && sentinelStatus !== "error") {
          expect(writeRestartSentinelIfUnchanged).toHaveBeenCalledWith(
            expect.objectContaining({
              expectedRevision: 1,
              payload: expect.objectContaining({
                status: "skipped",
                stats: { reason: "still-starting" },
              }),
            }),
          );
        } else {
          expect(writeRestartSentinelIfUnchanged).not.toHaveBeenCalled();
        }
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
      });
    },
  );
}
