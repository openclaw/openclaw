// Gateway run loop tests cover foreground gateway lifecycle and restart behavior.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createTempDirTracker,
  useAutoCleanupTempDirTracker,
} from "../../../test/helpers/temp-dir.js";
import type { HostedGatewayStop } from "../../daemon/hosted-stop.js";
import type { GatewayServer, GatewayStartupOperation } from "../../gateway/server-public.js";
import type { GatewayActiveWorkSnapshot } from "../../infra/gateway-active-work.js";
import type { GatewayBootLifecycleCompletion } from "../../infra/gateway-boot-lifecycle.js";
import type { GatewayRestartIntent } from "../../infra/restart-intent.js";
import { SUPERVISOR_HINT_ENV_VARS } from "../../infra/supervisor-markers.js";
import type { RuntimeEnv } from "../../runtime.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import { captureEnv, deleteTestEnvValue } from "../../test-utils/env.js";
import type { GatewayRestartSnapshot } from "../daemon-cli/restart-health.js";
import { registerHostedUpdateStopTests } from "./run-loop-hosted-stop.test-support.js";
import { registerGatewayRequestTests } from "./run-loop-request.test-support.js";
import { registerShutdownBudgetTests } from "./run-loop-shutdown-budget.test-support.js";
import { registerShutdownCompletionTests } from "./run-loop-shutdown-completion.test-support.js";
import { registerGatewayStartupFailureTests } from "./run-loop-startup.test-support.js";
import { registerUpdateRespawnTests } from "./run-loop-update-respawn.test-support.js";
import {
  createActiveWorkSnapshot,
  createCloseMock,
  createGatewayLogger,
  createGatewayServer,
  createRuntimeWithExitSignal,
  createSignaledStart,
  createUpdateRespawnChild,
  expectRestartCloseCall,
  originalPlatformDescriptor,
  registerUpdateRespawnProgressTests,
  registerGatewayRestartOwnershipTests,
  type UpdateRespawnResultFixture,
  setPlatform,
  waitForStart,
  waitForLoopCondition,
  withIsolatedSignals,
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
const managedUpdateSuccessorOwner = {
  kind: "managed-update-handoff",
  handoffId: "handoff-under-test",
  installRoot: "/openclaw/install",
} as const;
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
const reloadTaskRuntimeStateFromStore = vi.fn();
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
const respawnHealth = (
  overrides: Partial<GatewayRestartSnapshot> = {},
): GatewayRestartSnapshot => ({
  runtime: { status: "running", pid: 7777 },
  portUsage: { port: 18789, status: "busy", listeners: [{ pid: 7777 }], hints: [] },
  healthy: true,
  waitOutcome: "healthy",
  staleGatewayPids: [],
  ...overrides,
});
const abortPendingChannelReloads = vi.fn();
const abortEmbeddedAgentRun = vi.fn(
  (_sessionId?: string, _opts?: { mode?: "all" | "compacting"; reason?: "restart" }) => false,
);
const DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS = 300_000;
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

type GatewayCloseFn = GatewayServer["close"];

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

describe("runGatewayLoop", () => {
  registerGatewayRequestTests({
    createSignaledLoopHarness,
    createGatewayActiveWorkSnapshot,
    abortActiveCronTaskRuns,
    acquireGatewayLock,
    reloadTaskRuntimeStateFromStore,
    runLoopWithStart,
    waitForGatewayActiveWork,
    restartGatewayProcessWithFreshPid,
    respawnGatewayProcessForUpdate,
    captureForegroundUpdateHandoffStop,
    readCgroup,
    systemctl,
    armShutdownHardExitWatchdog,
    cancelShutdownHardExitWatchdog,
    consumeGatewayRestartIntent,
    consumeGatewayRestartIntentPayloadSync,
    peekGatewayRestartReason,
    managedUpdateSuccessorOwner,
    commitManagedServiceUpdateHandoff,
    waitForSystemServiceUpdateHandoffs,
    isGatewayWorkAdmissionClosed: () => gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed(),
    gatewayLog,
  });

  it.each([false, true])(
    "hints on three repeated signals within five minutes (expired: %s)",
    async (expired) => {
      vi.clearAllMocks();
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, exited } = await createSignaledLoopHarness();
        const closing = createDeferredCore();
        close.mockImplementationOnce(() => closing.promise);
        const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
        try {
          const sigterm = captureSignal("SIGTERM");
          sigterm();
          await waitForLoopCondition(() => close.mock.calls.length === 1, "close did not start");
          now.mockReturnValue(1_000_000 + (expired ? 300_001 : 1_000));
          sigterm();
          sigterm();
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          const hint =
            "received SIGTERM 3 times in 5 min: another supervisor may be managing this Gateway — see `openclaw gateway status --deep`";
          if (expired) {
            expect(gatewayLog.warn).not.toHaveBeenCalledWith(hint);
          } else {
            expect(gatewayLog.warn).toHaveBeenCalledWith(hint);
          }
        } finally {
          now.mockRestore();
          closing.resolve();
          await expect(exited).resolves.toBe(0);
        }
      });
    },
  );

  it.each([false, true])(
    "joins external restart cleanup without creating a successor (close failure: %s)",
    async (fails) => {
      vi.clearAllMocks();
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { close, start, runtime, exited } = await createSignaledLoopHarness(undefined, true);
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        const joined = createDeferredCore();
        close.mockImplementationOnce(async () => {
          await joined.promise;
          if (fails) {
            throw new Error("external cleanup failed");
          }
        });
        consumeGatewaySuspendHandoff.mockImplementationOnce((owner) => {
          expect(owner).toBe(host?.externalRestart);
          expect(owner?.isCurrent()).toBe(true);
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
          return { ok: true, value: true };
        });
        try {
          const sigterm = captureSignal("SIGTERM");
          sigterm();
          await waitForLoopCondition(
            () => close.mock.calls.length === 1,
            "external cleanup did not begin",
          );
          sigterm();
          expect(host?.externalRestart?.isCurrent()).toBe(false);
          expectRestartCloseCall(close, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
          expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
          expect(runtime.exit).not.toHaveBeenCalled();
        } finally {
          joined.resolve();
        }
        await expect(exited).resolves.toBe(fails ? 1 : 0);
        expect(consumeGatewaySuspendHandoff).toHaveBeenCalledOnce();
        expect(start).toHaveBeenCalledOnce();
        expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
        expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        expect(writeGatewayRestartHandoffSync).not.toHaveBeenCalled();
        expect(cancelShutdownHardExitWatchdog).toHaveBeenCalled();
      });
    },
  );

  it("keeps the ordinary drain when a handoff refuses late terminal persistence", async () => {
    vi.clearAllMocks();
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, exited } = await createSignaledLoopHarness(undefined, true);
      consumeGatewaySuspendHandoff.mockReturnValueOnce({
        ok: false,
        error: "gateway terminal persistence is still pending",
      });
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, expect.any(Object));
      expect(close).toHaveBeenCalledWith({ reason: "gateway stopping", restartExpectedMs: null });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "external restart handoff refused: gateway terminal persistence is still pending",
      );
    });
  });
  it("does not grant process control to a nonexclusive embedded host", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, close, exited, runtime } = await createSignaledLoopHarness();
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      await expect(host!.request("start", () => {})).resolves.toMatchObject({
        ok: true,
        value: { outcome: "already-running" },
      });
      for (const action of ["stop", "restart"] as const) {
        await expect(host!.request(action, () => {})).resolves.toMatchObject({
          ok: false,
          error: expect.stringContaining("does not own the process lifecycle"),
        });
      }
      expect(close).not.toHaveBeenCalled();
      expect(runtime.exit).not.toHaveBeenCalled();
      expect(hostedStopExecute).not.toHaveBeenCalled();
      captureSignal("SIGINT")();
      await expect(exited).resolves.toBe(0);
    });
  });

  it.each(["native", "foreground"] as const)(
    "retains the initiating root through response submission and joins before %s stop",
    async (mode) => {
      if (mode === "foreground") {
        const native = await vi.importActual<typeof import("../../daemon/hosted-stop.js")>(
          "../../daemon/hosted-stop.js",
        );
        hostedStopPrepare.mockImplementation(native.prepareHostedGatewayStop);
      }
      await withIsolatedSignals(async () => {
        const { close, start, exited } = await createSignaledLoopHarness(undefined, true);
        const startOptions = start.mock.calls[0]?.[0];
        const host = startOptions?.hostLifecycle;
        expect(host).toBeDefined();
        let finishRequest!: () => void;
        const requestFinished = new Promise<void>((resolve) => {
          finishRequest = resolve;
        });
        let finishJoin!: () => void;
        const joined = new Promise<void>((resolve) => {
          finishJoin = resolve;
        });
        close.mockImplementationOnce(async () => {
          await joined;
        });
        waitForGatewayActiveWork.mockImplementationOnce(async () => {
          // excludeCurrent must not hide the original RPC when shutdown begins.
          expect(
            gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount({ excludeCurrent: true }),
          ).toBe(1);
          await requestFinished;
          expect(gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount()).toBe(0);
          return { drained: true, snapshot: idleActiveWorkSnapshot };
        });
        try {
          await gatewayWorkAdmissionActual.runWithGatewayIndependentRootWorkAdmission(async () => {
            await expect(host!.request("stop", () => {})).resolves.toEqual({
              ok: true,
              value: { outcome: "scheduled" },
            });
            // Audit/history/response work remains in the admitted handler after acceptance.
            await Promise.resolve();
            expect(gatewayWorkAdmissionActual.getActiveGatewayRootWorkCount()).toBe(1);
            expect(close).not.toHaveBeenCalled();
            expect(hostedStopExecute).not.toHaveBeenCalled();
          }, "rpc:system-agent.chat");
          finishRequest();
          await waitForLoopCondition(
            () => close.mock.calls.length === 1,
            "hosted stop did not reach teardown",
          );
          expect(hostedStopExecute).not.toHaveBeenCalled();
          finishJoin();
          await expect(exited).resolves.toBe(0);
          expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, {
            onSnapshot: expect.any(Function),
          });
          expect(hostedStopExecute).toHaveBeenCalledTimes(mode === "native" ? 1 : 0);
          await expect(host!.request("start", () => {})).resolves.toMatchObject({ ok: false });
        } finally {
          finishRequest();
          finishJoin();
        }
      });
    },
  );

  registerHostedUpdateStopTests({
    captureForegroundUpdateHandoffStop,
    isForegroundUpdateHandoff,
    completeForegroundUpdateHandoffAfterClose,
    hostedStopPrepare,
    hostedStopExecute,
    hostedStopDispose,
    createSignaledLoopHarness,
    managedUpdateSuccessorOwner,
    respawnGatewayProcessForUpdate,
    isGatewayWorkAdmissionClosed: () => gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed(),
  });

  it("joins a self-waiting native client on SIGTERM without reopening closed kernel storage", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const nativeStarted = createDeferredCore();
      const nativeClosed = createDeferredCore();
      hostedStopPrepare.mockImplementationOnce(async (_owner, assertCurrent, signal) => {
        assertCurrent();
        hostedStopExecute.mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => reject(new Error("native stop interrupted", { cause: signal.reason })),
                { once: true },
              );
              nativeStarted.resolve();
            }),
        );
        return { execute: hostedStopExecute, dispose: hostedStopDispose };
      });
      hostedStopDispose.mockImplementationOnce(() => nativeClosed.promise);
      const { close, start, exited, runtime } = await createSignaledLoopHarness(undefined, true);
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      try {
        await expect(host!.request("stop", () => {})).resolves.toMatchObject({ ok: true });
        await nativeStarted.promise;
        expect(close).toHaveBeenCalledOnce();
        captureSignal("SIGTERM")();
        await waitForLoopCondition(
          () => hostedStopDispose.mock.calls.length === 1,
          "native stop signal did not cancel the self-waiting client",
        );
        expect(runtime.exit).not.toHaveBeenCalled();
        // A second native signal during the close join still belongs to this stop.
        captureSignal("SIGTERM")();
        expect(consumeGatewayRestartIntentPayloadSync).not.toHaveBeenCalled();
      } finally {
        nativeClosed.resolve();
      }
      await expect(exited).resolves.toBe(0);
      expect(start).toHaveBeenCalledOnce();
      expect(gatewayLog.info).not.toHaveBeenCalledWith(
        "Native service manager accepted Gateway stop",
      );
    });
  });

  it("reopens a fresh generation only after a definitive native stop refusal", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      hostedStopExecute.mockResolvedValueOnce({
        outcome: "refused",
        detail: "same native generation; stop denied",
      });
      let finishClose!: () => void;
      hostedStopDispose.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishClose = resolve;
          }),
      );
      const { start, exited, runtime } = await createSignaledLoopHarness(undefined, true);
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      expect(host).toBeDefined();
      await host!.request("stop", () => {});
      await waitForLoopCondition(
        () => hostedStopDispose.mock.calls.length === 1,
        "executor cleanup did not start",
      );
      expect(start).toHaveBeenCalledOnce();
      expect(runtime.exit).not.toHaveBeenCalled();
      finishClose();
      await waitForLoopCondition(
        () => start.mock.calls.length === 2,
        "native refusal left a closed Gateway instead of restarting in process",
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      await expect(host!.request("restart", () => {})).resolves.toMatchObject({ ok: false });
      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("same native generation; stop denied"),
      );
      captureSignal("SIGINT")();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("reports uncertain native stop without clean-stop success or in-process recovery", async () => {
    await withIsolatedSignals(async () => {
      hostedStopExecute.mockResolvedValueOnce({
        outcome: "uncertain",
        detail: "native acknowledgement lost",
      });
      const { start, exited } = await createSignaledLoopHarness(undefined, true);
      const host = start.mock.calls[0]?.[0]?.hostLifecycle;
      await host!.request("stop", () => {});
      await expect(exited).resolves.toBe(1);
      expect(start).toHaveBeenCalledOnce();
      expect(gatewayLog.error).toHaveBeenCalledWith(
        expect.stringContaining("native acknowledgement lost"),
      );
    });
  });

  it.each(["clean", "failed"] as const)(
    "routes deferred startup failure through first-boot handling with %s cleanup",
    async (cleanup) => {
      vi.clearAllMocks();
      await withIsolatedSignals(async () => {
        const { runGatewayLoop } = await import("./run-loop.js");
        const startupError = new Error("deferred startup failed");
        const cleanupError = new Error("deferred startup cleanup failed");
        const startup = createDeferredCore();
        const close = createCloseMock();
        if (cleanup === "failed") {
          close.mockRejectedValueOnce(cleanupError);
        }
        const { start, started } = createSignaledStart(close, startup.promise);
        const { runtime } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        const loop = runGatewayLoop({ start, runtime, completeBoot });
        const settled = Promise.allSettled([loop, startup.promise]);
        try {
          await Promise.race([started, loop]);
          startup.reject(startupError);

          if (cleanup === "failed") {
            await expect(loop).rejects.toBeInstanceOf(AggregateError);
            await expect(loop).rejects.toMatchObject({
              cause: startupError,
              errors: expect.arrayContaining([startupError, cleanupError]),
            });
          } else {
            await expect(loop).rejects.toBe(startupError);
          }
          expect(start).toHaveBeenCalledOnce();
          expect(close).toHaveBeenCalledExactlyOnceWith({ reason: "gateway startup failed" });
          expect(completeBoot).toHaveBeenCalledWith({
            outcome: "startup_failed",
            reason: startupError.message,
          });
        } finally {
          startup.reject(startupError);
          await settled;
        }
      });
    },
  );

  it.each(["clean", "failed", "maintenance"] as const)(
    "fences replacement after deferred startup with %s cleanup",
    async (cleanup) => {
      vi.clearAllMocks();
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runGatewayLoop } = await import("./run-loop.js");
        const firstStartup = createDeferredCore();
        const thirdStarted = createDeferredCore();
        const { SessionStoreMigrationRequiredError } =
          await import("../../config/sessions/migration-required.js");
        const startupError =
          cleanup === "maintenance"
            ? new SessionStoreMigrationRequiredError("legacy session store requires migration")
            : new Error("replacement deferred startup failed");
        const cleanupError = new Error("replacement cleanup failed");
        const closeFirst = createCloseMock();
        const closeSecond = createCloseMock();
        if (cleanup === "failed") {
          closeSecond.mockRejectedValueOnce(cleanupError);
        }
        const closeThird = createCloseMock();
        const start = vi
          .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
          .mockResolvedValueOnce(createGatewayServer(closeFirst, firstStartup.promise))
          .mockImplementationOnce(async () =>
            createGatewayServer(closeSecond, Promise.reject(startupError)),
          )
          .mockImplementationOnce(async () => {
            thirdStarted.resolve();
            return createGatewayServer(closeThird);
          });
        const { runtime, exited } = createRuntimeWithExitSignal();
        const onRestartStartupFailure = vi.fn(async (error: unknown) => {
          expect(error).toBe(startupError);
          expect(closeSecond).toHaveBeenCalledExactlyOnceWith({ reason: "gateway startup failed" });
        });
        const loop = runGatewayLoop({ start, runtime, onRestartStartupFailure });
        const loopRejected = vi.fn<(error: unknown) => void>();
        const loopSettled = loop.catch(loopRejected);
        let stop: (() => void) | undefined;
        try {
          await waitForLoopCondition(
            () => start.mock.calls.length === 1,
            "expected initial deferred startup",
          );
          const restart = captureSignal("SIGUSR2");
          stop = captureSignal("SIGTERM");
          restart();
          // Observe either outcome, so incorrect recovery fails an assertion immediately.
          await waitForLoopCondition(
            () =>
              loopRejected.mock.calls.length > 0 ||
              gatewayLog.error.mock.calls.some(([message]) =>
                String(message).startsWith("gateway startup failed:"),
              ),
            "expected replacement startup to reject or enter recovery",
          );
          expect(closeSecond).toHaveBeenCalledExactlyOnceWith({
            reason: "gateway startup failed",
          });
          if (cleanup === "clean") {
            expect(onRestartStartupFailure).toHaveBeenCalledOnce();
            expect(loopRejected).not.toHaveBeenCalled();
            restart();
            await thirdStarted.promise;
            expect(start).toHaveBeenCalledTimes(3);
            stop();
            await expect(exited).resolves.toBe(0);
          } else if (cleanup === "maintenance") {
            expect(onRestartStartupFailure).not.toHaveBeenCalled();
            expect(loopRejected).toHaveBeenCalledExactlyOnceWith(startupError);
            expect(start).toHaveBeenCalledTimes(2);
          } else {
            expect(onRestartStartupFailure).not.toHaveBeenCalled();
            expect(loopRejected).toHaveBeenCalledOnce();
            await expect(loop).rejects.toBeInstanceOf(AggregateError);
            await expect(loop).rejects.toMatchObject({
              cause: startupError,
              errors: expect.arrayContaining([startupError, cleanupError]),
            });
            expect(start).toHaveBeenCalledTimes(2);
            expect(runtime.exit).not.toHaveBeenCalled();
          }
        } finally {
          firstStartup.resolve();
          await firstStartup.promise;
          if (
            loopRejected.mock.calls.length === 0 &&
            runtime.exit.mock.calls.length === 0 &&
            stop
          ) {
            stop();
            await exited;
          }
          if (loopRejected.mock.calls.length > 0) {
            await loopSettled;
          }
        }
      });
    },
  );

  it("rejects an unclean replacement acquisition before admitting another lifecycle", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const { GatewayStartupCleanupError } = await import("../../gateway/server-shutdown.js");
      const { runGatewayLoop } = await import("./run-loop.js");
      const startupError = new Error("replacement listener failed");
      const cleanupError = new Error("replacement required cleanup failed");
      const failure = new GatewayStartupCleanupError(startupError, cleanupError);
      let lockCallsAtFailure = 0;
      let cancellationsAtFailure = 0;
      let commitsAtFailure = 0;
      const start = vi
        .fn<Parameters<typeof runGatewayLoop>[0]["start"]>()
        .mockResolvedValueOnce(createGatewayServer(createCloseMock()))
        .mockImplementationOnce(async () => {
          lockCallsAtFailure = acquireGatewayLock.mock.calls.length;
          cancellationsAtFailure = cancelManagedServiceUpdateHandoff.mock.calls.length;
          commitsAtFailure = commitManagedServiceUpdateHandoff.mock.calls.length;
          throw failure;
        });
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      const onRestartStartupFailure = vi.fn();
      const loop = runGatewayLoop({ start, runtime, completeBoot, onRestartStartupFailure });
      const rejected = vi.fn<(error: unknown) => void>();
      const settled = loop.catch(rejected);
      let stop: (() => void) | undefined;
      try {
        await waitForLoopCondition(() => start.mock.calls.length === 1, "expected first startup");
        // The first generation has completed startup before its restart is requested.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        stop = captureSignal("SIGTERM");
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () =>
            rejected.mock.calls.length > 0 ||
            gatewayLog.error.mock.calls.some(([message]) =>
              String(message).startsWith("gateway startup failed:"),
            ),
          "expected replacement acquisition failure",
        );
        expect(rejected).toHaveBeenCalledExactlyOnceWith(failure);
        await expect(loop).rejects.toBe(failure);
        expect(start).toHaveBeenCalledTimes(2);
        expect(onRestartStartupFailure).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(lockCallsAtFailure);
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledTimes(cancellationsAtFailure);
        expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledTimes(commitsAtFailure);
        expect(completeBoot).toHaveBeenCalledWith({
          outcome: "startup_failed",
          reason: expect.stringContaining(startupError.message),
        });
        expect(runtime.exit).not.toHaveBeenCalled();
      } finally {
        if (rejected.mock.calls.length === 0 && stop) {
          stop();
          await exited;
        }
        if (rejected.mock.calls.length > 0) {
          await settled;
        }
      }
    });
  });

  it("cancels and joins triage before stopping a failed in-process restart", async () => {
    await withIsolatedSignals(async ({ captureSignal }) => {
      const startedTriage = createDeferred();
      const cleanup = createDeferred();
      let triageSignal: AbortSignal | undefined;
      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(createCloseMock()))
        .mockRejectedValueOnce(new Error("replacement startup failed"));
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start,
        runtime,
        onRestartStartupFailure: async (_error, signal) => {
          triageSignal = signal;
          startedTriage.resolve();
          await cleanup.promise;
        },
      });
      await waitForLoopCondition(() => start.mock.calls.length === 1, "expected initial Gateway");
      captureSignal("SIGUSR2")();
      await startedTriage.promise;
      captureSignal("SIGINT")();
      try {
        expect(triageSignal?.aborted).toBe(true);
        expect(runtime.exit).not.toHaveBeenCalled();
      } finally {
        cleanup.resolve();
      }
      await expect(exited).resolves.toBe(0);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  registerGatewayStartupFailureTests();

  it("exits 0 on SIGTERM after graceful close", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, runtime, exited } = await createSignaledLoopHarness();
      let finishLocalServiceStop: (() => void) | undefined;
      const localServiceStopStarted = new Promise<void>((resolveStarted) => {
        stopManagedProviderLocalServices.mockImplementationOnce(
          () =>
            new Promise<void>((resolveStop) => {
              finishLocalServiceStop = resolveStop;
              resolveStarted();
            }),
        );
      });
      hasManagedProviderLocalServices.mockReturnValueOnce(true);
      const sigterm = captureSignal("SIGTERM");
      const { emitDiagnosticsTimelineEvent, flushDiagnosticsTimeline } =
        await import("../../infra/diagnostics-timeline.js");
      const tempDirs = createTempDirTracker();
      const timelinePath = join(tempDirs.make("openclaw-gateway-stop-"), "timeline.jsonl");
      let timelineAtLogFlush: string | undefined;
      close.mockImplementationOnce(async () => {
        emitDiagnosticsTimelineEvent(
          { type: "mark", name: "gateway.stop" },
          {
            env: {
              OPENCLAW_DIAGNOSTICS: "timeline",
              OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
            },
          },
        );
      });
      flushLogger.mockImplementationOnce(async () => {
        expect(runtime.exit).not.toHaveBeenCalled();
        timelineAtLogFlush = existsSync(timelinePath)
          ? readFileSync(timelinePath, "utf8")
          : undefined;
      });

      try {
        sigterm();
        await localServiceStopStarted;

        expect(close).toHaveBeenCalledWith({
          reason: "gateway stopping",
          restartExpectedMs: null,
        });
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(flushLogger).not.toHaveBeenCalled();
        if (!finishLocalServiceStop) {
          throw new Error("managed local service stop did not start");
        }
        finishLocalServiceStop();

        await expect(exited).resolves.toBe(0);
        expect(start).toHaveBeenCalledWith({
          processStartedAt: expect.any(Number),
          startupStartedAt: expect.any(Number),
          requestHotReloadRecovery: requestGatewayRestartWithSignalAdmission,
          hostLifecycle: expect.objectContaining({ request: expect.any(Function) }),
          startupOperation: expect.any(Function),
        });
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expect(stopManagedProviderLocalServices).toHaveBeenCalledOnce();
        expect(flushLogger).toHaveBeenCalledOnce();
        expect(timelineAtLogFlush).toContain('"name":"gateway.stop"');
        expect(armShutdownHardExitWatchdog).not.toHaveBeenCalled();
      } finally {
        flushDiagnosticsTimeline();
        tempDirs.cleanup();
      }
    });
  });

  it("passes the process origin to the initial startup only", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(closeFirst))
        .mockResolvedValueOnce(createGatewayServer(closeSecond));
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await waitForLoopCondition(
        () => start.mock.calls.length === 1,
        "expected initial gateway start",
      );

      expect(start.mock.calls[0]?.[0]).toMatchObject({
        processStartedAt: expect.any(Number),
        startupStartedAt: expect.any(Number),
      });

      captureSignal("SIGUSR2")();
      await waitForLoopCondition(
        () => start.mock.calls.length === 2,
        "expected restart gateway start",
      );
      expect(start.mock.calls[1]?.[0]).not.toHaveProperty("processStartedAt");

      captureSignal("SIGINT")();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("reports a gateway close failure with a nonzero exit", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const error = new TypeError("close owner failed");
      const close = vi.fn<GatewayCloseFn>(async () => {
        throw error;
      });
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      await runLoopWithStart({ start, runtime, completeBoot });
      await waitForStart(started);

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(1);
      expect(completeBoot).toHaveBeenCalledWith({
        outcome: "forced_stop",
        reason: "gateway.stop_close_failed",
      });
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "shutdown step failed (gateway server close): close owner failed",
      );
      expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
        "gateway.stop_close_failed",
        error,
        { shutdownStep: "gateway-server-close" },
      );
    });
  });

  it.each(["close", "native stop"])(
    "records the thrown %s error during a hosted stop",
    async (step) => {
      await withIsolatedSignals(async () => {
        const error = new TypeError("fixture hosted stop failed");
        const { close, start, exited } = await createSignaledLoopHarness(undefined, true);
        if (step === "close") {
          close.mockRejectedValueOnce(error);
        } else {
          hostedStopExecute.mockRejectedValueOnce(error);
        }
        const host = start.mock.calls[0]?.[0]?.hostLifecycle;
        expect(host).toBeDefined();
        await expect(host?.request("stop", () => {})).resolves.toMatchObject({ ok: true });
        await expect(exited).resolves.toBe(1);
        expect(writeDiagnosticStabilityBundleForFailureSync).toHaveBeenCalledWith(
          step === "close" ? "gateway.stop_close_failed" : "gateway.stop_native_unconfirmed",
          error,
          { shutdownStep: step === "close" ? "gateway-server-close" : "hosted-gateway-stop" },
        );
      });
    },
  );

  it("persists an issued close-error log append before forced exit", async () => {
    const logger =
      await vi.importActual<typeof import("../../logging/logger.js")>("../../logging/logger.js");
    const { fileLogTransport } = await import("../../logging/logger-file-transport.js");
    const { appendRegularFile } = await import("@openclaw/fs-safe/advanced");
    const logFile = join(closeLogTempDirs.make("openclaw-close-log-"), "gateway.jsonl");
    const appendAllowed = createDeferredCore();
    logger.setLoggerOverride({ level: "info", file: logFile });
    const fileLogger = logger.getChildLogger({ subsystem: "gateway" });
    fileLogTransport.setAppenderForTests(async (options) => {
      await appendAllowed.promise;
      return appendRegularFile(options);
    });
    gatewayLog.error.mockImplementation((message: string) => {
      fileLogger.error(message);
      void logger.flushLogger();
    });
    flushLogger.mockImplementation(() => logger.flushLogger());
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn<GatewayCloseFn>(() => {
          throw new TypeError("close owner failed");
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const exit = runtime.exit.getMockImplementation();
        let persistedAtExit = "";
        runtime.exit.mockImplementation((code) => {
          persistedAtExit = existsSync(logFile) ? readFileSync(logFile, "utf8") : "";
          exit?.(code);
        });
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        captureSignal("SIGUSR2")();
        await waitForLoopCondition(
          () => runtime.exit.mock.calls.length > 0 || flushLogger.mock.calls.length > 0,
          "close failure did not reach exit or log flush",
        );
        appendAllowed.resolve();
        await expect(exited).resolves.toBe(1);
        expect(persistedAtExit).toContain(
          "shutdown step failed (gateway server close): close owner failed",
        );
      });
    } finally {
      appendAllowed.resolve();
      await logger.flushLogger();
      logger.resetLogger();
      fileLogTransport.resetForTests();
      gatewayLog.error.mockReset();
      flushLogger.mockReset().mockResolvedValue(undefined);
    }
  });

  it.each(["ordinary", "managed restoration"] as const)(
    "exits instead of starting a new lifecycle when restart close fails during %s",
    async (mode) => {
      vi.clearAllMocks();
      if (mode === "managed restoration") {
        consumeGatewayRestartIntent.mockReturnValueOnce({
          reason: "update.run",
          successorOwner: managedUpdateSuccessorOwner,
        });
        cancelManagedServiceUpdateHandoff
          .mockResolvedValueOnce("restart-after-exit")
          .mockResolvedValueOnce("restored-in-process");
        commitManagedServiceUpdateHandoff.mockResolvedValueOnce(false);
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const close = vi.fn<GatewayCloseFn>(async () => {
          throw new TypeError("close owner failed");
        });
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime });
        await waitForStart(started);
        const stop = captureSignal("SIGINT");
        try {
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
            "expected restart close failure to exit or start a new lifecycle",
          );
          expect(runtime.exit).toHaveBeenCalledWith(1);
          await expect(exited).resolves.toBe(1);
          expect(start).toHaveBeenCalledOnce();
          expect(gatewayLog.error).toHaveBeenCalledWith(
            "shutdown step failed (gateway server close): close owner failed",
          );
        } finally {
          if (runtime.exit.mock.calls.length === 0) {
            stop();
          }
          await exited;
        }
      });
    },
  );

  it("completes SIGTERM shutdown while sidecar startup remains unresolved", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const unresolvedSidecarStartup = new Promise<void>(() => {});
      const close = vi.fn<GatewayCloseFn>(async () => {});
      const { start, started } = createSignaledStart(close, unresolvedSidecarStartup);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({ start, runtime });
      await waitForStart(started);

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    });
  });

  it.each([
    { signal: "SIGTERM", trace: undefined },
    { signal: "SIGINT", trace: "0" },
    { signal: "SIGTERM", trace: "1" },
  ] as const)(
    "reports only category counts while direct $signal stop is pending (trace=$trace)",
    async ({ signal, trace }) => {
      vi.clearAllMocks();
      const traceEnv = captureEnv(["OPENCLAW_GATEWAY_RESTART_TRACE"]);
      if (trace === undefined) {
        deleteTestEnvValue("OPENCLAW_GATEWAY_RESTART_TRACE");
      } else {
        process.env.OPENCLAW_GATEWAY_RESTART_TRACE = trace;
      }
      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const { close, runtime, exited } = await createSignaledLoopHarness();
          const { startGatewayRestartTrace } = await import("../../gateway/restart-trace.js");
          startGatewayRestartTrace("prior.sequence");
          const pendingDrain = createDeferredCore();
          const enteredDrain = createDeferredCore();
          const activeSnapshot = createActiveWorkSnapshot(
            {
              queueSize: 1,
              pendingReplies: 2,
              embeddedRuns: 3,
              backgroundExecSessions: 4,
              cronRuns: 5,
              activeTasks: 6,
              rootRequests: 7,
              sessionAdmissions: 8,
              sessionMutations: 9,
              chatRuns: 10,
              queuedTurns: 11,
              terminalPersistence: 12,
              terminalSessions: 13,
            },
            [
              { kind: "root-request", count: 7, message: "private-root-holder-origin" },
              {
                kind: "task",
                count: 6,
                message: "private-task-message",
                task: {
                  taskId: "private-task-id",
                  runId: "private-run-id",
                  status: "running",
                  runtime: "cron",
                  label: "private-task-label",
                  title: "private-task-title",
                },
              },
            ],
          );
          const counts =
            "queueSize=1 pendingReplies=2 embeddedRuns=3 backgroundExecSessions=4 cronRuns=5 activeTasks=6 rootRequests=7 sessionAdmissions=8 sessionMutations=9 chatRuns=10 queuedTurns=11 terminalPersistence=12 terminalSessions=13";
          waitForGatewayActiveWork.mockImplementationOnce(async (_timeoutMs, options) => {
            options?.onSnapshot?.(activeSnapshot);
            enteredDrain.resolve();
            await pendingDrain.promise;
            return { drained: true, snapshot: idleActiveWorkSnapshot };
          });
          let now = Date.now();
          const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
          try {
            captureSignal(signal)();
            await enteredDrain.promise;
            expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
            expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, {
              onSnapshot: expect.any(Function),
            });
            expect(createGatewayActiveWorkSnapshot).not.toHaveBeenCalled();
            expect(close).not.toHaveBeenCalled();
            expect(runtime.exit).not.toHaveBeenCalled();
            expect(gatewayLog.info).toHaveBeenCalledWith(
              `draining active work before stop with timeout 315000ms: ${counts}`,
            );
            captureSignal(signal)();
            expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
            const onSnapshot = waitForGatewayActiveWork.mock.calls[0]?.[1]?.onSnapshot;
            now += 29_999;
            onSnapshot?.(activeSnapshot);
            expect(gatewayLog.warn).not.toHaveBeenCalled();
            now += 1;
            onSnapshot?.(activeSnapshot);
            onSnapshot?.(activeSnapshot);
            expect(gatewayLog.warn).toHaveBeenCalledExactlyOnceWith(
              `still draining active work before stop: ${counts}`,
            );
            clock.mockRestore();
            pendingDrain.resolve();
            await expect(exited).resolves.toBe(0);
            expect(abortEmbeddedAgentRun).not.toHaveBeenCalled();
            expect(gatewayLog.info).toHaveBeenCalledWith(
              "active-work drain settled; beginning server close",
            );
            const output = [...gatewayLog.info.mock.calls, ...gatewayLog.warn.mock.calls]
              .flat()
              .join("\n");
            expect(output).not.toContain("private-");
            expect(output).not.toContain("totalActive");
            expect(output.includes("restart trace:")).toBe(trace === "1");
            const starts = gatewayLog.info.mock.calls
              .flat()
              .filter((line) => String(line).includes("stop.signal.received "));
            expect(starts).toEqual(
              trace === "1"
                ? [`restart trace: stop.signal.received 0.0ms total=0.0ms signal=${signal}`]
                : [],
            );
            expect(close).toHaveBeenCalledWith({
              reason: "gateway stopping",
              restartExpectedMs: null,
            });
          } finally {
            clock.mockRestore();
            pendingDrain.resolve();
            await exited;
          }
        });
      } finally {
        traceEnv.restore();
      }
    },
  );

  it("continues direct shutdown when the bounded active-work drain times out", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const timedOutSnapshot = createActiveWorkSnapshot({ embeddedRuns: 2 }, [
        { kind: "embedded-run", count: 2, message: "2 active embedded run(s)" },
      ]);
      waitForGatewayActiveWork.mockResolvedValueOnce({
        drained: false,
        snapshot: timedOutSnapshot,
      });
      const { close, runtime, exited } = await createSignaledLoopHarness();

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, {
        onSnapshot: expect.any(Function),
      });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "gateway active-work drain timeout reached; proceeding with shutdown: embeddedRuns=2",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  registerShutdownBudgetTests({
    runLoopWithStart,
    systemctl,
    consumeGatewayRestartIntent,
    createGatewayActiveWorkSnapshot,
    waitForGatewayActiveWork,
    gatewayLog,
    writeDiagnosticStabilityBundleForFailureSync,
  });

  it("still closes and exits when the direct-shutdown active-work drain fails", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      waitForGatewayActiveWork.mockRejectedValueOnce(new Error("active-work drain unavailable"));
      const { close, runtime, exited } = await createSignaledLoopHarness();

      captureSignal("SIGTERM")();

      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(315_000, {
        onSnapshot: expect.any(Function),
      });
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "gateway active-work drain failed; proceeding with shutdown: active-work drain unavailable",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  registerShutdownCompletionTests({
    hasManagedProviderLocalServices,
    stopManagedProviderLocalServices,
    createSignaledLoopHarness,
    consumeGatewayRestartIntent,
    managedUpdateSuccessorOwner,
    cancelManagedServiceUpdateHandoff,
    commitManagedServiceUpdateHandoff,
    requestManagedServiceUpdateHandoffPark,
    writeGatewayRestartHandoffSync,
    flushLogger,
    restartGatewayProcessWithFreshPid,
    gatewayLog,
    armShutdownHardExitWatchdog,
    cancelShutdownHardExitWatchdog,
    writeDiagnosticStabilityBundleForFailureSync,
  });

  it("exits after draining a SIGTERM restart intent without starting a successor", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "gateway.restart" });
    createGatewayActiveWorkSnapshot
      .mockReturnValueOnce(
        createActiveWorkSnapshot({ activeTasks: 1 }, [
          { kind: "task", count: 1, message: "1 active background task run(s)" },
        ]),
      )
      .mockReturnValue(idleActiveWorkSnapshot);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = createCloseMock();
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      const completeBoot = vi.fn();
      await runLoopWithStart({ start, runtime, completeBoot });
      await waitForStart(started);
      captureSignal("SIGTERM")();
      await waitForLoopCondition(
        () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
        "SIGTERM restart did not finish",
      );

      expect(start).toHaveBeenCalledOnce();
      await expect(exited).resolves.toBe(0);
      expect(consumeGatewayRestartIntentPayloadSync).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expectRestartCloseCall(close, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(completeBoot).toHaveBeenCalledWith({
        outcome: "planned_restart",
        reason: "restart (SIGTERM: gateway.restart)",
      });
      expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
      expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
      expect(acquireGatewayLock).toHaveBeenCalledOnce();
    });
  });

  it("uses restart intent wait overrides for SIGTERM drain", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ waitMs: 2_500 });
    createGatewayActiveWorkSnapshot
      .mockReturnValueOnce(
        createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
          { kind: "task", count: 1, message: "1 active background task run(s)" },
          { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
        ]),
      )
      .mockReturnValue(idleActiveWorkSnapshot);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(2_500);
      expect(start).toHaveBeenCalledOnce();

      await expect(exited).resolves.toBe(0);
    });
  });

  it("caps reply drain time for unbounded SIGTERM restarts", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ waitMs: 0 });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expectRestartCloseCall(close, 315_000);
      expect(start).toHaveBeenCalledOnce();

      await expect(exited).resolves.toBe(0);
    });
  });

  it("waits for the drain before handing recovery ownership to server close", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ waitMs: 0 });
    const drainStart = createActiveWorkSnapshot({ embeddedRuns: 2 }, [
      { kind: "embedded-run", count: 2, message: "2 active embedded run(s)" },
    ]);
    let releaseDrain: (() => void) | undefined;
    const pendingDrain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    createGatewayActiveWorkSnapshot.mockReturnValueOnce(drainStart);
    waitForGatewayActiveWork.mockImplementationOnce(async () => {
      // Recovery ownership must be collected later by server close, after this
      // window lets active work settle.
      await pendingDrain;
      return { drained: true, snapshot: idleActiveWorkSnapshot };
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();
      await vi.waitFor(() => expect(waitForGatewayActiveWork).toHaveBeenCalledOnce());

      expect(abortEmbeddedAgentRun).toHaveBeenCalledWith(undefined, {
        mode: "compacting",
        reason: "restart",
      });
      expect(close).not.toHaveBeenCalled();

      releaseDrain?.();
      await expect(exited).resolves.toBe(0);

      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(undefined, expect.any(Object));
      expectRestartCloseCall(close, 315_000);
      expect(start).toHaveBeenCalledOnce();
    });
  });

  it("hands timed-out active work to server close", async () => {
    vi.clearAllMocks();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({});
    const timedOutSnapshot = createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
      { kind: "task", count: 1, message: "1 active background task run(s)" },
      { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
    ]);
    createGatewayActiveWorkSnapshot.mockReturnValue(timedOutSnapshot);
    waitForGatewayActiveWork.mockResolvedValueOnce({
      drained: false,
      snapshot: timedOutSnapshot,
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "restart drain budget 300000ms exhausted; cutting short embeddedRuns=1 activeTasks=1",
      );
      expectRestartCloseCall(close, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(start).toHaveBeenCalledOnce();

      await expect(exited).resolves.toBe(0);
    }).finally(() => clock.mockRestore());
  });

  it("skips a second active-work drain after a SIGUSR2 deferral timeout intent", async () => {
    consumeGatewayRestartIntent.mockReturnValueOnce({
      force: true,
      drainBudgetExhausted: true,
      reason: "config reload forced restart",
    });
    createGatewayActiveWorkSnapshot.mockReturnValue(
      createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
        { kind: "task", count: 1, message: "1 active background task run(s)" },
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigint = captureSignal("SIGINT");

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledWith(0, expect.any(Object));
      expect(markGatewayRestartHandled).toHaveBeenCalledOnce();
      expectRestartCloseCall(close, 0);
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  registerGatewayRestartOwnershipTests({
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
  });

  it("restarts after SIGUSR2 even when drain times out, and resets runtime state for the new iteration", async () => {
    vi.clearAllMocks();
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    peekGatewayRestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });
    markUpdateRestartSentinelFailure.mockClear();
    let releaseFirstCronTaskDrain: (() => void) | undefined;
    waitForActiveCronTaskRuns.mockImplementationOnce(
      async () =>
        await new Promise<{ drained: true; active: 0 }>((resolve) => {
          releaseFirstCronTaskDrain = () => resolve({ drained: true, active: 0 });
        }),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const timedOutSnapshot = createActiveWorkSnapshot({ activeTasks: 2, embeddedRuns: 1 }, [
        { kind: "task", count: 2, message: "2 active background task run(s)" },
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]);
      createGatewayActiveWorkSnapshot
        .mockReturnValueOnce(timedOutSnapshot)
        .mockReturnValue(idleActiveWorkSnapshot);
      waitForGatewayActiveWork.mockResolvedValueOnce({
        drained: false,
        snapshot: timedOutSnapshot,
      });

      type StartServer = () => Promise<{
        close: GatewayCloseFn;
      }>;

      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      const lifecycleSlot = resolveGlobalMap<string, number>(
        Symbol("run-loop-lifecycle-slot"),
        (state) => state.clear(),
      );
      const agentEventsActual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
        "../../infra/agent-events.js",
      );
      const firstAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();

      const start = vi.fn<StartServer>();
      let resolveFirst: (() => void) | null = null;
      const startedFirst = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      start.mockImplementationOnce(async () => {
        resolveFirst?.();
        return createGatewayServer(closeFirst);
      });

      let resolveSecond: (() => void) | null = null;
      let secondAgentEventGeneration: string | undefined;
      let secondRestartDrainSignal: AbortSignal | undefined;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecond = resolve;
      });
      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        secondAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
        secondRestartDrainSignal = gatewayWorkAdmissionActual.getGatewayRestartDrainSignal();
        expect(secondRestartDrainSignal.aborted).toBe(false);
        lifecycleSlot.set("second", 2);
        resolveSecond?.();
        return createGatewayServer(closeSecond);
      });

      let resolveThird: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThird = resolve;
      });
      start.mockImplementationOnce(async () => {
        expect(lifecycleSlot.size).toBe(0);
        resolveThird?.();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });

      await startedFirst;
      lifecycleSlot.set("first", 1);
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");
      expect(start).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      restartSignal();

      await waitForLoopCondition(
        () => waitForActiveCronTaskRuns.mock.calls.length === 1,
        "expected first restart to reach cron task drain",
      );
      restartSignal();
      releaseFirstCronTaskDrain?.();
      await startedSecond;
      expect(secondAgentEventGeneration).not.toBe(firstAgentEventGeneration);

      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "restart drain budget 300000ms exhausted; cutting short embeddedRuns=1 activeTasks=2",
      );
      expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      await startedThird;
      expect(secondRestartDrainSignal?.aborted).toBe(true);
      const thirdAgentEventGeneration = agentEventsActual.getAgentEventLifecycleGeneration();
      expect(thirdAgentEventGeneration).not.toBe(secondAgentEventGeneration);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expectRestartCloseCall(closeSecond, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
      expect(markGatewayRestartHandled).toHaveBeenCalledTimes(2);
      expect(abortActiveCronTaskRuns).toHaveBeenCalledTimes(3);
      expect(waitForActiveCronTaskRuns).toHaveBeenCalledTimes(2);
      expect(waitForActiveCronJobs).toHaveBeenCalledTimes(2);
      expect(advanceCronActiveJobGeneration).toHaveBeenCalledTimes(2);
      expect(retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(2);
      expect(resetCronActiveJobs).toHaveBeenCalledTimes(2);
      expect(clearRuntimeConfigSnapshot).toHaveBeenCalledTimes(2);
      expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
      expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
      expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
      expect(reloadTaskRuntimeStateFromStore.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        start.mock.invocationCallOrder[1] ?? Infinity,
      );
      expect(advanceCronActiveJobGeneration.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        abortActiveCronTaskRuns.mock.invocationCallOrder[1] ?? Infinity,
      );
      expect(abortActiveCronTaskRuns.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        closeFirst.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(waitForActiveCronJobs.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity,
      );
      expect(retireActiveCronTaskRunTracking.mock.invocationCallOrder[0] ?? Infinity).toBeLessThan(
        resetCronActiveJobs.mock.invocationCallOrder[0] ?? Infinity,
      );

      sigterm();
      await expect(exited).resolves.toBe(0);
      expect(closeThird).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
    }).finally(() => clock.mockRestore());
  });

  it("advances stale cron active markers after bounded restart cron-run drain", async () => {
    vi.clearAllMocks();
    waitForActiveCronJobs.mockResolvedValueOnce({ drained: false, active: 1 });
    peekGatewayRestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigint = captureSignal("SIGINT");

      restartSignal();
      await waitForLoopCondition(
        () => start.mock.calls.length >= 2,
        "expected SIGUSR2 to trigger restart",
      );

      expect(abortActiveCronTaskRuns).toHaveBeenCalledWith("Gateway restarting.");
      expect(waitForActiveCronTaskRuns).toHaveBeenCalledWith(1_000);
      expect(waitForActiveCronJobs).toHaveBeenCalledWith(1_000);
      expect(advanceCronActiveJobGeneration).toHaveBeenCalledTimes(1);
      expect(retireActiveCronTaskRunTracking).toHaveBeenCalledTimes(1);
      expect(resetCronActiveJobs).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "cron run drain timed out during restart lifecycle reset after retiring old cron admission; 0 task handle(s) and 1 active marker(s) remain after aborting old cron runs",
      );

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("queues SIGUSR2 received before the run-loop installs its restart waiter", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeSecond = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      let releaseFirstStart!: () => void;
      const firstStartMayReturn = new Promise<void>((resolve) => {
        releaseFirstStart = resolve;
      });
      let restartSignal: (() => void) | null = null;
      let resolveSecondStart: (() => void) | null = null;
      const startedSecond = new Promise<void>((resolve) => {
        resolveSecondStart = resolve;
      });
      const start = vi.fn();
      start.mockImplementationOnce(async () => {
        await firstStartMayReturn;
        restartSignal?.();
        await waitForLoopCondition(
          () => markGatewayRestartHandled.mock.calls.length > 0,
          "expected SIGUSR2 handler to consume the restart before startup returned",
        );
        await waitForLoopCondition(
          () => gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed(),
          "expected queued startup restart to mark gateway draining before startup returned",
        );
        return createGatewayServer(closeFirst);
      });
      start.mockImplementationOnce(async () => {
        resolveSecondStart?.();
        return createGatewayServer(closeSecond);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      try {
        releaseFirstStart();

        await waitForLoopCondition(
          () => start.mock.calls.length >= 2,
          "expected queued SIGUSR2 to trigger the second gateway start",
        );
        await startedSecond;
        expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
        expect(markGatewayRestartHandled).toHaveBeenCalledTimes(1);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
        expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(1);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(1);
        expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(1);
      } finally {
        sigterm();
        await expect(exited).resolves.toBe(0);
      }
    });
  });

  it.each([false, true, "repaired-systemd", "repaired-systemd-upgrade"])(
    "exits if a queued startup restart never reaches a close handle (systemd=%s)",
    async (systemd) => {
      vi.clearAllMocks();
      const repaired = typeof systemd === "string";
      const upgrade = systemd === "repaired-systemd-upgrade";
      peekGatewayRestartReason.mockReturnValue(undefined);
      if (systemd) {
        process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
        setPlatform("linux");
        systemctl.mockResolvedValue({
          code: 0,
          stdout: `LoadState=loaded\nTimeoutStopUSec=${repaired ? 30 : 90}s`,
          stderr: "",
        });
      }
      vi.useFakeTimers();
      const clock = vi.spyOn(performance, "now").mockImplementation(() => Date.now());

      try {
        await withIsolatedSignals(async ({ captureSignal }) => {
          const close = vi.fn(async () => {});
          const startupNeverReturns = new Promise<void>(() => {});
          let markStartupEntered: () => void = () => {};
          const startupEntered = new Promise<void>((resolve) => {
            markStartupEntered = resolve;
          });
          const { runtime, exited } = createRuntimeWithExitSignal();
          const completeBoot = vi.fn();
          const start = vi.fn(async () => {
            markStartupEntered();
            await startupNeverReturns;
            return createGatewayServer(close);
          });

          const { runGatewayLoop } = await import("./run-loop.js");
          void runGatewayLoop({
            start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
            runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
            completeBoot,
          });
          await vi.advanceTimersByTimeAsync(0);
          await startupEntered;
          const restartSignal = captureSignal("SIGUSR2");

          if (repaired) {
            const refreshed = {
              code: 0,
              stdout: "LoadState=loaded\nTimeoutStopUSec=330s",
              stderr: "",
            };
            systemctl.mockResolvedValue(refreshed);
            if (upgrade) {
              const query = createDeferredCore<typeof refreshed>();
              systemctl.mockImplementationOnce(() => query.promise);
              restartSignal();
              await vi.advanceTimersByTimeAsync(0);
              peekGatewayRestartReason.mockReturnValue("update.run");
              consumeGatewayRestartIntent.mockReturnValueOnce({
                reason: "update.run",
                force: true,
              });
              restartSignal();
              await vi.advanceTimersByTimeAsync(0);
              expect(gatewayLog.info).toHaveBeenCalledWith(
                "received SIGUSR2 during shutdown; upgrading to update.run",
              );
              query.resolve(refreshed);
            } else {
              consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "update.run" });
              captureSignal("SIGTERM")();
            }
          } else {
            restartSignal();
          }
          await vi.advanceTimersByTimeAsync(0);
          expect(markGatewayRestartHandled).toHaveBeenCalledTimes(upgrade ? 2 : repaired ? 0 : 1);
          expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
          expect(runtime.exit).not.toHaveBeenCalled();

          await vi.advanceTimersByTimeAsync(systemd === true ? 84_999 : 324_999);
          expect(runtime.exit).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);

          await expect(exited).resolves.toBe(1);
          expect(completeBoot).toHaveBeenCalledWith({
            outcome: "forced_stop",
            reason: "gateway.restart_startup_request_timeout",
          });
          expect(close).not.toHaveBeenCalled();
          expect(start).toHaveBeenCalledTimes(1);
          expect(gatewayLog.error).toHaveBeenCalledWith(
            "startup restart request timed out before gateway returned a close handle; exiting for supervisor recovery",
          );
        });
      } finally {
        clock.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    "stop",
    "restart-then-stop",
    "worker-interrupted",
    "cleanup-failure",
    "repaired-systemd",
  ] as const)("joins admitted startup cleanup for %s before exiting", async (scenario) => {
    vi.clearAllMocks();
    if (scenario === "repaired-systemd") {
      process.env.OPENCLAW_SYSTEMD_UNIT = "openclaw-gateway.service";
      systemctl.mockResolvedValue({
        code: 0,
        stdout: "LoadState=loaded\nTimeoutStopUSec=30s",
        stderr: "",
      });
    }
    const { SqliteIntegrityWorkerInterruptedError } =
      await import("../../infra/sqlite-integrity-worker-error.js");
    await withIsolatedSignals(async ({ captureSignal }) => {
      const entered = createDeferredCore<AbortSignal>();
      const cleanup = createDeferredCore();
      const activeDrain = createDeferredCore();
      waitForGatewayActiveWork.mockImplementationOnce(async () => {
        await activeDrain.promise;
        return { drained: true, snapshot: idleActiveWorkSnapshot };
      });
      const cleanupFailure = new Error("startup snapshot cleanup failed");
      const completeBoot = vi.fn();
      const close = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      const { runGatewayLoop } = await import("./run-loop.js");
      const start: Parameters<typeof runGatewayLoop>[0]["start"] = async (options) => {
        await options!.startupOperation!(async (signal) => {
          entered.resolve(signal);
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
          await cleanup.promise;
          throw scenario === "cleanup-failure"
            ? cleanupFailure
            : scenario === "worker-interrupted"
              ? new SqliteIntegrityWorkerInterruptedError("SIGINT", "starting")
              : signal.reason;
        });
        return createGatewayServer(close);
      };
      const loop = runGatewayLoop({ start, runtime, completeBoot });
      const settled = Promise.allSettled([loop]);
      let loopFinished = false;
      void settled.then(() => {
        loopFinished = true;
      });
      const signal = await entered.promise;
      const stopSignal = scenario === "repaired-systemd" ? "SIGTERM" : "SIGINT";
      if (scenario === "repaired-systemd") {
        systemctl.mockResolvedValue({
          code: 0,
          stdout: "LoadState=loaded\nTimeoutStopUSec=330s",
          stderr: "",
        });
        vi.useFakeTimers();
      }
      const flush = async () => {
        if (scenario === "repaired-systemd") {
          await vi.advanceTimersByTimeAsync(0);
        } else {
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
        }
      };
      try {
        if (scenario === "restart-then-stop") {
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => markGatewayRestartHandled.mock.calls.length > 0,
            "expected queued startup restart",
          );
          expect(signal.aborted).toBe(false);
        }
        captureSignal(stopSignal)();
        await flush();
        expect(signal.aborted).toBe(true);
        // A duplicate signal cannot bypass the already admitted cleanup join.
        captureSignal(stopSignal)();
        if (scenario === "repaired-systemd") {
          await vi.advanceTimersByTimeAsync(60_000);
        }
        await flush();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(completeBoot).not.toHaveBeenCalled();
        cleanup.resolve();
        await flush();
        expect(loopFinished).toBe(false);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(completeBoot).not.toHaveBeenCalled();
        activeDrain.resolve();
        await flush();
        await expect(exited).resolves.toBe(scenario === "cleanup-failure" ? 1 : 0);
        if (scenario === "cleanup-failure") {
          expect(await settled).toEqual([{ status: "rejected", reason: cleanupFailure }]);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
            outcome: "forced_stop",
            reason: "gateway.stop_close_failed",
          });
        } else {
          expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
          expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
            outcome: "clean_stop",
            reason: `stop (${stopSignal})`,
          });
        }
        expect(close).not.toHaveBeenCalled();
      } finally {
        if (!signal.aborted) {
          captureSignal("SIGINT")();
        }
        cleanup.resolve();
        activeDrain.resolve();
        await flush();
        await settled;
        vi.useRealTimers();
      }
    });
  });

  it.each([
    { stop: true, signal: "SIGTERM", cleanStop: true },
    { stop: true, signal: "SIGKILL", cleanStop: false },
    { stop: false, signal: "SIGTERM", cleanStop: false },
  ] as const)(
    "joins an accepted stop before classifying an independent startup worker: $stop / $signal",
    async ({ stop, signal, cleanStop }) => {
      const { SqliteIntegrityWorkerInterruptedError } =
        await import("../../infra/sqlite-integrity-worker-error.js");
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore();
        const inspection = createDeferredCore();
        const drainEntered = createDeferredCore();
        const drain = createDeferredCore();
        waitForGatewayActiveWork.mockImplementationOnce(async () => {
          drainEntered.resolve();
          await drain.promise;
          return { drained: true, snapshot: idleActiveWorkSnapshot };
        });
        const failure = new SqliteIntegrityWorkerInterruptedError(signal, "starting");
        const completeBoot = vi.fn();
        const close = createCloseMock();
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.js");
        const loop = runGatewayLoop({
          start: async () => {
            entered.resolve();
            await inspection.promise;
            return createGatewayServer(close);
          },
          runtime,
          completeBoot,
        });
        const settled = Promise.allSettled([loop]);
        try {
          await entered.promise;
          if (stop) {
            captureSignal("SIGTERM")();
            await drainEntered.promise;
          }
          inspection.reject(failure);
          await new Promise<void>((resolve) => {
            setImmediate(resolve);
          });
          expect(runtime.exit).not.toHaveBeenCalled();
          if (cleanStop) {
            expect(completeBoot).not.toHaveBeenCalled();
          }
          drain.resolve();
          if (cleanStop) {
            await expect(exited).resolves.toBe(0);
            expect(await settled).toEqual([{ status: "fulfilled", value: undefined }]);
            expect(completeBoot).toHaveBeenCalledExactlyOnceWith({
              outcome: "clean_stop",
              reason: "stop (SIGTERM)",
            });
          } else {
            expect(await settled).toEqual([{ status: "rejected", reason: failure }]);
            expect(completeBoot).toHaveBeenCalledWith({
              outcome: "startup_failed",
              reason: failure.message,
            });
          }
          expect(close).not.toHaveBeenCalled();
        } finally {
          inspection.reject(failure);
          drain.resolve();
          await settled;
          if (stop) {
            await exited;
          }
        }
      });
    },
  );

  it.each(["stopped", "started"] as const)(
    "refuses retained startup work after %s",
    async (phase) => {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const entered = createDeferredCore<GatewayStartupOperation>();
        const resumeStartup = createDeferredCore();
        const close = createCloseMock();
        const acquireResource = vi.fn(async () => {});
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { runGatewayLoop } = await import("./run-loop.js");
        const start: Parameters<typeof runGatewayLoop>[0]["start"] = async (options) => {
          entered.resolve(options!.startupOperation!);
          if (phase === "stopped") {
            await resumeStartup.promise;
            await options!.startupOperation!(acquireResource);
          }
          return createGatewayServer(close);
        };
        const loop = runGatewayLoop({ start, runtime });
        const observed = loop.catch(() => {});
        const startupOperation = await entered.promise;
        try {
          if (phase === "stopped") {
            captureSignal("SIGINT")();
            await exited;
          } else {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
          }
          await expect(startupOperation(acquireResource)).rejects.toMatchObject({
            name: "AbortError",
          });
          expect(acquireResource).not.toHaveBeenCalled();
        } finally {
          resumeStartup.resolve();
          if (phase === "started") {
            captureSignal("SIGINT")();
            await exited;
          } else {
            await observed;
          }
        }
      });
    },
  );

  it("processes SIGINT immediately before startup returns a server", async () => {
    vi.clearAllMocks();

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const startupNeverReturns = new Promise<void>(() => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const start = vi.fn(async () => {
        await startupNeverReturns;
        return createGatewayServer(close);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const sigint = captureSignal("SIGINT");

      sigint();

      await expect(exited).resolves.toBe(0);
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(1);
    });
  });

  it("lets SIGINT override a queued startup restart before startup returns a server", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const startupNeverReturns = new Promise<void>(() => {});
      const { runtime, exited } = createRuntimeWithExitSignal();
      const start = vi.fn(async () => {
        await startupNeverReturns;
        return createGatewayServer(close);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const restartSignal = captureSignal("SIGUSR2");
      const sigint = captureSignal("SIGINT");

      restartSignal();
      await waitForLoopCondition(
        () => markGatewayRestartHandled.mock.calls.length > 0,
        "expected startup SIGUSR2 to be queued",
      );

      sigint();

      await expect(exited).resolves.toBe(0);
      expect(close).not.toHaveBeenCalled();
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
      expect(start).toHaveBeenCalledTimes(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(1);
      expect(gatewayLog.info).toHaveBeenCalledWith(
        "received SIGINT; overriding pending startup restart with shutdown",
      );
    });
  });

  it("processes queued SIGUSR2 when restart startup fails before returning a server", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeThird = createCloseMock();
      const { runtime, exited } = createRuntimeWithExitSignal();
      let restartSignal: (() => void) | null = null;
      let resolveThirdStart: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThirdStart = resolve;
      });
      const start = vi.fn();
      start.mockResolvedValueOnce(createGatewayServer(closeFirst));
      start.mockImplementationOnce(async () => {
        restartSignal?.();
        await waitForLoopCondition(
          () => markGatewayRestartHandled.mock.calls.length >= 2,
          "expected SIGUSR2 during failed startup to be accepted before startup throws",
        );
        throw new Error("restart startup failed");
      });
      start.mockImplementationOnce(async () => {
        resolveThirdStart?.();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      try {
        restartSignal();

        await waitForLoopCondition(
          () => start.mock.calls.length >= 3,
          "expected queued SIGUSR2 to advance past failed restart startup",
        );
        await startedThird;
        expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
        expect(markGatewayRestartHandled).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
        expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
        expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
        expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
        expect(gatewayLog.error).toHaveBeenCalledWith(
          expect.stringContaining("gateway startup failed: restart startup failed."),
        );
      } finally {
        sigterm();
        await expect(exited).resolves.toBe(0);
      }
    });
  });

  it("processes SIGUSR2 received after restart startup fails before returning a server", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = createCloseMock();
      const closeThird = createCloseMock();
      const { start: firstStart, started } = createSignaledStart(closeFirst);
      const { runtime, exited } = createRuntimeWithExitSignal();
      let resolveThirdStart: (() => void) | null = null;
      const startedThird = new Promise<void>((resolve) => {
        resolveThirdStart = resolve;
      });
      const start = vi.fn();
      start.mockImplementationOnce(firstStart);
      start.mockRejectedValueOnce(new Error("restart startup failed"));
      start.mockImplementationOnce(async () => {
        resolveThirdStart?.();
        return createGatewayServer(closeThird);
      });

      const { runGatewayLoop } = await import("./run-loop.js");
      const loop = runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
      });
      let stop: (() => void) | undefined;
      try {
        await Promise.race([waitForStart(started), loop]);
        stop = captureSignal("SIGTERM");
        const restartSignal = captureSignal("SIGUSR2");
        restartSignal();
        await waitForLoopCondition(
          () =>
            gatewayLog.error.mock.calls.some(([message]) =>
              String(message).includes("gateway startup failed: restart startup failed."),
            ),
          "expected failed restart startup to be logged",
        );
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(start).toHaveBeenCalledTimes(2);

        restartSignal();
        await waitForLoopCondition(
          () => start.mock.calls.length >= 3,
          "expected post-failure SIGUSR2 to retry gateway startup",
        );
        await startedThird;
        expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
        expect(markGatewayRestartHandled).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
        expect(resetGatewaySuspendCoordinatorForLifecycleRestart).toHaveBeenCalledTimes(2);
        expect(resetGatewayRestartStateForInProcessRestart).toHaveBeenCalledTimes(2);
        expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
        expect(acquireGatewayLock).toHaveBeenCalledTimes(3);
      } finally {
        stop?.();
        await Promise.race([expect(exited).resolves.toBe(0), loop]);
      }
    });
  });

  it("keeps the process alive and retries after task runtime state restores fail", async () => {
    vi.clearAllMocks();
    reloadTaskRuntimeStateFromStore.mockReset();
    reloadTaskRuntimeStateFromStore
      .mockImplementationOnce(async () => {
        throw new Error("task-flow registry restore failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("task registry restore failed");
      });
    peekGatewayRestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const closeFirst = createCloseMock();
        const closeSecond = createCloseMock();
        const { start: firstStart, started } = createSignaledStart(closeFirst);
        const { runtime, exited } = createRuntimeWithExitSignal();
        let resolveSecondStart: (() => void) | null = null;
        const startedSecond = new Promise<void>((resolve) => {
          resolveSecondStart = resolve;
        });
        const start = vi
          .fn()
          .mockImplementationOnce(firstStart)
          .mockImplementationOnce(async () => {
            resolveSecondStart?.();
            return createGatewayServer(closeSecond);
          });

        const { runGatewayLoop } = await import("./run-loop.js");
        const loop = runGatewayLoop({
          start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
          runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        });
        let stop: (() => void) | undefined;
        try {
          await Promise.race([waitForStart(started), loop]);
          stop = captureSignal("SIGTERM");
          const restartSignal = captureSignal("SIGUSR2");
          restartSignal();
          await waitForLoopCondition(
            () =>
              gatewayLog.error.mock.calls.some(([message]) =>
                String(message).includes(
                  "gateway startup failed: task-flow registry restore failed.",
                ),
              ),
            "expected failed task-flow registry restore to be logged",
          );

          expectRestartCloseCall(closeFirst, DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS);
          expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(1);
          expect(start).toHaveBeenCalledTimes(1);
          expect(runtime.exit).not.toHaveBeenCalled();

          restartSignal();
          await waitForLoopCondition(
            () =>
              gatewayLog.error.mock.calls.some(([message]) =>
                String(message).includes("gateway startup failed: task registry restore failed."),
              ),
            "expected failed task-registry restore to be logged",
          );

          expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(2);
          expect(start).toHaveBeenCalledTimes(1);
          expect(runtime.exit).not.toHaveBeenCalled();

          restartSignal();
          await startedSecond;

          expect(reloadTaskRuntimeStateFromStore).toHaveBeenCalledTimes(3);
          expect(start).toHaveBeenCalledTimes(2);
          expect(runtime.exit).not.toHaveBeenCalled();
        } finally {
          stop?.();
          await Promise.race([expect(exited).resolves.toBe(0), loop]);
        }

        expect(closeSecond).toHaveBeenCalledWith({
          reason: "gateway stopping",
          restartExpectedMs: null,
        });
      });
    } finally {
      reloadTaskRuntimeStateFromStore.mockReset();
    }
  });

  it("uses the built-in restart drain timeout", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    respawnGatewayProcessForUpdate.mockReturnValue({
      mode: "disabled",
      detail: "OPENCLAW_NO_RESPAWN",
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      createGatewayActiveWorkSnapshot
        .mockReturnValueOnce(
          createActiveWorkSnapshot({ activeTasks: 1, embeddedRuns: 1 }, [
            { kind: "task", count: 1, message: "1 active background task run(s)" },
            { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
          ]),
        )
        .mockReturnValue(idleActiveWorkSnapshot);

      const { start } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(waitForGatewayActiveWork).toHaveBeenCalledOnce();
      expect(waitForGatewayActiveWork.mock.calls[0]?.[0]).toBeLessThanOrEqual(
        DEFAULT_RESTART_DEFERRAL_TIMEOUT_MS,
      );
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);
      expect(start).toHaveBeenCalledTimes(2);
    });
  });

  it("clears stale restart state before routing external SIGUSR2 through the scheduler", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
    isGatewayRestartExternallyAllowed.mockReturnValueOnce(true);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(scheduleGatewayRestart).toHaveBeenCalledWith({
        delayMs: 0,
        reason: "SIGUSR2",
      });
      expect(markGatewayRestartHandled).toHaveBeenCalledTimes(1);
      expect(markGatewayRestartHandled.mock.invocationCallOrder[0]).toBeLessThan(
        scheduleGatewayRestart.mock.invocationCallOrder[0] ?? 0,
      );
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  it("clears the in-flight restart token when an unauthorized SIGUSR2 is ignored", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
    isGatewayRestartExternallyAllowed.mockReturnValueOnce(false);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const restartDrainSignal = gatewayWorkAdmissionActual.getGatewayRestartDrainSignal();

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(markGatewayRestartHandled).toHaveBeenCalledTimes(1);
      expect(scheduleGatewayRestart).not.toHaveBeenCalled();
      expect(restartDrainSignal.aborted).toBe(false);
      expect(gatewayWorkAdmissionActual.isGatewayRestartDraining()).toBe(false);
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.warn).toHaveBeenCalledWith(
        "SIGUSR2 restart ignored (not authorized; commands.restart=false).",
      );
      expect(gatewayLog.warn).toHaveBeenCalledTimes(2);
      expect(gatewayLog.warn).toHaveBeenNthCalledWith(
        2,
        "An unauthorized SIGUSR2 restart signal was received and ignored. " +
          "If a pending gateway restart needs to be applied, run `openclaw gateway restart` " +
          "or restart the gateway through your service manager.",
      );
    });
  });

  it("clears the in-flight restart token when a file intent handles authorized SIGUSR2", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({
      force: true,
      reason: "file-intent restart",
    });
    createGatewayActiveWorkSnapshot.mockReturnValue(
      createActiveWorkSnapshot({ embeddedRuns: 1 }, [
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigint = captureSignal("SIGINT");

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(consumeGatewayRestartAuthorization).toHaveBeenCalledOnce();
      expect(markGatewayRestartHandled).toHaveBeenCalledOnce();
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("calls abortPendingChannelReloads for file-intent restart even when authorization is false", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({
      force: true,
      reason: "file-intent restart",
    });
    consumeGatewayRestartAuthorization.mockReturnValueOnce(false);
    createGatewayActiveWorkSnapshot.mockReturnValue(
      createActiveWorkSnapshot({ embeddedRuns: 1 }, [
        { kind: "embedded-run", count: 1, message: "1 active embedded run(s)" },
      ]),
    );

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigint = captureSignal("SIGINT");

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      // File-intent restart always restarts regardless of authorization.
      // abortPendingChannelReloads must be called to cancel any stale
      // deferred channel reload work before the in-process restart.
      expect(abortPendingChannelReloads).toHaveBeenCalledOnce();
      // Authorization was consumed but returned false.
      expect(consumeGatewayRestartAuthorization).toHaveBeenCalledOnce();
      // markGatewayRestartHandled should NOT be called when auth is false.
      expect(markGatewayRestartHandled).not.toHaveBeenCalled();
      // Restart still proceeds for file-intent regardless of auth result.
      expect(start).toHaveBeenCalledTimes(2);

      sigint();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("releases the lock before exiting on supervised restart", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    const originalTraceEnv = process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
    process.env.OPENCLAW_GATEWAY_RESTART_TRACE = "1";
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const lockRelease = vi.fn(async () => {});
        acquireGatewayLock.mockResolvedValueOnce({
          release: lockRelease,
        });

        restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });

        const exitCallOrder: string[] = [];
        const { runtime, exited } = await createSignaledLoopHarness(exitCallOrder);
        const restartSignal = captureSignal("SIGUSR2");
        lockRelease.mockImplementation(async () => {
          exitCallOrder.push("lockRelease");
        });

        restartSignal();

        await exited;
        expect(lockRelease).toHaveBeenCalledTimes(1);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expect(exitCallOrder).toEqual(["lockRelease", "exit"]);
        const [respawnOpts] = restartGatewayProcessWithFreshPid.mock.calls[0] ?? [];
        expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_STARTED_AT_MS).toMatch(/^\d/u);
        expect(respawnOpts?.env?.OPENCLAW_GATEWAY_RESTART_TRACE_LAST_AT_MS).toMatch(/^\d/u);
        expect(writeGatewayRestartHandoffSync).toHaveBeenCalledOnce();
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      if (originalTraceEnv === undefined) {
        delete process.env.OPENCLAW_GATEWAY_RESTART_TRACE;
      } else {
        process.env.OPENCLAW_GATEWAY_RESTART_TRACE = originalTraceEnv;
      }
    }
  });

  it("returns the supervisor-owned restart code after releasing the lock", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_WINDOWS_TASK_NAME = "OpenClaw Gateway";

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const lockRelease = vi.fn(async () => {});
        acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
        restartGatewayProcessWithFreshPid.mockReturnValueOnce({
          mode: "supervised",
          exitCode: 75,
        });

        const { runtime, exited } = await createSignaledLoopHarness();
        captureSignal("SIGUSR2")();

        await expect(exited).resolves.toBe(75);
        expect(lockRelease).toHaveBeenCalledOnce();
        expect(runtime.exit).toHaveBeenCalledWith(75);
      });
    } finally {
      delete process.env.OPENCLAW_WINDOWS_TASK_NAME;
    }
  });

  it("waits briefly before exiting on launchd supervised restart", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        handoffSpawned: Promise.resolve(true),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");

        vi.useFakeTimers();
        restartSignal();
        await vi.advanceTimersByTimeAsync(1499);
        expect(runtime.exit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        await expect(exited).resolves.toBe(0);
        expect(runtime.exit).toHaveBeenCalledWith(0);
        expectRestartHandoffCall({
          restartKind: "full-process",
          reason: undefined,
          supervisorMode: "launchd",
        });
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("falls back in-process when the launchd restart handoff fails to spawn", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    try {
      setPlatform("darwin");
      process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "supervised",
        handoffSpawned: Promise.resolve(false),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        vi.useFakeTimers();
        restartSignal();
        await vi.advanceTimersByTimeAsync(1500);

        expect(start).toHaveBeenCalledTimes(2);
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "launchd restart handoff failed to spawn; falling back to in-process restart",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      vi.useRealTimers();
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
      if (originalPlatformDescriptor) {
        Object.defineProperty(process, "platform", originalPlatformDescriptor);
      }
    }
  });

  it("leaves the successor to launchd after a SIGTERM restart intent", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "gateway.restart" });
    setPlatform("darwin");
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
      handoffSpawned: Promise.resolve(true),
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { start, exited } = await createSignaledLoopHarness();
      captureSignal("SIGTERM")();
      await expect(exited).resolves.toBe(0);
      expect(start).toHaveBeenCalledOnce();
      expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
      expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
    });
  });

  it("records external ownership even when native supervisor markers are inherited", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    process.env.OPENCLAW_LAUNCHD_LABEL = "ai.openclaw.gateway";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");

        restartSignal();

        await expect(exited).resolves.toBe(0);
        expectRestartHandoffCall({
          restartKind: "full-process",
          reason: undefined,
          supervisorMode: "external",
        });
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      delete process.env.OPENCLAW_LAUNCHD_LABEL;
    }
  });

  it("falls back in-process when an external restart handoff cannot be persisted", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({
      mode: "supervised",
    });
    writeGatewayRestartHandoffSync.mockReturnValueOnce(null);

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        restartSignal();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "external handoff failure did not restart in-process",
        );

        expect(runtime.exit).not.toHaveBeenCalled();
        expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
        expect(gatewayLog.warn).toHaveBeenCalledWith(
          "external supervisor restart handoff could not be persisted; falling back to in-process restart",
        );

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("forwards lockPort to initial and restart lock acquisitions", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const closeFirst = vi.fn(async () => {});
      const closeSecond = vi.fn(async () => {});
      const closeThird = vi.fn(async () => {});
      const { runtime, exited } = createRuntimeWithExitSignal();

      const start = vi
        .fn()
        .mockResolvedValueOnce(createGatewayServer(closeFirst))
        .mockResolvedValueOnce(createGatewayServer(closeSecond))
        .mockResolvedValueOnce(createGatewayServer(closeThird));
      const { runGatewayLoop } = await import("./run-loop.js");
      void runGatewayLoop({
        start: start as unknown as Parameters<typeof runGatewayLoop>[0]["start"],
        runtime: runtime as unknown as Parameters<typeof runGatewayLoop>[0]["runtime"],
        lockPort: 18789,
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      restartSignal();

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(1, {
        port: 18789,
        listenerMode: "foreground",
        supervisor: null,
      });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(2, {
        port: 18789,
        listenerMode: "foreground",
        supervisor: null,
      });
      expect(acquireGatewayLock).toHaveBeenNthCalledWith(3, {
        port: 18789,
        listenerMode: "foreground",
        supervisor: null,
      });

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it.each([
    { env: { OPENCLAW_SUPERVISOR_MODE: "external" }, supervisor: { kind: "external", name: null } },
    {
      env: { OPENCLAW_WINDOWS_TASK_NAME: "Fixture Gateway" },
      supervisor: { kind: "schtasks", name: "Fixture Gateway" },
    },
  ])(
    "publishes the $supervisor.kind supervisor identity at lock acquisition",
    async ({ env, supervisor }) => {
      setPlatform("win32");
      for (const [key, value] of Object.entries(env)) {
        vi.stubEnv(key, value);
      }
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { exited } = await createSignaledLoopHarness();
        expect(acquireGatewayLock).toHaveBeenCalledWith(
          expect.objectContaining({
            listenerMode: "supervised",
            supervisor,
          }),
        );
        captureSignal("SIGTERM")();
        await expect(exited).resolves.toBe(0);
      });
    },
  );

  it("exits when lock reacquire fails during in-process restart fallback", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue(undefined);

    await withIsolatedSignals(async ({ captureSignal }) => {
      const lockRelease = vi.fn(async () => {});
      acquireGatewayLock
        .mockResolvedValueOnce({
          release: lockRelease,
        })
        .mockRejectedValueOnce(new Error("lock timeout"));

      restartGatewayProcessWithFreshPid.mockReturnValueOnce({
        mode: "disabled",
      });

      const { start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      restartSignal();

      await expect(exited).resolves.toBe(1);
      expect(acquireGatewayLock).toHaveBeenCalledTimes(2);
      expect(start).toHaveBeenCalledTimes(1);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "failed to reacquire gateway lock for in-process restart: Error: lock timeout",
      );
    });
  });

  registerUpdateRespawnProgressTests({
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
  });

  registerUpdateRespawnTests({
    spawnProcess,
    waitForGatewayActiveWork,
    peekGatewayRestartReason,
    respawnGatewayProcessForUpdate,
    waitForGatewayHealthyRestart,
    respawnHealth,
    readRestartSentinelReadOnly,
    writeRestartSentinelIfUnchanged,
    restartGatewayProcessWithFreshPid,
    withIsolatedSignals,
    createSignaledStart,
    createRuntimeWithExitSignal,
    runLoopWithStart,
    waitForStart,
    waitForLoopCondition,
    createSignaledLoopHarness,
    markUpdateRestartSentinelFailure,
    writeGatewayRestartHandoffSync,
    consumeGatewayRestartIntent,
    managedUpdateSuccessorOwner,
    claimManagedServiceUpdateHandoff,
    isForegroundUpdateHandoff,
    requestManagedServiceUpdateHandoffPark,
    hasManagedProviderLocalServices,
    stopManagedProviderLocalServices,
    cancelManagedServiceUpdateHandoff,
    acquireGatewayLock,
    completeForegroundUpdateHandoffAfterClose,
    captureForegroundUpdateHandoffStop,
    hostedStopPrepare,
    killProcessTree,
    flushLogger,
    gatewayLog,
    isGatewayWorkAdmissionClosed: () => gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed(),
    consumeGatewayRestartIntentPayloadSync,
    commitManagedServiceUpdateHandoff,
    setPlatform,
    expectRestartHandoffCall,
    originalPlatformDescriptor,
  });

  it.each(["update.run", "update.auto"])(
    "keeps SIGTERM restart ownership when %s arrives during shutdown",
    async (reason) => {
      vi.clearAllMocks();
      consumeGatewayRestartIntentPayloadSync.mockReturnValueOnce({ reason: "gateway.restart" });
      peekGatewayRestartReason.mockReturnValueOnce(reason);
      const closing = createDeferred();
      const close = vi.fn<GatewayCloseFn>(() => closing.promise);

      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        const completeBoot = vi.fn();
        await runLoopWithStart({ start, runtime, completeBoot });
        await waitForStart(started);
        try {
          captureSignal("SIGTERM")();
          await waitForLoopCondition(() => close.mock.calls.length === 1, "close did not start");
          captureSignal("SIGUSR2")();
          await waitForLoopCondition(
            () => markGatewayRestartHandled.mock.calls.length === 1,
            "update signal was not handled",
          );
          closing.resolve();
          await waitForLoopCondition(
            () => runtime.exit.mock.calls.length > 0 || start.mock.calls.length > 1,
            "SIGTERM restart did not finish",
          );
          expect(start).toHaveBeenCalledOnce();
          await expect(exited).resolves.toBe(0);
          expect(completeBoot).toHaveBeenCalledWith({
            outcome: "planned_restart",
            reason: "restart (SIGTERM: gateway.restart)",
          });
          expect(restartGatewayProcessWithFreshPid).not.toHaveBeenCalled();
          expect(respawnGatewayProcessForUpdate).not.toHaveBeenCalled();
        } finally {
          closing.resolve();
        }
      });
    },
  );

  it("upgrades an accepted restart when an update arrives during shutdown", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValueOnce("config.patch").mockReturnValueOnce("update.auto");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });

    let releaseClose: () => void = () => {};
    const close = vi.fn<GatewayCloseFn>(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    setPlatform("freebsd");
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, started } = createSignaledStart(close);
        const { runtime, exited } = createRuntimeWithExitSignal();
        await runLoopWithStart({ start, runtime, ownsProcessLifecycle: true });
        await waitForStart(started);
        const restartSignal = captureSignal("SIGUSR2");

        restartSignal();
        await waitForLoopCondition(
          () => close.mock.calls.length === 1,
          "restart close did not start",
        );
        restartSignal();
        await waitForLoopCondition(
          () =>
            gatewayLog.info.mock.calls.some(([message]) =>
              String(message).includes("upgrading to update.auto"),
            ),
          "accepted restart was not upgraded",
        );

        releaseClose();
        await expect(exited).resolves.toBe(0);
        expect(restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
        expectRestartHandoffCall({
          restartKind: "update-process",
          reason: "update.auto",
          supervisorMode: "external",
        });
      });
    } finally {
      releaseClose();
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("reads an update upgrade after asynchronous lock release", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValueOnce("config.patch").mockReturnValueOnce("update.auto");
    restartGatewayProcessWithFreshPid.mockReturnValueOnce({ mode: "supervised" });

    let releaseLock: () => void = () => {};
    const lockReleaseBlocked = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const lockRelease = vi.fn(async () => {
      await lockReleaseBlocked;
    });
    acquireGatewayLock.mockResolvedValueOnce({ release: lockRelease });
    process.env.OPENCLAW_SUPERVISOR_MODE = "external";
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        restartSignal();
        await waitForLoopCondition(
          () => lockRelease.mock.calls.length === 1,
          "restart did not reach lock release",
        );
        restartSignal();
        await waitForLoopCondition(
          () =>
            gatewayLog.info.mock.calls.some(([message]) =>
              String(message).includes("upgrading to update.auto"),
            ),
          "lock-release restart was not upgraded",
        );

        releaseLock();
        await expect(exited).resolves.toBe(0);
        expect(restartGatewayProcessWithFreshPid).toHaveBeenCalledOnce();
        expect(runtime.exit).toHaveBeenCalledWith(0);
      });
    } finally {
      releaseLock();
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
    }
  });

  it("recovers in process after exactly cancelling a replacement managed owner before exit", async () => {
    vi.clearAllMocks();
    const replacementOwner = { ...managedUpdateSuccessorOwner, handoffId: "replacement-handoff" };
    consumeGatewayRestartIntent
      .mockReturnValueOnce({ reason: "update.run", successorOwner: managedUpdateSuccessorOwner })
      .mockReturnValueOnce({ reason: "update.auto", successorOwner: replacementOwner });
    cancelManagedServiceUpdateHandoff
      .mockResolvedValueOnce("restored-in-process")
      .mockResolvedValueOnce("restored-in-process");

    let releaseCommit: () => void = () => {};
    const commitBlocked = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    commitManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
      await commitBlocked;
      return true;
    });
    setPlatform("linux");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";
    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");
        restartSignal();
        await waitForLoopCondition(
          () => commitManagedServiceUpdateHandoff.mock.calls.length === 1,
          "managed owner did not reach its final helper commit",
        );
        restartSignal();
        await waitForLoopCondition(
          () => consumeGatewayRestartIntent.mock.calls.length === 2,
          "replacement owner was not admitted before exit",
        );
        releaseCommit();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "replacement managed owner cancellation did not reopen gateway admission",
        );

        expect(requestManagedServiceUpdateHandoffPark).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(
          1,
          managedUpdateSuccessorOwner,
        );
        expect(cancelManagedServiceUpdateHandoff).toHaveBeenNthCalledWith(2, replacementOwner);
        expect(commitManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
          "update",
        );
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(start).toHaveBeenCalledTimes(2);
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      releaseCommit();
      delete process.env.OPENCLAW_SERVICE_MARKER;
      delete process.env.OPENCLAW_SERVICE_KIND;
    }
  });

  it("reopens admission after a broken control pipe waits for the exact helper to exit", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntent.mockReturnValueOnce({
      reason: "update.run",
      successorOwner: managedUpdateSuccessorOwner,
    });
    requestManagedServiceUpdateHandoffPark.mockResolvedValueOnce(false);
    let releaseHelperExit: () => void = () => {};
    const helperExit = new Promise<void>((resolve) => {
      releaseHelperExit = resolve;
    });
    cancelManagedServiceUpdateHandoff.mockImplementationOnce(async () => {
      await helperExit;
      return "restored-in-process";
    });
    setPlatform("linux");
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    process.env.OPENCLAW_SERVICE_KIND = "gateway";

    try {
      await withIsolatedSignals(async ({ captureSignal }) => {
        const { start, runtime, exited } = await createSignaledLoopHarness();
        const restartSignal = captureSignal("SIGUSR2");
        const sigint = captureSignal("SIGINT");

        restartSignal();
        await waitForLoopCondition(
          () => cancelManagedServiceUpdateHandoff.mock.calls.length === 1,
          "broken helper control pipe did not begin exact-owner cancellation",
        );
        expect(start).toHaveBeenCalledOnce();
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(true);
        releaseHelperExit();
        await waitForLoopCondition(
          () => start.mock.calls.length === 2,
          "broken helper control pipe left the gateway permanently draining",
        );

        expect(cancelManagedServiceUpdateHandoff).toHaveBeenCalledExactlyOnceWith(
          managedUpdateSuccessorOwner,
        );
        expect(commitManagedServiceUpdateHandoff).not.toHaveBeenCalled();
        expect(runtime.exit).not.toHaveBeenCalled();
        expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

        sigint();
        await expect(exited).resolves.toBe(0);
      });
    } finally {
      releaseHelperExit();
      delete process.env.OPENCLAW_SERVICE_MARKER;
      delete process.env.OPENCLAW_SERVICE_KIND;
    }
  });

  it("probes the configured gateway host for update respawn health", async () => {
    vi.clearAllMocks();
    peekGatewayRestartReason.mockReturnValue("update.run");
    respawnGatewayProcessForUpdate.mockReturnValueOnce({
      mode: "spawned",
      pid: 7778,
      child: createUpdateRespawnChild(7778),
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const close = vi.fn(async () => {});
      const { start, started } = createSignaledStart(close);
      const { runtime, exited } = createRuntimeWithExitSignal();
      await runLoopWithStart({
        start,
        runtime,
        lockPort: 18789,
        healthHost: "10.0.0.25",
      });
      await waitForStart(started);
      const restartSignal = captureSignal("SIGUSR2");

      restartSignal();

      await expect(exited).resolves.toBe(0);
      expect(waitForGatewayHealthyRestart).toHaveBeenCalledWith(
        expect.objectContaining({ port: 18789, probeHosts: ["10.0.0.25"] }),
      );
    });
  });

  it.each([
    { healthy: false, waitOutcome: "stopped-free" },
    { healthy: true, waitOutcome: "timeout" },
  ] as const)(
    "recovers a dead update child when readiness ends $waitOutcome",
    async ({ healthy, waitOutcome }) => {
      vi.clearAllMocks();
      peekGatewayRestartReason.mockReturnValue("update.run");
      const kill = vi.fn();
      respawnGatewayProcessForUpdate.mockReturnValueOnce({
        mode: "spawned",
        pid: 8888,
        child: Object.assign(createUpdateRespawnChild(8888), { kill, exitCode: 1 }),
      });

      await withIsolatedSignals(async ({ captureSignal }) => {
        waitForGatewayHealthyRestart.mockResolvedValueOnce(
          respawnHealth({
            healthy,
            waitOutcome,
            runtime: { status: "stopped" },
          }),
        );
        const closeFirst = vi.fn(async () => {});
        const closeSecond = vi.fn(async () => {});
        const { runtime, exited } = createRuntimeWithExitSignal();
        const { start, started } = createSignaledStart(closeFirst);

        await runLoopWithStart({ start, runtime, lockPort: 18789 });
        await waitForStart(started);
        start.mockResolvedValue(createGatewayServer(closeSecond));
        const restartSignal = captureSignal("SIGUSR2");
        const sigterm = captureSignal("SIGTERM");

        restartSignal();
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });

        expect(kill).toHaveBeenCalledTimes(1);
        expect(markUpdateRestartSentinelFailure).toHaveBeenCalledWith("restart-unhealthy");
        expect(start).toHaveBeenCalledTimes(2);

        sigterm();
        await expect(exited).resolves.toBe(0);
      });
    },
  );

  it("catches SIGTERM handler errors, logs them, and falls back to stop (#83131)", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("dynamic import failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, runtime, exited } = await createSignaledLoopHarness();
      const sigterm = captureSignal("SIGTERM");

      sigterm();

      await expect(exited).resolves.toBe(0);
      expect(gatewayLog.error).toHaveBeenCalledWith(
        "failed to handle SIGTERM: Error: dynamic import failed",
      );
      expect(close).toHaveBeenCalledWith({
        reason: "gateway stopping",
        restartExpectedMs: null,
      });
      expect(runtime.exit).toHaveBeenCalledWith(0);
    });
  });

  it("catches SIGUSR2 handler errors even when token cleanup throws (#83131)", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("lifecycle module corrupted");
    });
    markGatewayRestartHandled.mockImplementationOnce(() => {
      throw new Error("recovery import also failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(gatewayLog.error).toHaveBeenCalledWith(
        "SIGUSR2 handler failed: lifecycle module corrupted",
      );
      expect(markGatewayRestartHandled).toHaveBeenCalled();
      expect(rollbackGatewayRestartSignalAdmission).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("catches SIGUSR2 handler errors, clears restart token, and does not crash (#83131)", async () => {
    vi.clearAllMocks();
    consumeGatewayRestartIntentPayloadSync.mockImplementationOnce(() => {
      throw new Error("restartSignal lifecycle import failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      // The catch handler clears the restart token from the eagerly-loaded
      // lifecycle runtime, so wait for the async signal body to reject.
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(gatewayLog.error).toHaveBeenCalledWith(
        "SIGUSR2 handler failed: restartSignal lifecycle import failed",
      );
      // Restart token must be cleared so future SIGUSR2 restarts are not
      // permanently coalesced as "already in-flight".
      expect(markGatewayRestartHandled).toHaveBeenCalled();
      expect(rollbackGatewayRestartSignalAdmission).toHaveBeenCalledOnce();
      expect(close).not.toHaveBeenCalled();
      expect(start).toHaveBeenCalledTimes(1);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });

  it("recloses restart admission after a failed SIGUSR2 handler rolls it back", async () => {
    vi.clearAllMocks();
    markGatewayRestartHandled.mockImplementationOnce(() => {
      throw new Error("restart token cleanup failed");
    });

    await withIsolatedSignals(async ({ captureSignal }) => {
      const { close, start, exited } = await createSignaledLoopHarness();
      const restartSignal = captureSignal("SIGUSR2");
      const sigterm = captureSignal("SIGTERM");

      restartSignal();
      await waitForLoopCondition(
        () => rollbackGatewayRestartSignalAdmission.mock.calls.length === 1,
        "failed SIGUSR2 handler did not roll back restart admission",
      );

      restartSignal();
      await waitForLoopCondition(
        () => start.mock.calls.length === 2,
        "second SIGUSR2 did not start a restart",
      );

      expect(close).toHaveBeenCalledTimes(1);
      expect(gatewayWorkAdmissionActual.isGatewayWorkAdmissionClosed()).toBe(false);

      sigterm();
      await expect(exited).resolves.toBe(0);
    });
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
