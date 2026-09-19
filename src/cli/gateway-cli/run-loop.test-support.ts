import { afterEach, beforeEach, expect, vi, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { HostedGatewayStop } from "../../daemon/hosted-stop.js";
import type { GatewayServer } from "../../gateway/server-public.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { captureEnv, deleteTestEnvValue } from "../../test-utils/env.js";

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

export const closeLogTempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  // Foreground fixtures must not inherit the CI runner's systemd service or filesystem timing.
  const readFile = (...args: Parameters<typeof actual.readFile>) =>
    args[0] === "/proc/self/cgroup" ? Promise.resolve("0::/\n") : actual.readFile(...args);
  return { ...actual, readFile, default: { ...actual, readFile } };
});

export const systemctl = vi.fn(async () => ({
  code: 0,
  stdout: "LoadState=loaded\nTimeoutStopUSec=5min 30s",
  stderr: "",
}));
vi.mock("../../daemon/systemd-exec.js", () => ({
  execSystemctl: () => systemctl(),
  execSystemctlUser: () => systemctl(),
}));

export const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
export const hostedStopExecute = vi.fn<HostedGatewayStop["execute"]>();
export const hostedStopDispose = vi.fn<HostedGatewayStop["dispose"]>();
export const hostedStopPrepare =
  vi.fn<typeof import("../../daemon/hosted-stop.js").prepareHostedGatewayStop>();
vi.mock("../../daemon/hosted-stop.js", () => ({
  prepareHostedGatewayStop: (...args: Parameters<typeof hostedStopPrepare>) =>
    hostedStopPrepare(...args),
}));
export const consumeGatewayRestartIntentPayloadSync = vi.fn<
  () => { reason?: string; force?: boolean; waitMs?: number } | null
>(() => null);
export const consumeGatewaySigusr1RestartIntent = vi.fn<() => GatewayRestartIntent | null>(
  () => null,
);
export const managedUpdateSuccessorOwner = {
  kind: "managed-update-handoff",
  handoffId: "handoff-under-test",
  installRoot: "/openclaw/install",
} as const;
type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;
export const cancelManagedServiceUpdateHandoff = vi.fn<
  (_identity: ManagedUpdateOwner) => Promise<false | "restored-in-process" | "restart-after-exit">
>(async () => "restored-in-process");
const claimManagedServiceUpdateHandoff = vi.fn((_identity: ManagedUpdateOwner) => true);
export const requestManagedServiceUpdateHandoffPark = vi.fn(
  async (_identity: ManagedUpdateOwner) => true,
);
export const commitManagedServiceUpdateHandoff = vi.fn(
  async (_identity: ManagedUpdateOwner, _outcome?: "update" | "restore") => true,
);
export const consumeGatewaySigusr1RestartAuthorization = vi.fn(() => true);
const consumeGatewayRestartIntentSync = vi.fn(() => false);
export const isGatewaySigusr1RestartExternallyAllowed = vi.fn(() => false);
export const markGatewaySigusr1RestartHandled = vi.fn();
export const peekGatewaySigusr1RestartReason = vi.fn<() => string | undefined>(() => undefined);
export const resetGatewayRestartStateForInProcessRestart = vi.fn();
export const resetGatewaySuspendCoordinatorForLifecycleRestart = vi.fn();
export const consumeGatewaySuspendHandoff =
  vi.fn<typeof import("../../infra/gateway-suspend-coordinator.js").consumeGatewaySuspendHandoff>();
const disarmGatewaySuspendHandoff = vi.fn();
export const rollbackGatewayRestartSignalAdmission = vi.fn();
export const requestGatewayRestartWithSignalAdmission = vi.fn(() => ({
  status: "emitted" as const,
}));
export const writeGatewayRestartHandoffSync = vi.fn(
  (
    _opts: unknown,
  ): {
    kind: "gateway-supervisor-restart-handoff";
    version: 1;
    intentId: string;
    pid: number;
    createdAt: number;
    expiresAt: number;
    source: "unknown";
    restartKind: "full-process";
    supervisorMode: "external";
  } | null => ({
    kind: "gateway-supervisor-restart-handoff",
    version: 1,
    intentId: "test-intent",
    pid: process.pid,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    source: "unknown",
    restartKind: "full-process",
    supervisorMode: "external",
  }),
);
export const scheduleGatewaySigusr1Restart = vi.fn(
  (_opts?: { delayMs?: number; reason?: string }) => ({
    ok: true,
    pid: process.pid,
    signal: "SIGUSR1" as const,
    delayMs: 0,
    mode: "emit" as const,
    coalesced: false,
    cooldownMsApplied: 0,
  }),
);
export const idleActiveWorkSnapshot = createActiveWorkSnapshot();
export const createGatewayActiveWorkSnapshot = vi.fn(() => idleActiveWorkSnapshot);
export const waitForGatewayActiveWork = vi.fn(
  async (
    _timeoutMs?: number,
    options?: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void },
  ) => {
    const snapshot = createGatewayActiveWorkSnapshot();
    options?.onSnapshot?.(snapshot);
    return { drained: snapshot.idle, snapshot };
  },
);
export const advanceCronActiveJobGeneration = vi.fn();
export const resetCronActiveJobs = vi.fn();
export const abortActiveCronTaskRuns = vi.fn((_reason?: string) => 0);
export const retireActiveCronTaskRunTracking = vi.fn();
export const waitForActiveCronTaskRuns = vi.fn(async (_timeoutMs?: number) => ({
  drained: true,
  active: 0,
}));
export const waitForActiveCronJobs = vi.fn(async (_timeoutMs?: number) => ({
  drained: true,
  active: 0,
}));
export const reloadTaskRuntimeStateFromStore = vi.fn();
export const clearRuntimeConfigSnapshot = vi.fn();
export const restartGatewayProcessWithFreshPid = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => {
    mode: "supervised" | "disabled" | "failed";
    detail?: string;
    exitCode?: number;
    handoffSpawned?: Promise<boolean>;
  }
>(() => ({ mode: "disabled" }));
export const respawnGatewayProcessForUpdate = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => {
    mode: "spawned" | "disabled" | "failed";
    pid?: number;
    detail?: string;
    child?: { kill: () => void };
  }
>(() => ({ mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" }));
export const markUpdateRestartSentinelFailure = vi.fn<(reason: string) => Promise<null>>(
  async (_reason: string) => null,
);
export const abortPendingChannelReloads = vi.fn();
export const abortEmbeddedAgentRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting"; reason?: "restart" }) => false,
);
export const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;
export const gatewayLog = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
export const flushLogger = vi.fn(async () => {});
export const writeDiagnosticStabilityBundleForFailureSync = vi.fn(() => ({
  message: "stability bundle recorded",
}));
export const hasManagedProviderLocalServices = vi.fn(() => false);
export const stopManagedProviderLocalServices = vi.fn(async () => {});
export const cancelShutdownHardExitWatchdog = vi.fn();
export const armShutdownHardExitWatchdog = vi.fn(
  (_params: { delayMs: number; onError: (error: unknown) => void }) => ({
    cancel: cancelShutdownHardExitWatchdog,
  }),
);

vi.mock("../../infra/gateway-lock.js", () => ({
  acquireGatewayLock: (opts?: { port?: number }) => acquireGatewayLock(opts),
}));

vi.mock("../../infra/restart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart.js")>();
  return {
    ...actual,
    consumeGatewaySigusr1RestartIntent: () => consumeGatewaySigusr1RestartIntent(),
    consumeGatewaySigusr1RestartAuthorization: () => consumeGatewaySigusr1RestartAuthorization(),
    isGatewaySigusr1RestartExternallyAllowed: () => isGatewaySigusr1RestartExternallyAllowed(),
    markGatewaySigusr1RestartHandled: () => markGatewaySigusr1RestartHandled(),
    peekGatewaySigusr1RestartReason: () => peekGatewaySigusr1RestartReason(),
    resetGatewayRestartStateForInProcessRestart: () =>
      resetGatewayRestartStateForInProcessRestart(),
    rollbackGatewayRestartSignalAdmission: () => rollbackGatewayRestartSignalAdmission(),
    requestGatewayRestartWithSignalAdmission,
    scheduleGatewaySigusr1Restart: (opts?: { delayMs?: number; reason?: string }) =>
      scheduleGatewaySigusr1Restart(opts),
  };
});

vi.mock("../../infra/restart-intent.js", () => ({
  consumeGatewayRestartIntentPayloadSync: () => consumeGatewayRestartIntentPayloadSync(),
  consumeGatewayRestartIntentSync: () => consumeGatewayRestartIntentSync(),
}));

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  cancelManagedServiceUpdateHandoff: (identity: ManagedUpdateOwner) =>
    cancelManagedServiceUpdateHandoff(identity),
  claimManagedServiceUpdateHandoff: (identity: ManagedUpdateOwner) =>
    claimManagedServiceUpdateHandoff(identity),
  requestManagedServiceUpdateHandoffPark: (identity: ManagedUpdateOwner) =>
    requestManagedServiceUpdateHandoffPark(identity),
  commitManagedServiceUpdateHandoff: (
    identity: ManagedUpdateOwner,
    outcome?: "update" | "restore",
  ) => commitManagedServiceUpdateHandoff(identity, outcome),
}));

vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  consumeGatewaySuspendHandoff: (...args: Parameters<typeof consumeGatewaySuspendHandoff>) =>
    consumeGatewaySuspendHandoff(...args),
  disarmGatewaySuspendHandoff: (...args: unknown[]) => disarmGatewaySuspendHandoff(...args),
  resetGatewaySuspendCoordinatorForLifecycleRestart: () =>
    resetGatewaySuspendCoordinatorForLifecycleRestart(),
}));

vi.mock("../../infra/process-respawn.js", () => ({
  respawnGatewayProcessForUpdate: (opts?: { env?: NodeJS.ProcessEnv }) =>
    respawnGatewayProcessForUpdate(opts),
  restartGatewayProcessWithFreshPid: (opts?: { env?: NodeJS.ProcessEnv }) =>
    restartGatewayProcessWithFreshPid(opts),
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  markUpdateRestartSentinelFailure: (reason: string) => markUpdateRestartSentinelFailure(reason),
}));

vi.mock("../../infra/restart-handoff.js", () => ({
  writeGatewayRestartHandoffSync: (opts: unknown) => writeGatewayRestartHandoffSync(opts),
}));

vi.mock("../../infra/gateway-active-work.js", () => ({
  createGatewayActiveWorkSnapshot: () => createGatewayActiveWorkSnapshot(),
  waitForGatewayActiveWork: (
    timeoutMs?: number,
    options?: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void },
  ) => waitForGatewayActiveWork(timeoutMs, options),
}));

vi.mock("../../cron/active-jobs.js", () => ({
  advanceCronActiveJobGeneration: () => advanceCronActiveJobGeneration(),
  resetCronActiveJobs: () => resetCronActiveJobs(),
  waitForActiveCronJobs: (timeoutMs: number) => waitForActiveCronJobs(timeoutMs),
}));

vi.mock("../../cron/service/active-run-cancellation.js", () => ({
  abortActiveCronTaskRuns: (reason?: string) => abortActiveCronTaskRuns(reason),
  retireActiveCronTaskRunTracking: () => retireActiveCronTaskRunTracking(),
  waitForActiveCronTaskRuns: (timeoutMs: number) => waitForActiveCronTaskRuns(timeoutMs),
}));

vi.mock("../../tasks/runtime-internal.js", () => ({
  reloadTaskRuntimeStateFromStore: () => reloadTaskRuntimeStateFromStore(),
}));

vi.mock("../../config/runtime-snapshot.js", () => ({
  clearRuntimeConfigSnapshot: () => clearRuntimeConfigSnapshot(),
  getRuntimeConfigSourceSnapshot: () => null,
  registerRuntimeConfigSnapshotPreparer: vi.fn(),
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  abortEmbeddedAgentRun: (
    sessionId?: string,
    opts?: { mode?: "all" | "compacting"; reason?: "restart" },
  ) => abortEmbeddedAgentRun(sessionId, opts),
}));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => gatewayLog,
}));

vi.mock("../../logging/logger.js", () => ({
  flushLogger: () => flushLogger(),
}));

vi.mock("../../logging/diagnostic-stability-bundle.js", () => ({
  writeDiagnosticStabilityBundleForFailureSync,
}));

vi.mock("../../agents/provider-runtime-lifecycle.js", () => ({
  hasManagedProviderLocalServices: () => hasManagedProviderLocalServices(),
}));

vi.mock("../../agents/provider-local-service.js", () => ({
  stopManagedProviderLocalServices: () => stopManagedProviderLocalServices(),
}));

vi.mock("../../gateway/server-reload-generation.js", () => ({
  abortPendingChannelReloads: () => abortPendingChannelReloads(),
}));

vi.mock("./shutdown-hard-exit.js", () => ({
  armShutdownHardExitWatchdog: (params: { delayMs: number; onError: (error: unknown) => void }) =>
    armShutdownHardExitWatchdog(params),
}));

export type GatewayCloseFn = GatewayServer["close"];
type LoopRuntime = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
};

export function createCloseMock() {
  return vi.fn<GatewayCloseFn>(async (_opts) => {});
}

export function createGatewayServer(close: GatewayCloseFn, startupSettled = Promise.resolve()) {
  return {
    getTailscaleIngressEndpoint: () => undefined,
    close,
    startupSettled,
  } satisfies GatewayServer;
}

export async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: LoopRuntime;
  ownsProcessLifecycle?: boolean;
  lockPort?: number;
  healthHost?: string;
  waitForHealthyChild?: (port: number, pid?: number, host?: string) => Promise<boolean>;
  completeBoot?: (completion: GatewayBootLifecycleCompletion) => void;
}) {
  vi.resetModules();
  const { runGatewayLoop } = await import("./run-loop.js");
  const loopPromise = runGatewayLoop({
    start: params.start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
    runtime: params.runtime,
    ownsProcessLifecycle: params.ownsProcessLifecycle,
    lockPort: params.lockPort,
    healthHost: params.healthHost,
    waitForHealthyChild: params.waitForHealthyChild,
    completeBoot: params.completeBoot,
  });
  return { loopPromise };
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

export async function createSignaledLoopHarness(
  exitCallOrder?: string[],
  ownsProcessLifecycle = false,
) {
  const close = createCloseMock();
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({ start, runtime, ownsProcessLifecycle });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}

export function expectRestartHandoffCall(expected: {
  restartKind: "full-process" | "update-process";
  reason: string | undefined;
  supervisorMode: "external" | "launchd";
}) {
  expect(writeGatewayRestartHandoffSync).toHaveBeenCalledTimes(1);
  const [handoff] = writeGatewayRestartHandoffSync.mock.calls[0] ?? [];
  if (!handoff || typeof handoff !== "object" || Array.isArray(handoff)) {
    throw new Error("expected restart handoff options object");
  }
  const processInstanceId = (handoff as { processInstanceId?: unknown }).processInstanceId;
  expect(typeof processInstanceId).toBe("string");
  if (typeof processInstanceId !== "string") {
    throw new Error("expected restart handoff processInstanceId string");
  }
  expect(processInstanceId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(handoff).toEqual({
    ...expected,
    processInstanceId,
  });
}

export let gatewayWorkAdmissionActual: typeof import("../../process/gateway-work-admission.js");
let supervisorEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

beforeEach(async () => {
  vi.useRealTimers();
  setPlatform("linux");
  systemctl.mockReset().mockResolvedValue({
    code: 0,
    stdout: "LoadState=loaded\nTimeoutStopUSec=5min 30s",
    stderr: "",
  });
  for (const log of Object.values(gatewayLog)) {
    log.mockClear();
  }
  hostedStopExecute.mockReset().mockResolvedValue({ outcome: "accepted" });
  hostedStopDispose.mockReset().mockResolvedValue(undefined);
  hostedStopPrepare.mockReset().mockImplementation(async (_owner, assertCurrent) => {
    assertCurrent();
    return { execute: hostedStopExecute, dispose: hostedStopDispose };
  });
  supervisorEnvSnapshot = captureEnv([...SUPERVISOR_HINT_ENV_VARS]);
  for (const key of SUPERVISOR_HINT_ENV_VARS) {
    deleteTestEnvValue(key);
  }

  // clearAllMocks preserves queued one-shot results. A skipped lifecycle branch
  // must not shift a stale supervisor or respawn decision into the next case.
  consumeGatewaySigusr1RestartIntent.mockReset();
  consumeGatewayRestartIntentPayloadSync.mockReset().mockReturnValue(null);
  consumeGatewaySuspendHandoff.mockReset().mockReturnValue({ ok: true, value: false });
  disarmGatewaySuspendHandoff.mockClear();
  consumeGatewaySigusr1RestartIntent.mockReturnValue(null);
  peekGatewaySigusr1RestartReason.mockReset();
  peekGatewaySigusr1RestartReason.mockReturnValue(undefined);
  restartGatewayProcessWithFreshPid.mockReset();
  restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "disabled" });
  respawnGatewayProcessForUpdate.mockReset();
  respawnGatewayProcessForUpdate.mockReturnValue({
    mode: "disabled",
    detail: "OPENCLAW_NO_RESPAWN",
  });
  hasManagedProviderLocalServices.mockReset();
  hasManagedProviderLocalServices.mockReturnValue(false);
  stopManagedProviderLocalServices.mockReset();
  stopManagedProviderLocalServices.mockResolvedValue(undefined);

  gatewayWorkAdmissionActual = await vi.importActual("../../process/gateway-work-admission.js");
  gatewayWorkAdmissionActual.resetGatewayWorkAdmission();
  createGatewayActiveWorkSnapshot.mockReset();
  createGatewayActiveWorkSnapshot.mockReturnValue(idleActiveWorkSnapshot);
  waitForGatewayActiveWork.mockReset();
  waitForGatewayActiveWork.mockImplementation(async (_timeoutMs, options) => {
    const snapshot = createGatewayActiveWorkSnapshot();
    options?.onSnapshot?.(snapshot);
    return { drained: snapshot.idle, snapshot };
  });
  cancelManagedServiceUpdateHandoff.mockReset();
  cancelManagedServiceUpdateHandoff.mockResolvedValue("restored-in-process");
  claimManagedServiceUpdateHandoff.mockReset();
  claimManagedServiceUpdateHandoff.mockReturnValue(true);
  requestManagedServiceUpdateHandoffPark.mockReset();
  requestManagedServiceUpdateHandoffPark.mockResolvedValue(true);
  commitManagedServiceUpdateHandoff.mockReset();
  commitManagedServiceUpdateHandoff.mockResolvedValue(true);
});

afterEach(() => {
  supervisorEnvSnapshot?.restore();
  supervisorEnvSnapshot = undefined;
  vi.useRealTimers();
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
});
