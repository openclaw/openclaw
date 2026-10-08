// Shared run-loop mock registry and lifecycle for foreground and launchd cases.
import { afterEach, beforeEach, expect, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { HostedGatewayStop } from "../../daemon/hosted-stop.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import type { RuntimeEnv } from "../../runtime.js";
import { captureEnv, deleteTestEnvValue } from "../../test-utils/env.js";
import type { GatewayRestartResult } from "../daemon-cli/restart-health.types.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createGatewayLogger,
  createRuntimeWithExitSignal,
  createSignaledStart,
  originalPlatformDescriptor,
  type UpdateRespawnResultFixture,
  setPlatform,
  waitForStart,
} from "./run-loop.test-support.js";

const closeLogTempDirs = useAutoCleanupTempDirTracker(afterEach);
const { readCgroup } = vi.hoisted(() => ({ readCgroup: vi.fn() }));

const spawnProcess = vi.hoisted(() => vi.fn<typeof import("node:child_process").spawn>());
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const { mockNodeChildProcessModule } =
    await import("../../gateway/server-methods/node-child-process.test-support.js");
  if (!spawnProcess.getMockImplementation()) {
    spawnProcess.mockImplementation(actual.spawn);
  }
  const mocked = await mockNodeChildProcessModule({});
  vi.spyOn(mocked, "spawn").mockImplementation(spawnProcess);
  return mocked;
});

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  // Foreground fixtures must not inherit the CI runner's systemd service or filesystem timing.
  const readFile = (...args: Parameters<typeof actual.readFile>) =>
    args[0] === "/proc/self/cgroup" ? readCgroup() : actual.readFile(...args);
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const systemctl = vi.fn(async () => ({
  code: 0,
  stdout: "LoadState=loaded\nTimeoutStopUSec=5min 30s",
  stderr: "",
}));
vi.mock("../../daemon/systemd-exec.js", () => ({
  execSystemctl: () => systemctl(),
  execSystemctlUser: () => systemctl(),
}));

// darwin now refreshes the stop budget on every stop/restart request, and the real
// reader spawns launchctl print against three domains through the mocked
// node:child_process module. Keep launchctl out of the loop and let each case state
// the deadline launchd is enforcing. The reader reports stop: null when launchd is not
// running the stop, which leaves the platform-neutral policy in force.
const readLaunchdStopTimeout = vi.fn<
  typeof import("../../infra/launchd-stop-timeout.js").readLaunchdStopTimeout
>(async () => ({ stop: null }));
vi.mock("../../infra/launchd-stop-timeout.js", () => ({
  readLaunchdStopTimeout: (...args: Parameters<typeof readLaunchdStopTimeout>) =>
    readLaunchdStopTimeout(...args),
}));

const acquireGatewayLock = vi.fn(async (_opts?: { port?: number }) => ({
  release: vi.fn(async () => {}),
}));
const hostedStopExecute = vi.fn<HostedGatewayStop["execute"]>();
const hostedStopDispose = vi.fn<HostedGatewayStop["dispose"]>();
const hostedStopPrepare =
  vi.fn<typeof import("../../daemon/hosted-stop.js").prepareHostedGatewayStop>();
vi.mock("../../daemon/hosted-stop.js", () => ({
  prepareHostedGatewayStop: (...args: Parameters<typeof hostedStopPrepare>) =>
    hostedStopPrepare(...args),
}));
const consumeGatewayRestartIntentPayloadSync = vi.fn<
  () => { reason?: string; force?: boolean; waitMs?: number } | null
>(() => null);
const consumeGatewayRestartIntent = vi.fn<() => GatewayRestartIntent | null>(() => null);

type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;
const cancelManagedServiceUpdateHandoff = vi.fn<
  (_identity: ManagedUpdateOwner) => Promise<false | "restored-in-process" | "restart-after-exit">
>(async () => "restored-in-process");
const claimManagedServiceUpdateHandoff = vi.fn((_identity: ManagedUpdateOwner) => true);
const isForegroundUpdateHandoff = vi.fn((_identity: ManagedUpdateOwner) => false);
const completeForegroundUpdateHandoffAfterClose =
  vi.fn<
    typeof import("../../infra/update-managed-service-handoff.js").completeForegroundUpdateHandoffAfterClose
  >();
const captureForegroundUpdateHandoffStop =
  vi.fn<
    typeof import("../../infra/update-managed-service-handoff.js").captureForegroundUpdateHandoffStop
  >();
const requestManagedServiceUpdateHandoffPark = vi.fn(async (_identity: ManagedUpdateOwner) => true);
const waitForSystemServiceUpdateHandoffs = vi.fn<() => Promise<void> | undefined>();
const commitManagedServiceUpdateHandoff = vi.fn(
  async (_identity: ManagedUpdateOwner, _outcome?: "update" | "restore") => true,
);
const consumeGatewayRestartAuthorization = vi.fn(() => true);
const consumeGatewayRestartIntentSync = vi.fn(() => false);
const isGatewayRestartExternallyAllowed = vi.fn(() => false);
const markGatewayRestartHandled = vi.fn();
const peekGatewayRestartReason = vi.fn<() => string | undefined>(() => undefined);
const resetGatewayRestartStateForInProcessRestart = vi.fn();
const resetGatewaySuspendCoordinatorForLifecycleRestart = vi.fn();
const consumeGatewaySuspendHandoff =
  vi.fn<typeof import("../../infra/gateway-suspend-coordinator.js").consumeGatewaySuspendHandoff>();
const disarmGatewaySuspendHandoff = vi.fn();
const rollbackGatewayRestartSignalAdmission = vi.fn();
const requestGatewayRestartWithSignalAdmission = vi.fn(() => ({ status: "emitted" as const }));
const writeGatewayRestartHandoffSync = vi.fn(
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
const scheduleGatewayRestart = vi.fn((_opts?: { delayMs?: number; reason?: string }) => ({
  ok: true,
  pid: process.pid,
  signal: "SIGUSR2" as const,
  delayMs: 0,
  mode: "emit" as const,
  coalesced: false,
  cooldownMsApplied: 0,
}));
const idleActiveWorkSnapshot = createActiveWorkSnapshot();
const createGatewayActiveWorkSnapshot = vi.fn(() => idleActiveWorkSnapshot);
const waitForGatewayActiveWork = vi.fn(
  async (
    _timeoutMs?: number,
    options?: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void },
  ) => {
    const snapshot = createGatewayActiveWorkSnapshot();
    options?.onSnapshot?.(snapshot);
    return { drained: snapshot.idle, snapshot };
  },
);
const advanceCronActiveJobGeneration = vi.fn();
const resetCronActiveJobs = vi.fn();
const abortActiveCronTaskRuns = vi.fn((_reason?: string) => 0);
const retireActiveCronTaskRunTracking = vi.fn();
const waitForActiveCronTaskRuns = vi.fn(async (_timeoutMs?: number) => ({
  drained: true,
  active: 0,
}));
const waitForActiveCronJobs = vi.fn(async (_timeoutMs?: number) => ({
  drained: true,
  active: 0,
}));
const clearRuntimeConfigSnapshot = vi.fn();
const restartGatewayProcessWithFreshPid = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => {
    mode: "supervised" | "disabled" | "failed";
    detail?: string;
    exitCode?: number;
    handoffSpawned?: Promise<boolean>;
  }
>(() => ({ mode: "disabled" }));
const respawnGatewayProcessForUpdate = vi.fn<
  (_opts?: { env?: NodeJS.ProcessEnv }) => UpdateRespawnResultFixture
>(() => ({ mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" }));
const { killProcessTree } = vi.hoisted(() => ({ killProcessTree: vi.fn() }));
vi.mock("../../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../process/kill-tree.js")>()),
  killProcessTree,
}));
const markUpdateRestartSentinelFailure = vi.fn<(reason: string) => Promise<null>>(async () => null);
const writeRestartSentinelIfUnchanged = vi.fn<
  typeof import("../../infra/restart-sentinel.js").writeRestartSentinelIfUnchanged
>(async () => null);
const readRestartSentinelReadOnly =
  vi.fn<typeof import("../../infra/restart-sentinel.js").readRestartSentinelReadOnly>();
const waitForGatewayHealthyRestart =
  vi.fn<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>();
vi.mock("../daemon-cli/restart-health.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: (...args: Parameters<typeof waitForGatewayHealthyRestart>) =>
    waitForGatewayHealthyRestart(...args),
}));
const respawnHealth = (overrides: Partial<GatewayRestartResult> = {}): GatewayRestartResult => ({
  runtime: { status: "running", pid: 7777 },
  portUsage: { port: 18789, status: "busy", listeners: [{ pid: 7777 }], hints: [] },
  healthy: true,
  outcome:
    overrides.waitOutcome === "still-starting"
      ? "starting"
      : overrides.healthy === false
        ? "failed"
        : "ready",
  waitOutcome: "healthy",
  staleGatewayPids: [],
  ...overrides,
});
const abortPendingChannelReloads = vi.fn();
const abortEmbeddedAgentRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting"; reason?: "restart" }) => false,
);

const gatewayLog = createGatewayLogger();
const flushLogger = vi.fn(async () => {});
const writeDiagnosticStabilityBundleForFailureSync = vi.fn(() => ({
  message: "stability bundle recorded",
}));
const hasManagedProviderLocalServices = vi.fn(() => false);
const stopManagedProviderLocalServices = vi.fn(async () => {});
const cancelShutdownHardExitWatchdog = vi.fn();
const armShutdownHardExitWatchdog = vi.fn(
  (_params: { delayMs: number; onError: (error: unknown) => void }) => ({
    cancel: cancelShutdownHardExitWatchdog,
  }),
);

vi.mock("../../infra/gateway-lock.js", async (original) => ({
  ...(await original<typeof import("../../infra/gateway-lock.js")>()),
  acquireGatewayLock: (opts?: { port?: number }) => acquireGatewayLock(opts),
}));

vi.mock("../../infra/restart.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/restart.js")>();
  return {
    ...actual,
    consumeGatewayRestartIntent: () => consumeGatewayRestartIntent(),
    consumeGatewayRestartAuthorization: () => consumeGatewayRestartAuthorization(),
    isGatewayRestartExternallyAllowed: () => isGatewayRestartExternallyAllowed(),
    markGatewayRestartHandled: () => markGatewayRestartHandled(),
    peekGatewayRestartReason: () => peekGatewayRestartReason(),
    resetGatewayRestartStateForInProcessRestart: () =>
      resetGatewayRestartStateForInProcessRestart(),
    rollbackGatewayRestartSignalAdmission: () => rollbackGatewayRestartSignalAdmission(),
    requestGatewayRestartWithSignalAdmission,
    scheduleGatewayRestart: (opts?: { delayMs?: number; reason?: string }) =>
      scheduleGatewayRestart(opts),
  };
});

vi.mock("../../infra/restart-intent.js", () => ({
  consumeGatewayRestartIntentPayloadSync: () => consumeGatewayRestartIntentPayloadSync(),
  consumeGatewayRestartIntentSync: () => consumeGatewayRestartIntentSync(),
}));

vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  waitForSystemServiceUpdateHandoffs: () => waitForSystemServiceUpdateHandoffs(),
  captureForegroundUpdateHandoffStop: (
    params: Parameters<typeof captureForegroundUpdateHandoffStop>[0],
  ) => captureForegroundUpdateHandoffStop(params),
  isForegroundUpdateHandoff: (identity: ManagedUpdateOwner) => isForegroundUpdateHandoff(identity),
  completeForegroundUpdateHandoffAfterClose: (identity: ManagedUpdateOwner) =>
    completeForegroundUpdateHandoffAfterClose(identity),
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

vi.mock("../../infra/process-respawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/process-respawn.js")>()),
  respawnGatewayProcessForUpdate: (opts?: { env?: NodeJS.ProcessEnv }) =>
    respawnGatewayProcessForUpdate(opts),
  restartGatewayProcessWithFreshPid: (opts?: { env?: NodeJS.ProcessEnv }) =>
    restartGatewayProcessWithFreshPid(opts),
}));

vi.mock("../../infra/restart-sentinel.js", () => ({
  readRestartSentinelReadOnly: () => readRestartSentinelReadOnly(),
  markUpdateRestartSentinelFailure: (reason: string) => markUpdateRestartSentinelFailure(reason),
  writeRestartSentinelIfUnchanged: (...args: Parameters<typeof writeRestartSentinelIfUnchanged>) =>
    writeRestartSentinelIfUnchanged(...args),
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
  stopActiveManagedProviderLocalServices: async () =>
    hasManagedProviderLocalServices() ? stopManagedProviderLocalServices() : undefined,
}));

vi.mock("../../gateway/server-reload-generation.js", () => ({
  abortPendingChannelReloads: () => abortPendingChannelReloads(),
}));

vi.mock("./shutdown-hard-exit.js", () => ({
  armShutdownHardExitWatchdog: (params: { delayMs: number; onError: (error: unknown) => void }) =>
    armShutdownHardExitWatchdog(params),
}));

async function runLoopWithStart(params: {
  start: ReturnType<typeof vi.fn>;
  runtime: RuntimeEnv;
  ownsProcessLifecycle?: boolean;
  lockPort?: number;
  healthHost?: string;
  beginBoot?: (startedAtMs: number) => void | Promise<void>;
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
    beginBoot: params.beginBoot,
    completeBoot: params.completeBoot,
  });
  return { loopPromise };
}

async function createSignaledLoopHarness(exitCallOrder?: string[], ownsProcessLifecycle = false) {
  const close = createCloseMock();
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({ start, runtime, ownsProcessLifecycle });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}

function expectRestartHandoffCall(expected: {
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

let gatewayWorkAdmissionActual: typeof import("../../process/gateway-work-admission.js");
let supervisorEnvSnapshot: ReturnType<typeof captureEnv> | undefined;

beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  spawnProcess
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn,
    );
  acquireGatewayLock.mockReset().mockImplementation(async () => ({
    release: vi.fn(async () => {}),
  }));
  setPlatform("linux");
  readCgroup.mockReset().mockResolvedValue("0::/\n");
  systemctl.mockReset().mockResolvedValue({
    code: 0,
    stdout: "LoadState=loaded\nTimeoutStopUSec=5min 30s",
    stderr: "",
  });
  // mockReset also drops any one-shot launchd deadline a previous case left queued.
  readLaunchdStopTimeout.mockReset().mockResolvedValue({ stop: null });
  hostedStopExecute.mockReset().mockResolvedValue({ outcome: "accepted" });
  hostedStopDispose.mockReset().mockResolvedValue(undefined);
  hostedStopPrepare.mockReset().mockImplementation(async (_owner, assertCurrent) => {
    assertCurrent();
    return { execute: hostedStopExecute, dispose: hostedStopDispose };
  });
  supervisorEnvSnapshot = captureEnv([...SUPERVISOR_HINT_ENV_VARS, "OPENCLAW_NO_RESPAWN"]);
  for (const key of [...SUPERVISOR_HINT_ENV_VARS, "OPENCLAW_NO_RESPAWN"]) {
    deleteTestEnvValue(key);
  }

  // clearAllMocks preserves queued one-shot results. A skipped lifecycle branch
  // must not shift a stale supervisor or respawn decision into the next case.
  consumeGatewayRestartIntent.mockReset();
  consumeGatewayRestartIntentPayloadSync.mockReset().mockReturnValue(null);
  consumeGatewaySuspendHandoff.mockReset().mockReturnValue({ ok: true, value: false });
  disarmGatewaySuspendHandoff.mockClear();
  consumeGatewayRestartIntent.mockReturnValue(null);
  peekGatewayRestartReason.mockReset();
  peekGatewayRestartReason.mockReturnValue(undefined);
  restartGatewayProcessWithFreshPid.mockReset();
  restartGatewayProcessWithFreshPid.mockReturnValue({ mode: "disabled" });
  respawnGatewayProcessForUpdate.mockReset();
  waitForGatewayHealthyRestart.mockReset().mockResolvedValue(respawnHealth());
  writeRestartSentinelIfUnchanged.mockReset().mockResolvedValue(null);
  readRestartSentinelReadOnly.mockReset().mockResolvedValue(null);
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
  isForegroundUpdateHandoff.mockReset().mockReturnValue(false);
  completeForegroundUpdateHandoffAfterClose.mockReset().mockResolvedValue({ respawn: true });
  captureForegroundUpdateHandoffStop.mockReset().mockReturnValue(undefined);
  requestManagedServiceUpdateHandoffPark.mockReset();
  requestManagedServiceUpdateHandoffPark.mockResolvedValue(true);
  waitForSystemServiceUpdateHandoffs.mockReset().mockReturnValue(undefined);
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

export { gatewayWorkAdmissionActual };
export const runLoopFixture = {
  abortActiveCronTaskRuns,
  abortEmbeddedAgentRun,
  abortPendingChannelReloads,
  acquireGatewayLock,
  advanceCronActiveJobGeneration,
  armShutdownHardExitWatchdog,
  cancelManagedServiceUpdateHandoff,
  cancelShutdownHardExitWatchdog,
  captureForegroundUpdateHandoffStop,
  claimManagedServiceUpdateHandoff,
  clearRuntimeConfigSnapshot,
  closeLogTempDirs,
  commitManagedServiceUpdateHandoff,
  completeForegroundUpdateHandoffAfterClose,
  consumeGatewayRestartAuthorization,
  consumeGatewayRestartIntent,
  consumeGatewayRestartIntentPayloadSync,
  consumeGatewaySuspendHandoff,
  createGatewayActiveWorkSnapshot,
  createSignaledLoopHarness,
  expectRestartHandoffCall,
  flushLogger,
  gatewayLog,
  hasManagedProviderLocalServices,
  hostedStopDispose,
  hostedStopExecute,
  hostedStopPrepare,
  idleActiveWorkSnapshot,
  isForegroundUpdateHandoff,
  isGatewayRestartExternallyAllowed,
  killProcessTree,
  markGatewayRestartHandled,
  markUpdateRestartSentinelFailure,
  peekGatewayRestartReason,
  readCgroup,
  readLaunchdStopTimeout,
  readRestartSentinelReadOnly,
  requestGatewayRestartWithSignalAdmission,
  requestManagedServiceUpdateHandoffPark,
  resetCronActiveJobs,
  resetGatewayRestartStateForInProcessRestart,
  resetGatewaySuspendCoordinatorForLifecycleRestart,
  respawnGatewayProcessForUpdate,
  respawnHealth,
  restartGatewayProcessWithFreshPid,
  retireActiveCronTaskRunTracking,
  rollbackGatewayRestartSignalAdmission,
  runLoopWithStart,
  scheduleGatewayRestart,
  spawnProcess,
  stopManagedProviderLocalServices,
  systemctl,
  waitForActiveCronJobs,
  waitForActiveCronTaskRuns,
  waitForGatewayActiveWork,
  waitForGatewayHealthyRestart,
  waitForSystemServiceUpdateHandoffs,
  writeDiagnosticStabilityBundleForFailureSync,
  writeGatewayRestartHandoffSync,
  writeRestartSentinelIfUnchanged,
};
