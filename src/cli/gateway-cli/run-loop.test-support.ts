import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import { expect, it, vi, type Mock } from "vitest";
import type { GatewayServer } from "../../gateway/server-public.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { GatewayRestartSnapshot } from "../daemon-cli/restart-health.js";

type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;
type GatewayStart = Parameters<typeof import("./run-loop.js").runGatewayLoop>[0]["start"];
type ExitRuntime = { log: Mock; error: Mock; exit: Mock<(code: number) => void> };

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

export type UpdateRespawnFixtures = {
  spawnProcess: Mock<typeof import("node:child_process").spawn>;
  hostedStopPrepare: Mock<typeof import("../../daemon/hosted-stop.js").prepareHostedGatewayStop>;
  waitForGatewayActiveWork: Mock<
    typeof import("../../infra/gateway-active-work.js").waitForGatewayActiveWork
  >;
  peekGatewayRestartReason: Mock<() => string | undefined>;
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
  withIsolatedSignals: typeof withIsolatedSignals;
  createSignaledStart: (close: GatewayServer["close"]) => {
    start: Mock<GatewayStart>;
    started: Promise<void>;
  };
  createRuntimeWithExitSignal: () => { runtime: ExitRuntime; exited: Promise<number> };
  runLoopWithStart: (params: {
    start: Mock<GatewayStart>;
    runtime: ExitRuntime;
    ownsProcessLifecycle?: boolean;
    lockPort?: number;
    completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
  }) => Promise<unknown>;
  waitForStart: (started: Promise<void>) => Promise<void>;
  waitForLoopCondition: (predicate: () => boolean, message: string) => Promise<void>;
  createSignaledLoopHarness: (
    exitCallOrder?: string[],
    ownsProcessLifecycle?: boolean,
  ) => Promise<{
    close: Mock<GatewayServer["close"]>;
    start: Mock<GatewayStart>;
    runtime: ExitRuntime;
    exited: Promise<number>;
  }>;
  markUpdateRestartSentinelFailure: Mock<(reason: string) => Promise<null>>;
  writeGatewayRestartHandoffSync: { mockReturnValueOnce: (value: null) => unknown };
  consumeGatewayRestartIntent: Mock<() => GatewayRestartIntent | null>;
  managedUpdateSuccessorOwner: ManagedUpdateOwner;
  claimManagedServiceUpdateHandoff: Mock<(identity: ManagedUpdateOwner) => boolean>;
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
  captureForegroundUpdateHandoffStop: Mock<
    typeof import("../../infra/update-managed-service-handoff.js").captureForegroundUpdateHandoffStop
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
    lifecycleWrites: 0,
    totalActive: 0,
    ...counts,
  };
  resolvedCounts.totalActive = Object.entries(resolvedCounts).reduce(
    (total, [key, count]) => total + (key === "totalActive" ? 0 : count),
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
  peekGatewayRestartReason,
  consumeGatewayRestartIntent,
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
  peekGatewayRestartReason: Mock<() => string | undefined>;
  consumeGatewayRestartIntent: Mock<() => GatewayRestartIntent | null>;
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
      peekGatewayRestartReason.mockReturnValue("update.run");
      consumeGatewayRestartIntent.mockReturnValueOnce({ reason: "update.run", force: true });
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
        const restartSignal = captureSignal("SIGUSR2");

        vi.useFakeTimers();
        restartSignal();
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

export function registerGatewayRestartOwnershipTests({
  consumeGatewayRestartIntentPayloadSync,
  readCgroup,
  systemctl,
  consumeGatewayRestartIntent,
  runLoopWithStart,
  acquireGatewayLock,
  gatewayLog,
  managedUpdateSuccessorOwner,
  isForegroundUpdateHandoff,
  completeForegroundUpdateHandoffAfterClose,
  respawnGatewayProcessForUpdate,
  cancelManagedServiceUpdateHandoff,
  requestManagedServiceUpdateHandoffPark,
  waitForGatewayHealthyRestart,
  restartGatewayProcessWithFreshPid,
  commitManagedServiceUpdateHandoff,
}: Pick<
  UpdateRespawnFixtures,
  | "consumeGatewayRestartIntentPayloadSync"
  | "consumeGatewayRestartIntent"
  | "runLoopWithStart"
  | "acquireGatewayLock"
  | "gatewayLog"
  | "managedUpdateSuccessorOwner"
  | "isForegroundUpdateHandoff"
  | "completeForegroundUpdateHandoffAfterClose"
  | "respawnGatewayProcessForUpdate"
  | "cancelManagedServiceUpdateHandoff"
  | "requestManagedServiceUpdateHandoffPark"
  | "waitForGatewayHealthyRestart"
  | "restartGatewayProcessWithFreshPid"
  | "commitManagedServiceUpdateHandoff"
> & {
  readCgroup: Mock;
  systemctl: Mock;
}) {
  it.each(
    [false, true].flatMap((noRespawn) =>
      [false, true].map((cleanupCompletes) => ({ noRespawn, cleanupCompletes })),
    ),
  )(
    "keeps restart ownership inside a service cgroup (noRespawn=$noRespawn, cleanupCompletes=$cleanupCompletes)",
    async ({ noRespawn, cleanupCompletes }) => {
      if (noRespawn) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        process.env.OPENCLAW_NO_RESPAWN = "1";
      }
      readCgroup.mockResolvedValue("0::/system.slice/setup_and_run_blacksmith.service\n");
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
        stderr: "",
      });
      consumeGatewayRestartIntent.mockReturnValueOnce({ force: true });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const cleanup = createDeferredCore();
        const close = createCloseMock().mockImplementationOnce(() => cleanup.promise);
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        const stop = captureSignal("SIGINT");
        vi.useFakeTimers();
        try {
          captureSignal("SIGUSR2")();
          await vi.advanceTimersByTimeAsync(11_000);
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          if (cleanupCompletes) {
            cleanup.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(start).toHaveBeenCalledTimes(2);
          } else {
            await vi.advanceTimersByTimeAsync(74_000);
            expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
            expect(start).toHaveBeenCalledOnce();
          }
          expect(acquireGatewayLock).toHaveBeenCalledWith(
            expect.objectContaining({
              listenerMode: noRespawn ? "supervised" : "foreground",
              supervisor: noRespawn ? { kind: "systemd", name: "openclaw-gateway.service" } : null,
            }),
          );
          expect(gatewayLog.info).toHaveBeenCalledWith(expect.stringContaining("shutdown=85000ms"));
        } finally {
          cleanup.resolve();
          await vi.advanceTimersByTimeAsync(0);
          if (runtime.exit.mock.calls.length === 0) {
            stop();
            await vi.advanceTimersByTimeAsync(0);
            await exited;
          }
          vi.useRealTimers();
        }
      });
    },
  );
  it.each(["completed", "unconfirmed"] as const)(
    "passes the remaining forced restart budget and reports %s cleanup before process exit",
    async (outcome) => {
      setPlatform("linux");
      vi.stubEnv("OPENCLAW_SYSTEMD_UNIT", "openclaw-gateway.service");
      vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "external");
      consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ force: true });
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
        stderr: "",
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        let cleanupDeadline: number | undefined;
        const close = vi.fn<GatewayServer["close"]>(async () => {
          cleanupDeadline = getProcessCleanupBudget()?.deadline;
          await new Promise<void>((resolve, reject) => {
            if (outcome === "completed") {
              setTimeout(resolve, 6_000);
            } else {
              setTimeout(() => {
                setImmediate(() => reject(new Error("service child extinction unconfirmed")));
              }, cleanupDeadline! - performance.now());
            }
          });
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        const { getProcessCleanupBudget } =
          await import("../../process/supervisor/cleanup-budget.js");
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
        try {
          captureSignal("SIGTERM")();
          await vi.advanceTimersByTimeAsync(5_000);
          expect(close).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(outcome === "completed" ? 1_000 : 80_001);
          await expect(exited).resolves.toBe(outcome === "completed" ? 0 : 1);
          expect(cleanupDeadline).toBe(55_000);
          expect(start).toHaveBeenCalledOnce();
        } finally {
          clock.mockRestore();
          vi.useRealTimers();
        }
      });
    },
  );

  it.each(["completed", "unconfirmed"] as const)(
    "retains the post-park foreground update cleanup budget inside a service cgroup (%s)",
    async (outcome) => {
      readCgroup.mockResolvedValue("0::/system.slice/setup_and_run_blacksmith.service\n");
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=90s",
        stderr: "",
      });
      consumeGatewayRestartIntent.mockReturnValueOnce({
        reason: "update.run",
        force: true,
        waitMs: 300_000,
        successorOwner: managedUpdateSuccessorOwner,
      });
      isForegroundUpdateHandoff.mockReturnValue(true);
      const closing = createDeferredCore();
      const settlement = createDeferredCore<{ respawn: boolean }>();
      completeForegroundUpdateHandoffAfterClose.mockReturnValueOnce(settlement.promise);
      const child = createUpdateRespawnChild();
      respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: child.pid,
        child,
      });
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = createCloseMock().mockImplementationOnce(() => closing.promise);
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, lockPort: 18789, completeBoot });
        await waitForStart(started);
        const failures: unknown[] = [];
        vi.useFakeTimers();
        const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());
        try {
          captureSignal("SIGUSR2")();
          await vi.advanceTimersByTimeAsync(0);
          expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledExactlyOnceWith(
            managedUpdateSuccessorOwner,
          );
          expect(close).toHaveBeenCalledOnce();
          expect(acquireGatewayLock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ listenerMode: "foreground", supervisor: null }),
          );
          await vi.advanceTimersByTimeAsync(11_000);
          expect(runtime.exit).not.toHaveBeenCalled();
          expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
          expect(completeBoot).not.toHaveBeenCalled();
          expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          if (outcome === "completed") {
            closing.resolve();
            await vi.advanceTimersByTimeAsync(0);
            expect(completeForegroundUpdateHandoffAfterClose).toHaveBeenCalledExactlyOnceWith(
              managedUpdateSuccessorOwner,
            );
            expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            settlement.resolve({ respawn: true });
            await vi.advanceTimersByTimeAsync(0);
            expect(respawnGatewayProcessForUpdate).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({
                decision: expect.objectContaining({ mode: "disabled", reason: "unmanaged" }),
              }),
            );
            expect(waitForGatewayHealthyRestart).toHaveBeenCalledExactlyOnceWith(
              expect.objectContaining({ child, port: 18789 }),
            );
            expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
            expect(child.kill).not.toHaveBeenCalled();
          } else {
            await vi.advanceTimersByTimeAsync(73_999);
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(cancelManagedServiceUpdateHandoff).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
              managedUpdateSuccessorOwner,
            );
            expect(completeForegroundUpdateHandoffAfterClose).not.toHaveBeenCalled();
            expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
          }
          const exitCode = outcome === "completed" ? 0 : 1;
          expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(exitCode);
          await expect(exited).resolves.toBe(exitCode);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              outcome: outcome === "completed" ? "planned_restart" : "forced_stop",
            }),
          );
          expect(start).toHaveBeenCalledOnce();
          expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
          expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        } catch (error) {
          failures.push(error);
        }
        try {
          closing.resolve();
          settlement.resolve({ respawn: false });
          await vi.advanceTimersByTimeAsync(0);
          if (!runtime.exit.mock.calls.length) {
            captureSignal("SIGINT")();
          }
          child.exitCode = 0;
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
          await vi.advanceTimersByTimeAsync(0);
          expect(runtime.exit).toHaveBeenCalledOnce();
          await exited;
        } catch (error) {
          failures.push(error);
        } finally {
          clock.mockRestore();
          vi.useRealTimers();
        }
        if (failures.length > 1) {
          throw new AggregateError(
            failures,
            "Foreground cleanup budget assertion and cleanup failed",
            {
              cause: failures[0],
            },
          );
        }
        if (failures.length === 1) {
          throw failures[0];
        }
      });
    },
  );
}
