import { afterEach, beforeEach, expect, vi } from "vitest";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { HostedGatewayStop } from "../../daemon/hosted-stop.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import { captureEnv, deleteTestEnvValue } from "../../test-utils/env.js";
import type { GatewayRestartResult } from "../daemon-cli/restart-health.types.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createGatewayLogger,
  createRuntimeWithExitSignal,
  createSignaledStart,
  originalPlatformDescriptor,
  runGatewayLoop,
  type UpdateRespawnResultFixture,
  setPlatform,
  systemdReply,
  waitForStart,
  withIsolatedSignals,
} from "./run-loop.test-support.js";

const closeLogTempDirs = useAutoCleanupTempDirTracker(afterEach);
const { readCgroup, spawnProcess, killProcessTree } = vi.hoisted(() => ({
  readCgroup: vi.fn(),
  spawnProcess: vi.fn<typeof import("node:child_process").spawn>(),
  killProcessTree: vi.fn(),
}));
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
  // Foreground fixtures must not inherit the runner's systemd service or filesystem timing.
  const readFile = (...args: Parameters<typeof actual.readFile>) =>
    args[0] === "/proc/self/cgroup" ? readCgroup() : actual.readFile(...args);
  return { ...actual, readFile, default: { ...actual, readFile } };
});

type ManagedUpdateOwner = NonNullable<GatewayRestartIntent["successorOwner"]>;
type ManagedHandoff = typeof import("../../infra/update-managed-service-handoff.js");
type RestartIntent = typeof import("../../infra/restart-intent.js");
type RestartSentinel = typeof import("../../infra/restart-sentinel.js");
const idleActiveWorkSnapshot = createActiveWorkSnapshot();
const gatewayLog = createGatewayLogger();
const cancelShutdownHardExitWatchdog = vi.fn(async () => {});
const resettableMocks = {
  systemctl: vi.fn(async () => systemdReply("5min 30s")),
  readLaunchdStopTimeout: vi.fn<
    typeof import("../../infra/launchd-stop-timeout.js").readLaunchdStopTimeout
  >(async () => ({ stop: null })),
  acquireGatewayLock: vi.fn(async (_opts?: { port?: number }) => ({
    release: vi.fn(async () => {}),
  })),
  hostedStopExecute: vi.fn<HostedGatewayStop["execute"]>(),
  hostedStopDispose: vi.fn<HostedGatewayStop["dispose"]>(),
  hostedStopPrepare: vi.fn<typeof import("../../daemon/hosted-stop.js").prepareHostedGatewayStop>(),
  consumeGatewayRestartIntentPayload: vi.fn<
    ReturnType<RestartIntent["prepareGatewayRestartIntentConsumption"]>
  >(async () => null),
  consumeGatewayRestartIntent: vi.fn<() => GatewayRestartIntent | null>(() => null),
  cancelManagedServiceUpdateHandoff: vi.fn<
    (_identity: ManagedUpdateOwner) => Promise<false | "restored-in-process" | "restart-after-exit">
  >(async () => "restored-in-process"),
  claimManagedServiceUpdateHandoff: vi.fn((_identity: ManagedUpdateOwner) => true),
  isForegroundUpdateHandoff: vi.fn((_identity: ManagedUpdateOwner) => false),
  completeForegroundUpdateHandoffAfterClose:
    vi.fn<ManagedHandoff["completeForegroundUpdateHandoffAfterClose"]>(),
  captureForegroundUpdateHandoffStop: vi.fn<ManagedHandoff["captureForegroundUpdateHandoffStop"]>(),
  requestManagedServiceUpdateHandoffPark: vi.fn(async (_identity: ManagedUpdateOwner) => true),
  waitForSystemServiceUpdateHandoffs: vi.fn<() => Promise<void> | undefined>(),
  commitManagedServiceUpdateHandoff: vi.fn(
    async (_identity: ManagedUpdateOwner, _outcome?: "update" | "restore") => true,
  ),
  peekGatewayRestartReason: vi.fn<() => string | undefined>(() => undefined),
  consumeGatewaySuspendHandoff:
    vi.fn<
      typeof import("../../infra/gateway-suspend-coordinator.js").consumeGatewaySuspendHandoff
    >(),
  createGatewayActiveWorkSnapshot: vi.fn(() => idleActiveWorkSnapshot),
  waitForGatewayActiveWork: vi.fn(waitForActiveWork),
  restartGatewayProcessWithFreshPid: vi.fn<
    (_opts?: { env?: NodeJS.ProcessEnv }) => {
      mode: "supervised" | "disabled" | "failed";
      detail?: string;
      exitCode?: number;
      handoffSpawned?: Promise<boolean>;
    }
  >(() => ({ mode: "disabled" })),
  respawnGatewayProcessForUpdate: vi.fn<
    (_opts?: { env?: NodeJS.ProcessEnv }) => UpdateRespawnResultFixture
  >(() => ({ mode: "disabled", detail: "OPENCLAW_NO_RESPAWN" })),
  writeRestartSentinelIfUnchanged: vi.fn<RestartSentinel["writeRestartSentinelIfUnchanged"]>(
    async () => null,
  ),
  readRestartSentinelReadOnly: vi.fn<RestartSentinel["readRestartSentinelReadOnly"]>(),
  waitForGatewayHealthyRestart:
    vi.fn<typeof import("../daemon-cli/restart-health.js").waitForGatewayHealthyRestart>(),
  hasManagedProviderLocalServices: vi.fn(() => false),
  stopManagedProviderLocalServices: vi.fn(async () => {}),
};
const m = {
  ...resettableMocks,
  consumeGatewayRestartAuthorization: vi.fn(() => true),
  isGatewayRestartExternallyAllowed: vi.fn(() => false),
  markGatewayRestartHandled: vi.fn(),
  resetGatewayRestartStateForInProcessRestart: vi.fn(),
  resetGatewaySuspendCoordinatorForLifecycleRestart: vi.fn(),
  disarmGatewaySuspendHandoff: vi.fn(),
  rollbackGatewayRestartSignalAdmission: vi.fn(),
  requestGatewayRestartWithSignalAdmission: vi.fn(() => ({ status: "emitted" as const })),
  writeGatewayRestartHandoff: vi.fn<
    typeof import("../../infra/restart-handoff.js").writeGatewayRestartHandoff
  >(async () => ({
    kind: "gateway-supervisor-restart-handoff",
    version: 1,
    intentId: "test-intent",
    pid: process.pid,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    source: "unknown",
    restartKind: "full-process",
    supervisorMode: "external",
  })),
  scheduleGatewayRestart: vi.fn((_opts?: { delayMs?: number; reason?: string }) => ({
    ok: true,
    pid: process.pid,
    signal: "SIGUSR2" as const,
    delayMs: 0,
    mode: "emit" as const,
    coalesced: false,
    cooldownMsApplied: 0,
  })),
  advanceCronActiveJobGeneration: vi.fn(),
  resetCronActiveJobs: vi.fn(),
  abortActiveCronTaskRuns: vi.fn((_reason?: string) => 0),
  retireActiveCronTaskRunTracking: vi.fn(),
  waitForActiveCronTaskRuns: vi.fn(drainedCronWork),
  waitForActiveCronJobs: vi.fn(drainedCronWork),
  clearRuntimeConfigSnapshot: vi.fn(),
  markUpdateRestartSentinelFailure: vi.fn<(reason: string) => Promise<null>>(async () => null),
  abortPendingChannelReloads: vi.fn(),
  abortEmbeddedAgentRun: vi.fn(
    (_sessionId?: string, _opts?: { mode?: "all" | "compacting"; reason?: "restart" }) => false,
  ),
  flushLogger: vi.fn(async () => {}),
  writeDiagnosticStabilityBundleForFailureSync: vi.fn(() => ({
    message: "stability bundle recorded",
  })),
  armShutdownHardExitWatchdog: vi.fn(
    (_params: { delayMs: number; onError: (error: unknown) => void }) => ({
      cancel: cancelShutdownHardExitWatchdog,
    }),
  ),
};

async function drainedCronWork(_timeoutMs?: number) {
  return { drained: true, active: 0 };
}
async function waitForActiveWork(
  _timeoutMs?: number,
  options?: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void },
): Promise<{ drained: boolean; snapshot: GatewayActiveWorkSnapshot }> {
  const snapshot = m.createGatewayActiveWorkSnapshot();
  options?.onSnapshot?.(snapshot);
  return { drained: snapshot.idle, snapshot };
}

// Delay registry access until invocation: hoisted module factories can run before m initializes.
function forward<A extends unknown[], R>(get: () => (...args: A) => R) {
  return (...args: A) => get()(...args);
}
// mock-isolation: Supervisor policy must come from the fixture, not the runner's systemd.
vi.mock("../../daemon/systemd-exec.js", () => ({
  execSystemctl: () => m.systemctl(),
  execSystemctlUser: () => m.systemctl(),
}));
// mock-isolation: Do not query the runner's launchd domains for fixture stop deadlines.
vi.mock("../../infra/launchd-stop-timeout.js", () => ({
  readLaunchdStopTimeout: forward(() => m.readLaunchdStopTimeout),
}));
// mock-isolation: Hosted stop requests must not control the runner's native service.
vi.mock("../../daemon/hosted-stop.js", () => ({
  prepareHostedGatewayStop: forward(() => m.hostedStopPrepare),
}));
vi.mock("../../process/kill-tree.js", async (original) => ({
  ...(await original<typeof import("../../process/kill-tree.js")>()),
  killProcessTree,
}));
vi.mock("../daemon-cli/restart-health.js", async (original) => ({
  ...(await original<typeof import("../daemon-cli/restart-health.js")>()),
  waitForGatewayHealthyRestart: forward(() => m.waitForGatewayHealthyRestart),
}));
vi.mock("../../infra/gateway-lock.js", async (original) => ({
  ...(await original<typeof import("../../infra/gateway-lock.js")>()),
  acquireGatewayLock: (opts?: { port?: number }) => m.acquireGatewayLock(opts),
}));
vi.mock("../../infra/restart.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart.js")>()),
  consumeGatewayRestartIntent: () => m.consumeGatewayRestartIntent(),
  consumeGatewayRestartAuthorization: () => m.consumeGatewayRestartAuthorization(),
  isGatewayRestartExternallyAllowed: () => m.isGatewayRestartExternallyAllowed(),
  markGatewayRestartHandled: () => m.markGatewayRestartHandled(),
  peekGatewayRestartReason: () => m.peekGatewayRestartReason(),
  resetGatewayRestartStateForInProcessRestart: () =>
    m.resetGatewayRestartStateForInProcessRestart(),
  rollbackGatewayRestartSignalAdmission: () => m.rollbackGatewayRestartSignalAdmission(),
  requestGatewayRestartWithSignalAdmission: m.requestGatewayRestartWithSignalAdmission,
  scheduleGatewayRestart: (opts?: { delayMs?: number; reason?: string }) =>
    m.scheduleGatewayRestart(opts),
}));
vi.mock("../../infra/restart-intent.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart-intent.js")>()),
  prepareGatewayRestartIntentConsumption: () => m.consumeGatewayRestartIntentPayload,
}));
// mock-isolation: Fixtures own handoff claims without reading or mutating live update state.
vi.mock("../../infra/update-managed-service-handoff.js", () => ({
  waitForSystemServiceUpdateHandoffs: () => m.waitForSystemServiceUpdateHandoffs(),
  captureForegroundUpdateHandoffStop: forward(() => m.captureForegroundUpdateHandoffStop),
  isForegroundUpdateHandoff: forward(() => m.isForegroundUpdateHandoff),
  completeForegroundUpdateHandoffAfterClose: forward(
    () => m.completeForegroundUpdateHandoffAfterClose,
  ),
  cancelManagedServiceUpdateHandoff: forward(() => m.cancelManagedServiceUpdateHandoff),
  claimManagedServiceUpdateHandoff: forward(() => m.claimManagedServiceUpdateHandoff),
  requestManagedServiceUpdateHandoffPark: forward(() => m.requestManagedServiceUpdateHandoffPark),
  commitManagedServiceUpdateHandoff: (
    identity: ManagedUpdateOwner,
    outcome?: "update" | "restore",
  ) => m.commitManagedServiceUpdateHandoff(identity, outcome),
}));
// mock-isolation: Suspend ownership belongs to each fixture, not the process singleton.
vi.mock("../../infra/gateway-suspend-coordinator.js", () => ({
  consumeGatewaySuspendHandoff: forward(() => m.consumeGatewaySuspendHandoff),
  disarmGatewaySuspendHandoff: forward(() => m.disarmGatewaySuspendHandoff),
  resetGatewaySuspendCoordinatorForLifecycleRestart: () =>
    m.resetGatewaySuspendCoordinatorForLifecycleRestart(),
}));
vi.mock("../../infra/process-respawn.js", async (original) => ({
  ...(await original<typeof import("../../infra/process-respawn.js")>()),
  respawnGatewayProcessForUpdate: (opts?: { env?: NodeJS.ProcessEnv }) =>
    m.respawnGatewayProcessForUpdate(opts),
  restartGatewayProcessWithFreshPid: (opts?: { env?: NodeJS.ProcessEnv }) =>
    m.restartGatewayProcessWithFreshPid(opts),
}));
// mock-isolation: Restart sentinel receipts must not read or write the runner's state.
vi.mock("../../infra/restart-sentinel.js", () => ({
  readRestartSentinelReadOnly: () => m.readRestartSentinelReadOnly(),
  markUpdateRestartSentinelFailure: forward(() => m.markUpdateRestartSentinelFailure),
  writeRestartSentinelIfUnchanged: forward(() => m.writeRestartSentinelIfUnchanged),
}));
vi.mock("../../infra/restart-handoff.js", async (original) => ({
  ...(await original<typeof import("../../infra/restart-handoff.js")>()),
  writeGatewayRestartHandoff: forward(() => m.writeGatewayRestartHandoff),
}));
// mock-isolation: Drain scenarios own their active-work snapshots and completion gates.
vi.mock("../../infra/gateway-active-work.js", () => ({
  createGatewayActiveWorkSnapshot: () => m.createGatewayActiveWorkSnapshot(),
  waitForGatewayActiveWork: (
    timeoutMs?: number,
    options?: { onSnapshot?: (snapshot: GatewayActiveWorkSnapshot) => void },
  ) => m.waitForGatewayActiveWork(timeoutMs, options),
}));
// mock-isolation: Run-loop retirement must not reset process-global cron job tracking.
vi.mock("../../cron/active-jobs.js", () => ({
  advanceCronActiveJobGeneration: () => m.advanceCronActiveJobGeneration(),
  resetCronActiveJobs: () => m.resetCronActiveJobs(),
  waitForActiveCronJobs: forward(() => m.waitForActiveCronJobs),
}));
// mock-isolation: Cancellation and drain gates must not touch real cron task runs.
vi.mock("../../cron/service/active-run-cancellation.js", () => ({
  abortActiveCronTaskRuns: (reason?: string) => m.abortActiveCronTaskRuns(reason),
  retireActiveCronTaskRunTracking: () => m.retireActiveCronTaskRunTracking(),
  waitForActiveCronTaskRuns: forward(() => m.waitForActiveCronTaskRuns),
}));
// mock-isolation: Run-loop fixtures own config and lifecycle state without a live snapshot.
vi.mock("../../config/runtime-snapshot.js", () => ({
  clearRuntimeConfigSnapshot: () => m.clearRuntimeConfigSnapshot(),
  getRuntimeConfigSnapshot: () => null,
  getRuntimeConfigSourceSnapshot: () => null,
  registerRuntimeConfigSnapshotPreparer: vi.fn(),
}));
// mock-isolation: Shutdown assertions must not abort unrelated process-global agent runs.
vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  abortEmbeddedAgentRun: (
    sessionId?: string,
    opts?: { mode?: "all" | "compacting"; reason?: "restart" },
  ) => m.abortEmbeddedAgentRun(sessionId, opts),
}));
// mock-isolation: Capture lifecycle diagnostics without initializing real log transports.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => gatewayLog }));
// mock-isolation: Each fixture controls logger settlement without flushing unrelated logs.
vi.mock("../../logging/logger.js", () => ({ flushLogger: () => m.flushLogger() }));
// mock-isolation: Failure assertions must not write real diagnostic bundles.
vi.mock("../../logging/diagnostic-stability-bundle.js", () => ({
  writeDiagnosticStabilityBundleForFailureSync: m.writeDiagnosticStabilityBundleForFailureSync,
}));
// mock-isolation: Fixture shutdown must not stop real managed provider processes.
vi.mock("../../agents/provider-runtime-lifecycle.js", () => ({
  stopActiveManagedProviderLocalServices: async () =>
    m.hasManagedProviderLocalServices() ? m.stopManagedProviderLocalServices() : undefined,
}));
// mock-isolation: Retiring the fixture must not cancel unrelated channel reloads.
vi.mock("../../gateway/server-reload-generation.js", () => ({
  abortPendingChannelReloads: () => m.abortPendingChannelReloads(),
}));
// mock-isolation: Fixture watchdogs record cancellation instead of terminating Vitest.
vi.mock("./shutdown-hard-exit.js", () => ({
  armShutdownHardExitWatchdog: forward(() => m.armShutdownHardExitWatchdog),
}));

async function runLoopWithStart(params: Parameters<typeof runGatewayLoop>[0]) {
  return { loopPromise: runGatewayLoop(params) };
}
async function createSignaledLoopHarness(
  exitCallOrder?: string[],
  ownsProcessLifecycle = false,
  options: Omit<
    Parameters<typeof runGatewayLoop>[0],
    "start" | "runtime" | "ownsProcessLifecycle"
  > & {
    close?: ReturnType<typeof createCloseMock>;
  } = {},
) {
  const { close = createCloseMock(), ...params } = options;
  const { start, started } = createSignaledStart(close);
  const { runtime, exited } = createRuntimeWithExitSignal(exitCallOrder);
  const { loopPromise } = await runLoopWithStart({
    ...params,
    start,
    runtime,
    ownsProcessLifecycle,
  });
  await waitForStart(started);
  return { close, start, runtime, exited, loopPromise };
}
function withRunningGateway(
  run: (
    harness: Awaited<ReturnType<typeof createSignaledLoopHarness>> &
      Parameters<Parameters<typeof withIsolatedSignals>[0]>[0],
  ) => Promise<void>,
  ownsProcessLifecycle = false,
  options: Parameters<typeof createSignaledLoopHarness>[2] = {},
) {
  return withIsolatedSignals(async (signals) =>
    run({
      ...(await createSignaledLoopHarness(undefined, ownsProcessLifecycle, options)),
      ...signals,
    }),
  );
}
function expectRestartHandoffCall(expected: {
  restartKind: "full-process" | "update-process";
  reason: string | undefined;
  supervisorMode: "external" | "launchd";
}) {
  expect(m.writeGatewayRestartHandoff).toHaveBeenCalledTimes(1);
  const [handoff] = m.writeGatewayRestartHandoff.mock.calls[0] ?? [];
  expect(handoff).toEqual({
    ...expected,
    processInstanceId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
  });
}
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
let gatewayWorkAdmissionActual: typeof import("../../process/gateway-work-admission.js");
let supervisorEnvSnapshot: ReturnType<typeof captureEnv> | undefined;
beforeEach(async () => {
  vi.useRealTimers();
  vi.clearAllMocks();
  // mockReset restores vi.fn's initial implementation and drops queued one-shot results.
  Object.values(resettableMocks).forEach((mock) => mock.mockReset());
  spawnProcess
    .mockReset()
    .mockImplementation(
      (await vi.importActual<typeof import("node:child_process")>("node:child_process")).spawn,
    );
  setPlatform("linux");
  readCgroup.mockReset().mockResolvedValue("0::/\n");
  m.hostedStopExecute.mockResolvedValue({ outcome: "accepted" });
  m.hostedStopDispose.mockResolvedValue(undefined);
  m.hostedStopPrepare.mockImplementation(async (_owner, assertCurrent) => {
    assertCurrent();
    return { execute: m.hostedStopExecute, dispose: m.hostedStopDispose };
  });
  const supervisorEnv = [...SUPERVISOR_HINT_ENV_VARS, "OPENCLAW_NO_RESPAWN"];
  supervisorEnvSnapshot = captureEnv(supervisorEnv);
  supervisorEnv.forEach(deleteTestEnvValue);
  m.consumeGatewaySuspendHandoff.mockReturnValue({ ok: true, value: false });
  m.waitForGatewayHealthyRestart.mockResolvedValue(respawnHealth());
  m.readRestartSentinelReadOnly.mockResolvedValue(null);
  gatewayWorkAdmissionActual = await vi.importActual("../../process/gateway-work-admission.js");
  gatewayWorkAdmissionActual.resetGatewayWorkAdmission();
  m.completeForegroundUpdateHandoffAfterClose.mockResolvedValue({ respawn: true });
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
  ...m,
  cancelShutdownHardExitWatchdog,
  closeLogTempDirs,
  createSignaledLoopHarness,
  expectRestartHandoffCall,
  gatewayLog,
  idleActiveWorkSnapshot,
  killProcessTree,
  readCgroup,
  respawnHealth,
  runLoopWithStart,
  spawnProcess,
  withRunningGateway,
};
