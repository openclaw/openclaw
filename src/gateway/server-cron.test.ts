// Gateway cron tests cover isolated agent turns, heartbeat wakeups, completion
// delivery, lifecycle cleanup, hook emission, and SSRF-guarded webhooks.
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRequireRecord } from "../../test/helpers/record.js";
import { AgentDeletionCommitUncertainError } from "../agents/agent-deletion-errors.js";
import {
  abortAndDrainEmbeddedAgentRun,
  detachActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  attachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type * as deliveryTarget from "../cron/isolated-agent/delivery-target.js";
import { CronService } from "../cron/service.js";
import { waitForCronRunQueue } from "../cron/service/run-queue.js";
import { onTimer as onCronTimer } from "../cron/service/timer.test-support.js";
import { resolveSelectedCronJobsStorePath } from "../cron/store/paths.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";
import {
  beginGatewayRestartSignalAdmission,
  getActiveGatewayRootWorkCount,
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { registerGatewayCronCompletionTests } from "./server-cron-completion.test-support.js";
import { registerGatewayCronContextTests } from "./server-cron.context.test-support.js";
import { registerGatewayCronHandoffTests } from "./server-cron.handoff.test-support.js";
import {
  registerGatewayCronMutationAuthorityTests,
  registerGatewayCronStreamMutationTests,
} from "./server-cron.mutation-lifecycle.test-support.js";
import { createWatchedRun, runExit } from "./server-cron.process.test-support.js";
import { registerGatewayCronQueueTests } from "./server-cron.queue.test-support.js";
import { registerGatewayCronSystemJobTests } from "./server-cron.system-jobs.test-support.js";

type RunCronIsolatedAgentTurnMock = (params: {
  abortSignal?: AbortSignal;
}) => Promise<{ status: "ok"; summary: string }>;

const {
  enqueueSystemEventMock,
  systemEventReceiptRemoveMock,
  requestHeartbeatMock,
  requestHeartbeatAndWaitMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  sendCronAnnouncePayloadStrictMock,
  resolveDeliveryTargetMock,
  runCronIsolatedAgentTurnMock,
  getGlobalHookRunnerMock,
  runCronChangedMock,
  abortAndDrainEmbeddedAgentRunMock,
  captureSessionMcpRuntimeRetirementMock,
  retireSessionMcpRuntimeMock,
  requestSafeGatewayRestartMock,
  getProcessSupervisorMock,
  createCronScriptRuntimeMock,
  cronTriggerEvaluatorMock,
  cronScriptExecutorMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  systemEventReceiptRemoveMock: vi.fn(() => true),
  requestHeartbeatMock: vi.fn(),
  requestHeartbeatAndWaitMock: vi.fn<(...args: unknown[]) => Promise<HeartbeatRunResult>>(
    async () => ({ status: "ran", durationMs: 1 }),
  ),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  sendCronAnnouncePayloadStrictMock: vi.fn<
    typeof import("../cron/delivery.js").sendCronAnnouncePayloadStrict
  >(async ({ payload }) => ({
    status: "sent",
    payloads: Array.isArray(payload) ? payload : [payload],
    results: [{ channel: "telegram", messageId: "cron-message" }],
    receipt: {
      primaryPlatformMessageId: "cron-message",
      platformMessageIds: ["cron-message"],
      parts: [{ platformMessageId: "cron-message", kind: "text", index: 0 }],
      sentAt: 0,
    },
  })),
  resolveDeliveryTargetMock: vi.fn<typeof deliveryTarget.resolveDeliveryTarget>(async (...args) => {
    const { resolveCronTestDeliveryTarget } =
      await import("./server-cron.delivery.test-support.js");
    return resolveCronTestDeliveryTarget(...args);
  }),
  runCronIsolatedAgentTurnMock: vi.fn<RunCronIsolatedAgentTurnMock>(async () => ({
    status: "ok",
    summary: "ok",
  })),
  runCronChangedMock: vi.fn(async (_event: unknown, _context?: unknown) => {}),
  getGlobalHookRunnerMock: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "cron_changed",
    runCronChanged: runCronChangedMock,
  })),
  abortAndDrainEmbeddedAgentRunMock: vi.fn<
    typeof import("../agents/embedded-agent.js").abortAndDrainEmbeddedAgentRun
  >(async () => ({ aborted: true, drained: true, forceCleared: false })),
  captureSessionMcpRuntimeRetirementMock:
    vi.fn<
      typeof import("../agents/agent-bundle-mcp-manager-api.js").captureSessionMcpRuntimeRetirement
    >(),
  retireSessionMcpRuntimeMock: vi.fn(async (assertCurrent: () => void) => assertCurrent()),
  requestSafeGatewayRestartMock: vi.fn(() => {
    throw new Error("Cron must back off without restarting the Gateway");
  }),
  getProcessSupervisorMock: vi.fn(() => ({
    acquireScopeCleanup: vi.fn(() => async () => {}),
    spawn: vi.fn(),
    cancelScope: vi.fn(),
  })),
  createCronScriptRuntimeMock: vi.fn(),
  cronTriggerEvaluatorMock: vi.fn(),
  cronScriptExecutorMock: vi.fn(),
}));

function enqueueSystemEvent(text: string, opts?: unknown) {
  return enqueueSystemEventMock(text, opts);
}

function enqueueSystemEventWithReceipt(text: string, opts?: unknown) {
  const result = enqueueSystemEventMock(text, opts);
  if (result === false || result === null) {
    return null;
  }
  return systemEventReceiptRemoveMock;
}

vi.mock("../infra/system-events.js", () => ({ enqueueSystemEvent, enqueueSystemEventWithReceipt }));

vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: requestHeartbeatMock,
  requestHeartbeatAndWait: requestHeartbeatAndWaitMock,
}));

vi.mock("../infra/heartbeat-runner.js", () => ({
  // Heartbeat monitor convergence enumerates agents at cron start; keep it
  // inert so these tests exercise cron wiring, not heartbeat enrollment.
  resolveHeartbeatAgents: () => [],
  resolveHeartbeatSchedulerSeed: () => "test-seed",
}));

vi.mock("../infra/restart-coordinator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/restart-coordinator.js")>()),
  scheduleSafeGatewayRestart: requestSafeGatewayRestartMock,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: fetchWithSsrFGuardMock }));

vi.mock("../cron/delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cron/delivery.js")>()),
  sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock,
}));

vi.mock("../cron/isolated-agent/delivery-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof deliveryTarget>()),
  resolveDeliveryTarget: resolveDeliveryTargetMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

vi.mock("../agents/embedded-agent.js", () => ({
  abortAndDrainEmbeddedAgentRun: abortAndDrainEmbeddedAgentRunMock,
}));

vi.mock("../agents/agent-bundle-mcp-manager-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-bundle-mcp-manager-api.js")>()),
  captureSessionMcpRuntimeRetirement: captureSessionMcpRuntimeRetirementMock,
}));

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: getProcessSupervisorMock,
}));

vi.mock("../cron/trigger-script.js", () => ({
  createCronScriptRuntime: createCronScriptRuntimeMock,
}));

import {
  abortActiveCronTaskRuns,
  registerActiveCronTaskRun,
  trackActiveCronTaskRunSettlement,
  getSuspensionVisibleCronTaskRunCount,
} from "../cron/service/active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "../cron/service/active-run-cancellation.test-support.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import { fireOnExitJob } from "./server-cron-event-dispatch.js";
import { buildGatewayCronService as buildGatewayCronServiceRuntime } from "./server-cron.js";

function buildGatewayCronService(
  params: Omit<Parameters<typeof buildGatewayCronServiceRuntime>[0], "storePath">,
) {
  const legacyStore = (params.cfg.cron as { store?: unknown } | undefined)?.store;
  const env =
    typeof legacyStore === "string"
      ? {
          ...process.env,
          OPENCLAW_SKIP_CRON: "0",
          OPENCLAW_STATE_DIR: path.dirname(legacyStore),
        }
      : (params.env ?? process.env);
  return buildGatewayCronServiceRuntime({
    ...params,
    env,
    storePath: resolveSelectedCronJobsStorePath(
      typeof legacyStore === "string" ? legacyStore : undefined,
      env,
    ),
  });
}

function createCronConfig(name: string, overrides: OpenClawConfig = {}): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: { mainKey: "main" },
    cron: { store: path.join(tmpDir, "cron.json") },
    ...overrides,
  } as OpenClawConfig;
}

function createTriggerConfig(name: string) {
  const cfg = createCronConfig(name);
  cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
  return cfg;
}

function createMultiAgentConfig(name: string) {
  return createCronConfig(name, {
    agents: { entries: { primary: { model: "test/primary" }, ops: { model: "test/ops" } } },
  });
}

type CronServiceOverrides = Partial<
  Omit<Parameters<typeof buildGatewayCronService>[0], "cfg" | "deps">
>;

function createCronService(cfg: OpenClawConfig, overrides: CronServiceOverrides = {}) {
  return buildGatewayCronService({
    cfg,
    deps: {} as CliDeps,
    broadcast: () => {},
    ...overrides,
    scheduler: overrides.scheduler ?? createTestGatewayScheduler(),
  });
}

function loadCronService(cfg: OpenClawConfig, overrides: CronServiceOverrides = {}) {
  loadConfigMock.mockReturnValue(cfg);
  return createCronService(cfg, overrides);
}

type CronJobOverrides = Partial<Omit<CronJobCreate, "name" | "payload">>;

function cronJob(
  name: string,
  payload: CronJobCreate["payload"],
  overrides: CronJobOverrides = {},
): CronJobCreate {
  return {
    name,
    enabled: true,
    schedule: { kind: "at", at: new Date(1).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload,
    ...overrides,
  };
}

type CronServiceFixture = ReturnType<typeof createCronService>;

function getConcreteCron(service: CronServiceFixture): CronService {
  if (!(service.cron instanceof CronService)) {
    throw new Error("expected the concrete Gateway cron owner");
  }
  return service.cron;
}

async function withCronService(
  cfg: OpenClawConfig,
  run: (state: CronServiceFixture) => void | Promise<void>,
  overrides: CronServiceOverrides = {},
) {
  const state = loadCronService(cfg, overrides);
  try {
    await run(state);
  } finally {
    state.cron.stop();
  }
}

function getCronState(service: CronServiceFixture): CronServiceState {
  return (service.cron as unknown as { state: CronServiceState }).state;
}

type CronTestDeps = Omit<CronServiceState["deps"], "enqueueSystemEvent" | "requestHeartbeat"> & {
  enqueueSystemEvent?: (
    text: string,
    opts?: Partial<Parameters<NonNullable<CronServiceState["deps"]["enqueueSystemEvent"]>>[1]>,
  ) => unknown;
  requestHeartbeat?: (
    opts?: Partial<Parameters<NonNullable<CronServiceState["deps"]["requestHeartbeat"]>>[0]>,
  ) => void;
};

function getCronDeps(service: CronServiceFixture): CronTestDeps {
  return getCronState(service).deps as CronTestDeps;
}

function addCronJob(
  service: CronServiceFixture,
  name: string,
  payload: CronJobCreate["payload"],
  overrides: CronJobOverrides = {},
) {
  return service.cron.add(cronJob(name, payload, overrides));
}

function createJobAdder(payload: (text: string) => CronJobCreate["payload"]) {
  return (
    service: CronServiceFixture,
    name: string,
    text: string,
    overrides: CronJobOverrides = {},
  ) => addCronJob(service, name, payload(text), overrides);
}
const addSystemEventJob = createJobAdder((text) => ({ kind: "systemEvent", text }));
const addAgentTurnJob = createJobAdder((message) => ({ kind: "agentTurn", message }));
const addCommandJob = createJobAdder((source) => ({
  kind: "command",
  argv: [process.execPath, "-e", source],
}));
const addScriptJob = createJobAdder((script) => ({ kind: "script", script }));

function addStreamJob(service: CronServiceFixture, name: string) {
  return addSystemEventJob(service, name, "event", {
    schedule: { kind: "stream", command: ["source"] },
    sessionTarget: "main",
  });
}

function mockCronSupervisor(...runs: ReturnType<typeof createWatchedRun>[]) {
  let nextRun = 0;
  const activeRuns = new Map<number, ReturnType<typeof createWatchedRun>>();
  const spawn = vi.fn(async () => {
    const index = nextRun++;
    const run = runs.length ? expectDefined(runs[index], "watched process") : createWatchedRun();
    activeRuns.set(index, run);
    void run.exit.promise.then(() => activeRuns.delete(index));
    return { ...run, runId: `cron-watch-${index}` };
  });
  const cancelScope = vi.fn();
  const acquireScopeCleanup = vi.fn(() => {
    const index = nextRun;
    let closing: Promise<void> | undefined;
    return () => {
      if (!closing) {
        const run = activeRuns.get(index);
        run?.cancel();
        closing = run ? run.wait().then(() => undefined) : Promise.resolve();
      }
      return closing;
    };
  });
  getProcessSupervisorMock.mockReturnValue({ acquireScopeCleanup, spawn, cancelScope });
  return { spawn, cancelScope };
}

const requireRecord = createRequireRecord("object", "expected-label");

function callArg(
  mock: { mock: { calls: Array<Array<unknown>> } },
  callIndex: number,
  argIndex: number,
  label: string,
) {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call: ${label}`);
  }
  if (argIndex >= call.length) {
    throw new Error(`Expected mock call argument ${argIndex}: ${label}`);
  }
  return call[argIndex];
}

function lastCallRecord(mock: Parameters<typeof callArg>[0], argIndex: number) {
  return callRecord(mock, mock.mock.calls.length - 1, argIndex);
}

function callRecord(mock: Parameters<typeof callArg>[0], callIndex = 0, argIndex = 0) {
  return requireRecord(callArg(mock, callIndex, argIndex, "mock argument"), "mock argument");
}

function finishedEvent(jobId?: string) {
  return runCronChangedMock.mock.calls
    .map((_, index) => callRecord(runCronChangedMock, index))
    .find((event) => event.action === "finished" && (jobId === undefined || event.jobId === jobId));
}

function mockScriptResult(notify?: string) {
  cronScriptExecutorMock.mockResolvedValueOnce({
    kind: "completed",
    ...(notify === undefined ? {} : { notify }),
    stateChanged: false,
  });
}

function expectIsolatedRunFields(fields: Record<string, unknown>) {
  const options = callRecord(runCronIsolatedAgentTurnMock);
  expect(options.trigger).toBe("cron");
  for (const [key, value] of Object.entries(fields)) {
    expect(options[key]).toEqual(value);
  }
  return options;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    resetActiveCronTaskRunsForTests();
    enqueueSystemEventMock.mockClear();
    systemEventReceiptRemoveMock.mockClear();
    requestHeartbeatMock.mockClear();
    requestHeartbeatAndWaitMock.mockReset();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    sendCronAnnouncePayloadStrictMock.mockClear();
    resolveDeliveryTargetMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    runCronChangedMock.mockClear();
    getGlobalHookRunnerMock.mockClear();
    abortAndDrainEmbeddedAgentRunMock.mockClear();
    captureSessionMcpRuntimeRetirementMock.mockReset();
    captureSessionMcpRuntimeRetirementMock.mockImplementation(({ sessionId }) =>
      sessionId ? { sessionId, retire: retireSessionMcpRuntimeMock } : undefined,
    );
    retireSessionMcpRuntimeMock.mockClear();
    requestSafeGatewayRestartMock.mockClear();
    getProcessSupervisorMock.mockReset();
    getProcessSupervisorMock.mockReturnValue({
      acquireScopeCleanup: vi.fn(() => async () => {}),
      spawn: vi.fn(),
      cancelScope: vi.fn(),
    });
    cronTriggerEvaluatorMock.mockReset();
    cronTriggerEvaluatorMock.mockResolvedValue({ kind: "evaluated", fire: false });
    cronScriptExecutorMock.mockReset();
    cronScriptExecutorMock.mockResolvedValue({ kind: "completed", stateChanged: false });
    createCronScriptRuntimeMock.mockReset();
    createCronScriptRuntimeMock.mockReturnValue({
      evaluateTrigger: cronTriggerEvaluatorMock,
      executePayload: cronScriptExecutorMock,
    });
    getGlobalHookRunnerMock.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "cron_changed",
      runCronChanged: runCronChangedMock,
    });
  });

  registerGatewayCronSystemJobTests({
    createCronConfig,
    loadCronService,
    withCronService,
    setRuntimeConfig: (cfg) => loadConfigMock.mockReturnValue(cfg),
    addAgentTurnJob,
  });

  registerGatewayCronMutationAuthorityTests({
    createCronConfig,
    loadCronService,
    createCronService,
    addCronJob,
  });

  it("keeps sole-agent ownerless jobs dynamic across a restart and roster rename", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-sole-owner-${Date.now()}`);
    const store = path.join(tmpDir, "cron.json");
    const opsCfg = { cron: { store }, agents: { entries: { ops: {} } } } as OpenClawConfig;
    loadConfigMock.mockReturnValue(opsCfg);
    const initial = createCronService(opsCfg);
    await initial.cron.start();
    const job = await addAgentTurnJob(initial, "dynamic sole owner", "follow the live owner", {
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
    });
    expect(job.agentId).toBeUndefined();
    initial.cron.stop();

    const restarted = createCronService(opsCfg);
    try {
      await restarted.cron.start();
      expect((await restarted.cron.readJob(job.id))?.agentId).toBeUndefined();

      loadConfigMock.mockReturnValue({
        ...opsCfg,
        agents: { entries: { research: {} } },
      });
      await expect(restarted.cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expectIsolatedRunFields({ agentId: "research", sessionKey: `cron:${job.id}` });
    } finally {
      restarted.cron.stop();
    }
  });

  it("fires scheduled ownerless jobs as the configured system agent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    const cfg = createCronConfig("server-cron-system-agent-owner");
    cfg.agents = { entries: { main: {} } };
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });

    try {
      await state.cron.start();
      const job = await addAgentTurnJob(state, "scheduled system owner", "run on schedule", {
        schedule: { kind: "every", everyMs: 60_000 },
      });
      expect(job.agentId).toBeUndefined();
      loadConfigMock.mockReturnValue({
        ...cfg,
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" } },
          entries: { main: {}, helper: {} },
        },
      } satisfies OpenClawConfig);

      vi.setSystemTime(new Date("2026-08-14T12:01:00.000Z"));
      clock.setTime(Date.now());
      await onCronTimer(getCronState(state));
      await waitForCronRunQueue(getCronState(state));

      expect(state.cron.getJob(job.id)?.state).toMatchObject({
        lastStatus: "ok",
        consecutiveErrors: 0,
      });
      expect(state.cron.getJob(job.id)?.state.lastError).toBeUndefined();
      expectIsolatedRunFields({ agentId: "main" });
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("passes the persisted payload tool cap to trigger evaluation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    const cfg = createTriggerConfig("server-cron-trigger-tool-cap");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });

    try {
      const job = await addCronJob(
        state,
        "restricted trigger",
        { kind: "systemEvent", text: "wake", toolsAllow: ["read", "cron"] },
        {
          schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
          trigger: { script: "json({ fire: false })" },
          sessionTarget: "main",
          wakeMode: "now",
        },
      );
      vi.setSystemTime(job.state.nextRunAtMs ?? 0);
      clock.setTime(Date.now());

      expect(await state.cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
      expect(cronTriggerEvaluatorMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({
            id: job.id,
            payload: expect.objectContaining({ toolsAllow: ["read", "cron"] }),
          }),
        }),
      );
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("restarts on-exit watchers only after their scheduler successfully restarts", async () => {
    const { spawn } = mockCronSupervisor();
    const cfg = createCronConfig("server-cron-restart-exit-watchers");
    await withCronService(cfg, async (state) => {
      await addSystemEventJob(state, "restart watched build", "done", {
        schedule: { kind: "on-exit", command: "sleep 60" },
        sessionTarget: "main",
      });
      await state.reconcileExitWatchers?.();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

      state.cron.stop();
      await state.reconcileExitWatchers?.();
      expect(spawn).toHaveBeenCalledOnce();

      await state.cron.start();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    });
  });

  registerGatewayCronHandoffTests({
    createWatchedRun,
    mockCronSupervisor,
    createCronConfig,
    loadCronService,
    getConcreteCron,
    addSystemEventJob,
    runExit,
    requestHeartbeatAndWaitMock,
    enqueueSystemEventMock,
  });

  it.each(["disable", "handoff"] as const)(
    "settles an on-exit %s while the Gateway restart fence remains closed",
    async (action) => {
      resetGatewayWorkAdmission();
      const watched = createWatchedRun(false);
      const watchedExit = watched.exit;
      const waitingForExit = createDeferred();
      watched.wait.mockImplementation(() => {
        waitingForExit.resolve();
        return watchedExit.promise;
      });
      mockCronSupervisor(watched);
      const cfg = createCronConfig("server-cron-on-exit-closed-admission");
      const previous = loadCronService(cfg);
      const next = loadCronService(cfg);
      let fence: ReturnType<typeof beginGatewayRestartSignalAdmission> = null;
      let settled: Promise<void> | undefined;
      try {
        const job = await addSystemEventJob(previous, "watch before restart", "done", {
          schedule: { kind: "on-exit", command: "true" },
          sessionTarget: "main",
          wakeMode: "now",
        });
        await previous.reconcileExitWatchers();
        await waitingForExit.promise;
        fence = beginGatewayRestartSignalAdmission();
        expect(fence).not.toBeNull();
        watchedExit.resolve(runExit({ reason: "exit", exitCode: 0 }));
        await waitForImmediate();
        const oldHandoff = expectDefined(
          await previous.prepareExitWatcherHandoff?.(),
          "previous handoff",
        );
        let finished = false;
        if (action === "disable") {
          await previous.cron.update(job.id, { enabled: false });
          settled = oldHandoff.current().cancelAll();
        } else {
          const nextHandoff = expectDefined(
            await next.prepareExitWatcherHandoff?.(),
            "next handoff",
          );
          settled = Promise.resolve(nextHandoff.adopt(oldHandoff.current()));
        }
        settled = settled.then(() => {
          finished = true;
        });
        await vi.waitFor(() => expect(finished).toBe(true));
        expect(isGatewayWorkAdmissionClosed()).toBe(true);
        expect(requestHeartbeatAndWaitMock).not.toHaveBeenCalled();
      } finally {
        previous.cron.stop();
        next.cron.stop();
        fence?.rollback();
        watchedExit.resolve(runExit());
        await settled;
        await next.cron.stopAndDrain?.();
        await previous.cron.stopAndDrain?.();
        resetGatewayWorkAdmission();
      }
    },
  );

  it.each(["add", "remove"] as const)(
    "does not apply a stale on-exit watcher snapshot after a concurrent %s",
    async (mutation) => {
      const watched = createWatchedRun();
      const { cancel } = watched;
      const { spawn, cancelScope } = mockCronSupervisor(watched);
      const cfg = createCronConfig(`server-cron-on-exit-${mutation}-race`);
      const state = loadCronService(cfg);
      const captured = createDeferred();
      const release = createDeferred();

      try {
        const addJob = async () =>
          await addSystemEventJob(state, "Watch concurrent mutation", "done", {
            schedule: { kind: "on-exit", command: "sleep 60" },
            sessionTarget: "main",
          });
        const existing = mutation === "remove" ? await addJob() : undefined;
        if (existing) {
          await state.reconcileExitWatchers?.();
          await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
        }

        const originalList = state.cron.list.bind(state.cron);
        let gateNextList = true;
        state.cron.list = async (options?: Parameters<typeof originalList>[0]) => {
          if (!gateNextList) {
            return await originalList(options);
          }
          gateNextList = false;
          const snapshot = await originalList(options);
          captured.resolve();
          await release.promise;
          return snapshot;
        };

        const staleReconciliation = state.reconcileExitWatchers?.();
        await captured.promise;
        if (mutation === "remove") {
          if (!existing) {
            throw new Error("expected an existing exit-watcher job");
          }
          await state.cron.remove(existing.id);
          await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        } else {
          await addJob();
          await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
        }
        release.resolve();
        await staleReconciliation;

        expect(spawn).toHaveBeenCalledOnce();
        if (mutation === "add") {
          expect(cancel).not.toHaveBeenCalled();
          expect(cancelScope).not.toHaveBeenCalled();
        }
      } finally {
        release.resolve();
        state.cron.stop();
      }
    },
  );

  it.each([
    { command: "true", exitTiming: "after" },
    { command: "echo rearmed", exitTiming: "after" },
    { command: "true", exitTiming: "before" },
    { command: "echo rearmed", exitTiming: "before" },
  ])(
    "re-arms on-exit $command when its next exit arrives $exitTiming the previous payload finishes",
    async ({ command, exitTiming }) => {
      const first = createWatchedRun(false);
      const second = createWatchedRun(false);
      const firstExit = first.exit;
      const secondExit = second.exit;
      const releasePayload = createDeferred();
      const payloadFinished = createDeferred();
      const { spawn } = mockCronSupervisor(first, second);
      requestHeartbeatAndWaitMock.mockImplementationOnce(async () => {
        await releasePayload.promise;
        return { status: "ran", durationMs: 1 };
      });
      const state = loadCronService(createCronConfig("server-cron-on-exit-rearm"));
      let nowMs = 1_700_000_000_000;
      getCronDeps(state).nowMs = () => nowMs;
      const cron = getConcreteCron(state);
      const run = cron.runOnExit.bind(cron);
      vi.spyOn(cron, "runOnExit").mockImplementationOnce(async (...args) => {
        try {
          return await run(...args);
        } finally {
          payloadFinished.resolve();
        }
      });

      try {
        const job = await addSystemEventJob(state, "watch and rearm", "done", {
          schedule: { kind: "on-exit", command: "true" },
          sessionTarget: "main",
          wakeMode: "now",
        });
        await state.reconcileExitWatchers();
        firstExit.resolve(runExit({ reason: "exit", exitCode: 0 }));
        await vi.waitFor(() => expect(requestHeartbeatAndWaitMock).toHaveBeenCalledOnce());
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
        await state.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledOnce();

        const rearmed = await state.cron.update(job.id, {
          enabled: true,
          schedule: { kind: "on-exit", command },
        });
        expect(rearmed.updatedAtMs).toBe(job.updatedAtMs);
        await state.reconcileExitWatchers();
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));

        if (exitTiming === "before") {
          secondExit.resolve(runExit({ reason: "exit", exitCode: 0 }));
          await waitForImmediate();
          expect(state.cron.getJob(job.id)?.enabled).toBe(true);
        }
        nowMs += 1;
        releasePayload.resolve();
        await payloadFinished.promise;
        if (exitTiming === "after") {
          await state.reconcileExitWatchers();
          expect(state.cron.getJob(job.id)?.enabled).toBe(true);
          secondExit.resolve(runExit({ reason: "exit", exitCode: 0 }));
        }
        await vi.waitFor(() => expect(requestHeartbeatAndWaitMock).toHaveBeenCalledTimes(2));
        expect(spawn).toHaveBeenCalledTimes(2);
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
      } finally {
        releasePayload.resolve();
        firstExit.resolve(runExit());
        secondExit.resolve(runExit());
        await state.cron.stopAndDrain?.();
      }
    },
  );

  it("persists an existing watcher exit during drain but fences its new scheduled run", async () => {
    resetGatewayWorkAdmission();
    const watched = createWatchedRun(false);
    const commandExit = watched.exit;
    const { spawn } = mockCronSupervisor(watched);
    const state = loadCronService(createCronConfig("server-cron-on-exit-draining"));
    let suspensionAdmission: ReturnType<typeof tryBeginGatewaySuspendAdmission> | undefined;

    try {
      const job = await addSystemEventJob(state, "watch and drain naturally", "done", {
        schedule: { kind: "on-exit", command: "true" },
        sessionTarget: "main",
        wakeMode: "now",
      });
      await state.reconcileExitWatchers();
      await vi.waitFor(() => {
        expect(spawn).toHaveBeenCalledOnce();
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      });

      state.cron.pauseScheduling();
      suspensionAdmission = tryBeginGatewaySuspendAdmission(() => {});
      expect(suspensionAdmission?.drain()).toBe(true);
      commandExit.resolve(runExit({ reason: "exit", exitCode: 0 }));

      await vi.waitFor(() => expect(state.cron.getJob(job.id)?.enabled).toBe(false));
      expect(tryBeginGatewayRootWorkAdmission()).toBeNull();
      expect(requestHeartbeatAndWaitMock).not.toHaveBeenCalled();

      state.cron.resumeScheduling();
      expect(suspensionAdmission?.release()).toBe(true);
    } finally {
      commandExit.resolve(runExit());
      state.cron.resumeScheduling();
      suspensionAdmission?.release();
      await state.cron.stopAndDrain?.();
      resetGatewayWorkAdmission();
    }
  });

  it.each(["main", "isolated"] as const)(
    "retains a watched exit behind an active %s run",
    async (sessionTarget) => {
      const watched = createWatchedRun(false);
      const commandExit = watched.exit;
      const predecessorStarted = createDeferred();
      const predecessorRelease = createDeferred();
      const holdPredecessor = async () => {
        predecessorStarted.resolve();
        await predecessorRelease.promise;
      };
      if (sessionTarget === "main") {
        requestHeartbeatAndWaitMock.mockImplementationOnce(async () => {
          await holdPredecessor();
          return { status: "ran", durationMs: 1 };
        });
      } else {
        runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
          await holdPredecessor();
          return { status: "ok", summary: "manual run finished" };
        });
      }
      const { spawn } = mockCronSupervisor(watched);
      const clock = createGatewaySchedulerClock(Date.now());
      const state = loadCronService(createCronConfig(`cron-exit-admission-${sessionTarget}`), {
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      const watcherRuns = vi.spyOn(getConcreteCron(state), "runOnExit");
      let predecessor: ReturnType<typeof state.cron.run> | undefined;

      try {
        const job = await addCronJob(
          state,
          "watch command while manually running",
          sessionTarget === "main"
            ? { kind: "systemEvent", text: "manual prompt" }
            : { kind: "agentTurn", message: "manual prompt" },
          {
            schedule: { kind: "on-exit", command: "true" },
            sessionTarget,
            wakeMode: "now",
            deleteAfterRun: false,
          },
        );
        await state.reconcileExitWatchers();
        predecessor = state.cron.run(job.id, "force");
        await predecessorStarted.promise;
        commandExit.resolve(runExit({ reason: "exit", exitCode: 3, stdout: "watched result" }));

        await waitForImmediate();
        expect(state.cron.getJob(job.id)?.enabled).toBe(true);
        predecessorRelease.resolve();
        await expect(predecessor).resolves.toEqual({ ok: true, ran: true });
        await clock.advanceBy(2_000);
        const completion = watcherRuns.mock.results[0];
        if (completion?.type !== "return") {
          throw new Error("Expected the watched exit's cron run");
        }
        await completion.value;
        const payloadRunner =
          sessionTarget === "main" ? requestHeartbeatAndWaitMock : runCronIsolatedAgentTurnMock;
        expect(payloadRunner).toHaveBeenCalledTimes(2);
        expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
        expect(spawn).toHaveBeenCalledOnce();
      } finally {
        predecessorRelease.resolve();
        commandExit.resolve(runExit());
        await predecessor;
        await state.cron.stopAndDrain?.();
        watcherRuns.mockRestore();
      }
    },
  );

  it.each(["update", "updateWithPrecondition", "add"] as const)(
    "honors an explicit %s disable while terminal persistence is settling",
    async (mutation) => {
      resetGatewayWorkAdmission();
      let suspensionAdmission: ReturnType<typeof tryBeginGatewaySuspendAdmission> | undefined;
      const watched = createWatchedRun(false);
      const { exit: commandExit, cancel } = watched;
      const completionPersistCommitted = createDeferred();
      const allowCompletionPersist = createDeferred();
      const { spawn, cancelScope } = mockCronSupervisor(watched);
      const state = loadCronService(
        createCronConfig(`server-cron-on-exit-explicit-disable-${mutation}`),
      );
      const originalUpdateWithPrecondition = state.cron.updateWithPrecondition.bind(state.cron);
      let gateTerminalCompletion = true;
      vi.spyOn(state.cron, "updateWithPrecondition").mockImplementation(async (...args) => {
        if (!gateTerminalCompletion) {
          return await originalUpdateWithPrecondition(...args);
        }
        gateTerminalCompletion = false;
        const result = await originalUpdateWithPrecondition(...args);
        completionPersistCommitted.resolve();
        await allowCompletionPersist.promise;
        return result;
      });
      const run = vi.spyOn(getConcreteCron(state), "runOnExit");

      try {
        const input = {
          name: "watch and honor explicit disable",
          declarationKey: "agent:main:watch-and-honor-explicit-disable",
          enabled: true,
          schedule: { kind: "on-exit" as const, command: "true" },
          payload: { kind: "systemEvent" as const, text: "must not fire" },
          sessionTarget: "main" as const,
          wakeMode: "now" as const,
        };
        const job = await state.cron.add(input);
        await state.reconcileExitWatchers();
        await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

        state.cron.pauseScheduling();
        suspensionAdmission = tryBeginGatewaySuspendAdmission(() => {});
        expect(suspensionAdmission?.drain()).toBe(true);
        commandExit.resolve(runExit());
        await completionPersistCommitted.promise;

        if (mutation === "updateWithPrecondition") {
          await state.cron.updateWithPrecondition(job.id, { enabled: false }, () => {});
        } else if (mutation === "add") {
          await state.cron.add({ ...input, enabled: false }, { enabledExplicit: true });
        } else {
          await state.cron.update(job.id, { enabled: false });
        }
        expect(cancel).toHaveBeenCalledWith("manual-cancel");
        expect(cancelScope).toHaveBeenCalledWith(`cron-exit:${job.id}`, "manual-cancel");
        allowCompletionPersist.resolve();

        await vi.waitFor(async () => {
          const handoff = await state.prepareExitWatcherHandoff?.();
          expect(handoff?.current().activeJobIds()).toEqual([]);
        });
        expect(run).not.toHaveBeenCalled();
      } finally {
        allowCompletionPersist.resolve();
        commandExit.resolve(runExit());
        state.cron.resumeScheduling();
        suspensionAdmission?.release();
        await state.cron.stopAndDrain?.();
        resetGatewayWorkAdmission();
      }
    },
  );

  it("aborts and drains active cron runs during shutdown", async () => {
    const controller = new AbortController();
    const coreRun = createDeferred();
    controller.signal.addEventListener("abort", () => coreRun.resolve(), { once: true });
    const release = registerActiveCronTaskRun({ runId: "run-shutdown", controller });
    const trackedRun = coreRun.promise.finally(() => release?.());
    trackActiveCronTaskRunSettlement(trackedRun);

    const cfg = createCronConfig("server-cron-active-run-shutdown");
    const state = loadCronService(cfg);

    try {
      await state.cron.stopAndDrain?.();
      expect(controller.signal.aborted).toBe(true);
      await expect(trackedRun).resolves.toBeUndefined();
    } finally {
      state.cron.stop();
      coreRun.resolve();
      await trackedRun;
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      resetActiveCronTaskRunsForTests();
    }
  });

  describe("timed-out agent run cleanup", () => {
    const sessionId = "shared-main-session";
    const sessionKey = "agent:main:main";

    async function cleanupTimedOutCronRun(state: CronServiceFixture) {
      const job = await addAgentTurnJob(state, "shared session turn", "work");
      abortAndDrainEmbeddedAgentRunMock.mockImplementation(abortAndDrainEmbeddedAgentRun);
      await getCronDeps(state).cleanupTimedOutAgentRun?.({
        job,
        timeoutMs: 600_000,
        execution: { jobId: job.id, sessionId, sessionKey, runId: "cron-run" },
      });
    }

    async function registerRun(runId: string, storePath?: string) {
      const registered = createDeferred<ReturnType<typeof createEmbeddedRunHandle>>();
      const release = createDeferred();
      const turn = withSessionTurn({ sessionKey, sessionId, storePath }, async (operation) => {
        const handle = createEmbeddedRunHandle({
          runId,
          abort: vi.fn(() => {
            detachActiveEmbeddedRun(sessionId, handle, sessionKey);
            release.resolve();
          }),
        });
        attachActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, undefined, operation);
        registered.resolve(handle);
        await release.promise;
      });
      void turn.catch(registered.reject);
      return {
        handle: await registered.promise,
        async release() {
          release.resolve();
          await turn;
        },
      };
    }

    afterEach(() => {
      embeddedRunsTesting.resetActiveEmbeddedRuns();
      abortAndDrainEmbeddedAgentRunMock.mockReset();
    });

    it.each(["replacement-run", "cron-run"])(
      "cleans up only the owning cron run (%s)",
      async (runId) => {
        await withCronService(createCronConfig("server-cron-timeout-owner"), async (state) => {
          const registered = await registerRun(runId);
          const ownsSession = runId === "cron-run";
          try {
            await cleanupTimedOutCronRun(state);
            expect(registered.handle.abort).toHaveBeenCalledTimes(ownsSession ? 1 : 0);
            expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(!ownsSession);
            expect(retireSessionMcpRuntimeMock).toHaveBeenCalledTimes(ownsSession ? 1 : 0);
          } finally {
            if (!ownsSession) {
              detachActiveEmbeddedRun(sessionId, registered.handle, sessionKey);
            }
            await registered.release();
          }
        });
      },
    );

    it("aborts only the timed-out cron run when physical stores share a session ID", async () => {
      await withCronService(
        createCronConfig("server-cron-timeout-physical-owner"),
        async (state) => {
          const original = await registerRun(
            "cron-run",
            path.join(os.tmpdir(), "server-cron-timeout-original", "sessions.json"),
          );
          const other = await registerRun(
            "other-run",
            path.join(os.tmpdir(), "server-cron-timeout-other", "sessions.json"),
          );
          try {
            await cleanupTimedOutCronRun(state);

            expect(original.handle.abort).toHaveBeenCalledOnce();
            expect(other.handle.abort).not.toHaveBeenCalled();
            expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
          } finally {
            detachActiveEmbeddedRun(sessionId, original.handle, sessionKey);
            detachActiveEmbeddedRun(sessionId, other.handle, sessionKey);
            await Promise.all([original.release(), other.release()]);
          }
        },
      );
    });
  });

  it("keeps a stream source running when a conditional or invalid update is rejected", async () => {
    const watched = createWatchedRun();
    const { cancel, detachOutput } = watched;
    const { spawn } = mockCronSupervisor(watched);
    const cfg = createTriggerConfig("server-cron-stream-rejected-update");
    const state = loadCronService(cfg);

    try {
      const added = await addStreamJob(state, "stream source");
      const streamJob = "job" in added ? added.job : added;
      const sourceIdentity = streamJob.state.streamSourceIdentity;
      await expect(
        state.cron.updateWithPrecondition(streamJob.id, { enabled: false }, () => {
          throw new Error("revision mismatch");
        }),
      ).rejects.toThrow("revision mismatch");
      await expect(
        state.cron.update(streamJob.id, { schedule: { kind: "stream", command: [] } }),
      ).rejects.toThrow("non-empty command argv array");
      await state.cron.update(streamJob.id, { schedule: { kind: "stream", command: ["source"] } });

      expect(spawn).toHaveBeenCalledOnce();
      expect(cancel).not.toHaveBeenCalled();
      expect(detachOutput).not.toHaveBeenCalled();
      expect(state.cron.getJob(streamJob.id)?.enabled).toBe(true);
      expect(state.cron.getJob(streamJob.id)?.state.streamSourceIdentity).toBe(sourceIdentity);
    } finally {
      await state.stopStreamWatchers?.();
      state.cron.stop();
    }
  });

  it("discards a stale reconcile list snapshot that raced a direct mutation route", async () => {
    const watched = createWatchedRun();
    const { cancel, detachOutput } = watched;
    const { spawn } = mockCronSupervisor(watched);
    const cfg = createTriggerConfig("server-cron-stream-stale-snapshot");
    const state = loadCronService(cfg);

    try {
      // Gate reconcile's first list call: capture the pre-add (empty) snapshot,
      // hold it while the add's direct route starts the owner, then release the
      // stale snapshot. The older sweep must not stop the freshly started
      // owner as "removed"; the mutation already routed its current definition.
      const originalList = state.cron.list.bind(state.cron);
      const { promise: staleListGate, resolve: releaseStaleList } = createDeferred();
      let armed = true;
      state.cron.list = async (opts?: Parameters<typeof originalList>[0]) => {
        if (!armed) {
          return await originalList(opts);
        }
        armed = false;
        const snapshot = await originalList(opts);
        await staleListGate;
        return snapshot;
      };

      const reconciling = state.reconcileStreamWatchers?.();
      const added = await addStreamJob(state, "stale snapshot stream source");
      const streamJob = "job" in added ? added.job : added;
      const sourceIdentity = streamJob.state.streamSourceIdentity;
      expect(spawn).toHaveBeenCalledOnce();
      releaseStaleList();
      await reconciling;

      expect(cancel).not.toHaveBeenCalled();
      expect(detachOutput).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledOnce();
      expect(state.cron.getJob(streamJob.id)?.state.streamSourceIdentity).toBe(sourceIdentity);
    } finally {
      await state.stopStreamWatchers?.();
      state.cron.stop();
      vi.unstubAllEnvs();
    }
  });

  it("drains stream teardown once when stop and stopAndDrain overlap", async () => {
    const watched = createWatchedRun();
    const { cancel } = watched;
    mockCronSupervisor(watched);
    const cfg = createTriggerConfig("server-cron-stream-single-drain");
    const state = loadCronService(cfg);

    try {
      await addStreamJob(state, "single drain stream source");
      // cron.stop launches the asynchronous teardown; stopAndDrain must await
      // that same drain instead of queueing every owner a second shutdown stop.
      state.cron.stop();
      await state.cron.stopAndDrain?.();
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      await state.stopStreamWatchers?.();
      state.cron.stop();
    }
  });

  it("retries stream teardown after a prior drain failure", async () => {
    vi.useFakeTimers();
    const watched = createWatchedRun(true, { durationMs: 10_000 });
    const { cancel } = watched;
    cancel.mockImplementationOnce(() => {});
    mockCronSupervisor(watched);
    const cfg = createTriggerConfig("server-cron-stream-retry-drain");
    const state = loadCronService(cfg);

    try {
      await addStreamJob(state, "retry drain stream source");

      const firstFailure = expect(state.cron.stopAndDrain?.()).rejects.toThrow(
        "stream source did not exit",
      );
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1), { interval: 0 });
      await vi.advanceTimersByTimeAsync(10_000);
      await firstFailure;
      await expect(state.cron.stopAndDrain?.()).resolves.toBeUndefined();
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      await state.stopStreamWatchers?.();
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  registerGatewayCronStreamMutationTests({
    createCronConfig,
    loadCronService,
    addSystemEventJob,
    createWatchedRun,
    mockCronSupervisor,
  });

  it("keeps a failed stream removal in an explicit terminal error state", async () => {
    vi.useFakeTimers();
    const watched = createWatchedRun(true, { durationMs: 10_000 });
    const { cancel, detachOutput } = watched;
    cancel.mockImplementationOnce(() => {});
    mockCronSupervisor(watched);
    const cfg = createTriggerConfig("server-cron-stream-remove-failure");
    const state = loadCronService(cfg);

    try {
      const added = await addStreamJob(state, "stubborn stream source");
      const streamJob = "job" in added ? added.job : added;
      const removal = state.cron.remove(streamJob.id);
      const removalFailure = expect(removal).rejects.toThrow("stream source did not exit");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1), { interval: 0 });
      await vi.advanceTimersByTimeAsync(10_000);

      await removalFailure;
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel).toHaveBeenCalledWith("manual-cancel");
      expect(detachOutput).toHaveBeenCalled();
      expect(state.cron.getJob(streamJob.id)).toMatchObject({
        enabled: true,
        state: {
          streamStatus: "error",
          streamError: expect.stringContaining("stream source failed to stop"),
          streamRestartExhausted: true,
        },
      });

      await state.stopStreamWatchers?.();
      expect(state.cron.getJob(streamJob.id)).toMatchObject({
        state: {
          streamStatus: "error",
          streamError: expect.stringContaining("stream source failed to stop"),
          streamRestartExhausted: true,
        },
      });
    } finally {
      await state.stopStreamWatchers?.();
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("backs off isolated cron setup timeout without gateway restart", async () => {
    vi.useFakeTimers();
    const runnerEntered = createDeferred();
    const runnerResult = createDeferred<{ status: "ok"; summary: string }>();
    const cfg = createCronConfig("server-cron-isolated-setup-timeout");
    const state = loadCronService(cfg);
    let runPromise: ReturnType<typeof state.cron.run> | undefined;
    try {
      const job = await addCronJob(
        state,
        "isolated setup timeout",
        { kind: "agentTurn", message: "work", timeoutSeconds: 120 },
        { schedule: { kind: "at", at: new Date(Date.now()).toISOString() } },
      );
      runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
        runnerEntered.resolve();
        return await runnerResult.promise;
      });

      runPromise = state.cron.run(job.id, "force");
      await runnerEntered.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      const runResult = await runPromise;

      expect(runResult).toEqual({ ok: true, ran: true });
      expect(requestSafeGatewayRestartMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([runnerResult.promise, ...(runPromise ? [runPromise] : [])]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("forwards durable recurring wake changes to cron_changed hooks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    const cfg = createCronConfig("server-cron-hook-scheduled");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    const runtimeCfg = { ...cfg };
    loadConfigMock.mockReturnValue(runtimeCfg);
    try {
      const job = await addSystemEventJob(state, "scheduled-hook", "advance external wake", {
        agentId: "main",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
        sessionTarget: "main",
      });
      const dueAtMs = job.state.nextRunAtMs;
      if (dueAtMs === undefined) {
        throw new Error("expected recurring job to have a next run");
      }

      runCronChangedMock.mockClear();
      vi.setSystemTime(dueAtMs);
      clock.setTime(Date.now());
      expect(await state.cron.run(job.id, "due")).toEqual({ ok: true, ran: true });

      const scheduledCallIndex = runCronChangedMock.mock.calls.findIndex(([candidate]) => {
        return requireRecord(candidate, "cron_changed event").action === "scheduled";
      });
      expect(scheduledCallIndex).toBeGreaterThanOrEqual(0);
      const event = callRecord(runCronChangedMock, scheduledCallIndex);
      const persistedNextRunAtMs = state.cron.getJob(job.id)?.state.nextRunAtMs;
      expect(persistedNextRunAtMs).toBeGreaterThan(dueAtMs);
      expect(event).toMatchObject({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: persistedNextRunAtMs,
        sessionTarget: "main",
        agentId: "main",
        job: { agentId: "main", state: { nextRunAtMs: persistedNextRunAtMs } },
      });
      const context = callRecord(runCronChangedMock, scheduledCallIndex, 1);
      expect(context.config).toBe(runtimeCfg);
      expect(context.getCron).toBeTypeOf("function");
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });

  it("keeps detached cron_changed hooks root-admitted until they settle", async () => {
    resetGatewayWorkAdmission();
    const deferred = createDeferred();
    runCronChangedMock.mockImplementationOnce(async () => await deferred.promise);
    const cfg = createCronConfig("server-cron-hook-admission");
    const state = loadCronService(cfg);

    try {
      await addSystemEventJob(state, "held hook", "hello", {
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
      });
      await vi.waitFor(() => expect(runCronChangedMock).toHaveBeenCalledTimes(1));
      expect(getActiveGatewayRootWorkCount()).toBe(1);

      deferred.resolve();
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    } finally {
      deferred.resolve();
      state.cron.stop();
      resetGatewayWorkAdmission();
    }
  });

  it("suppresses command cron NO_REPLY output before announce delivery", async () => {
    const cfg = createCronConfig("server-cron-command-no-reply");
    await withCronService(cfg, async (state) => {
      const job = await addCommandJob(
        state,
        "silent-command",
        "process.stdout.write('NO_REPLY\\n')",
        {
          deleteAfterRun: false,
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
      );

      await state.cron.run(job.id, "force");

      expect(state.cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();
      expect(state.cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDeliveryStatus: "not-delivered",
        lastDelivered: false,
        deliverySuppressionReason: "silent",
      });
      expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
      expect(runCronChangedMock.mock.calls.map(([event]) => event)).toContainEqual(
        expect.objectContaining({
          jobId: job.id,
          action: "finished",
          completionStatus: "succeeded",
          deliverySuppressionReason: "silent",
        }),
      );
    });
  });

  registerGatewayCronCompletionTests({
    createCronConfig,
    createCronService,
    getCronDeps,
    loadConfigMock,
    sendCronAnnouncePayloadStrictMock,
    cronScriptExecutorMock,
  });

  it.each([
    ["no_visible_result", false, "command", "default"],
    ["no_visible_payload", false, "script", "required"],
    ["cancelled_by_message_sending_hook", false, "command", "optional"],
    ["adapter_returned_no_identity", true, "command", "default"],
    ["adapter_returned_no_identity", true, "script", "required"],
    ["adapter_returned_no_identity", true, "script", "optional"],
  ] as const)(
    "records %s suppression (recipientReached=%s, payload=%s, policy=%s) without retry",
    async (reason, recipientReached, payloadKind, policy) => {
      const cfg = createTriggerConfig(`cron-${payloadKind}-${reason}-${policy}`);
      loadConfigMock.mockReturnValue(cfg);
      mockScriptResult("scheduled result");
      sendCronAnnouncePayloadStrictMock.mockImplementationOnce(async (...args: unknown[]) => {
        const attempt = requireRecord(args[0], "suppressed cron announcement");
        if (typeof attempt.onDeliveryAttempt === "function") {
          attempt.onDeliveryAttempt(recipientReached);
        }
        return {
          status: "suppressed",
          reason,
          results: [],
          receipt: { platformMessageIds: [], parts: [], sentAt: 0 },
        };
      });

      await withCronService(cfg, async (state) => {
        const job = await addCronJob(
          state,
          `${payloadKind} ${reason} ${policy}`,
          payloadKind === "command"
            ? {
                kind: "command" as const,
                argv: [process.execPath, "-e", "process.stdout.write('scheduled result')"],
              }
            : { kind: "script" as const, script: "return { notify: 'scheduled result' }" },
          {
            deleteAfterRun: true,
            delivery: {
              mode: "announce",
              channel: "telegram",
              to: "123",
              ...(policy === "default" ? {} : { bestEffort: policy === "optional" }),
            },
          },
        );

        await state.cron.run(job.id, "force");

        expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
        const expectedDeliveryStatus = recipientReached ? "unknown" : "not-delivered";
        const required = policy !== "optional";
        const deliveryError = `cron delivery ${recipientReached ? "outcome is unknown" : "was suppressed"}: ${reason}`;
        const updated = state.cron.getJob(job.id);
        if (required) {
          expect(updated?.state).toMatchObject({
            lastDeliveryStatus: expectedDeliveryStatus,
            lastDeliveryError: deliveryError,
          });
        } else {
          expect(updated).toBeUndefined();
        }
        const finished = finishedEvent(job.id);
        expect(finished).toMatchObject({
          status: "ok",
          completionStatus: required ? (recipientReached ? "unknown" : "failed") : "succeeded",
          deliveryStatus: expectedDeliveryStatus,
          deliveryError,
        });
        if (recipientReached) {
          expect(finished).not.toHaveProperty("delivered");
        } else {
          expect(finished).toHaveProperty("delivered", false);
        }
      });
    },
  );

  it("never resends accepted script output after a wrapped partial-delivery failure", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    const cfg = createTriggerConfig("server-cron-script-wrapped-partial");
    loadConfigMock.mockReturnValue(cfg);
    mockScriptResult("scheduled result");
    const rejectedChunk = new PlatformMessageNotDispatchedError(
      "second chunk was never dispatched",
      {
        cause: Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
          syscall: "connect",
        }),
      },
    );
    const deliveryError = new OutboundDeliveryError("delivery failed after the first chunk", {
      cause: rejectedChunk,
      results: [{ channel: "telegram", messageId: "already-delivered" }],
      stage: "platform_send",
    });
    sendCronAnnouncePayloadStrictMock.mockImplementationOnce(async (...args: unknown[]) => {
      const attempt = requireRecord(args[0], "partial cron announcement");
      if (typeof attempt.onDeliveryAttempt === "function") {
        attempt.onDeliveryAttempt(true);
      }
      throw deliveryError;
    });

    const state = createCronService(cfg);
    try {
      const job = await addScriptJob(
        state,
        "script partial announcement",
        "return { notify: 'scheduled result' }",
        {
          deleteAfterRun: false,
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
      );

      await state.cron.run(job.id, "force");

      expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
      expect(state.cron.getJob(job.id)?.state.lastDeliveryStatus).toBe("unknown");
    } finally {
      state.cron.stop();
      vi.unstubAllEnvs();
    }
  });

  it.each([
    {
      name: "permanent typed rejection",
      error: new PlatformMessageNotDispatchedError("platform rejected this message", {
        cause: new Error("invalid payload"),
        retryable: false,
      }),
    },
    {
      name: "ambiguous transport failure",
      error: Object.assign(new Error("read ECONNRESET after sending"), { code: "ECONNRESET" }),
    },
  ])("does not duplicate a command announcement after $name", async ({ error }) => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    const cfg = createCronConfig("server-cron-command-no-unsafe-retry");
    loadConfigMock.mockReturnValue(cfg);
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(error);

    const state = createCronService(cfg);
    try {
      const job = await addCommandJob(
        state,
        "command no unsafe retry",
        "process.stdout.write('scheduled result')",
        {
          deleteAfterRun: false,
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
      );

      await state.cron.run(job.id, "force");

      expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
      expect(state.cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: expect.stringContaining(error.message),
      });
    } finally {
      state.cron.stop();
      vi.unstubAllEnvs();
    }
  });

  it("does not retry or alert after an operator cancels command output delivery", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    let deliverySignal: AbortSignal | undefined;
    sendCronAnnouncePayloadStrictMock.mockImplementationOnce(async (request) => {
      deliverySignal = request.abortSignal;
      expect(abortActiveCronTaskRuns("Cancelled by operator.")).toBe(1);
      throw new PlatformMessageNotDispatchedError("platform unavailable before dispatch", {
        cause: new Error("connect ECONNREFUSED"),
      });
    });

    try {
      await withCronService(createCronConfig("cron-cancelled-retry"), async (state) => {
        const job = await addCommandJob(state, "cancelled", "console.log('scheduled result')", {
          deleteAfterRun: false,
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        });
        await state.cron.run(job.id, "force");

        // The cancelled completion is the only send: an operator cancel is not a terminal failure.
        expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce();
        const completion = sendCronAnnouncePayloadStrictMock.mock.calls[0]?.[0];
        expect(completion?.completion).toBeDefined();
        expect(completion?.payload).toEqual([
          expect.objectContaining({ text: "scheduled result" }),
        ]);
        expect(deliverySignal?.aborted).toBe(true);
        const stored = state.cron.getJob(job.id);
        expect(stored).toMatchObject({
          enabled: false,
          state: { lastRunStatus: "error", lastError: "Cancelled by operator." },
        });
        expect(stored?.state.autoDisabled).toBeUndefined();
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps command execution errors on backoff when announce delivery also fails", async () => {
    const cfg = createCronConfig("server-cron-command-execution-failure");
    loadConfigMock.mockReturnValue(cfg);
    const deliveryError = "Channel is required (no configured channels detected)";
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error(deliveryError));

    const clock = createGatewaySchedulerClock(Date.now());
    await withCronService(
      cfg,
      async (state) => {
        const job = await addCommandJob(
          state,
          "failed-headless-command",
          "process.stderr.write('failed'); process.exit(7)",
          {
            deleteAfterRun: false,
            schedule: { kind: "every", everyMs: 20_000, anchorMs: Date.now() },
          },
        );

        const dueAtMs = job.state.nextRunAtMs;
        expect(dueAtMs).toBeTypeOf("number");
        clock.setTime(dueAtMs ?? 0);
        await expect(state.cron.run(job.id, "due")).resolves.toEqual({ ok: true, ran: true });

        const updated = state.cron.getJob(job.id);
        expect(updated?.state).toMatchObject({
          lastRunStatus: "error",
          lastError: "command exited with code 7",
          consecutiveErrors: 1,
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: deliveryError,
        });
        expect(updated?.state.nextRunAtMs).toBeGreaterThanOrEqual(
          (updated?.updatedAtMs ?? 0) + 30_000,
        );
      },
      { scheduler: createTestGatewayScheduler(clock.clock) },
    );
  });

  it("retains a one-shot command without changing execution status when required delivery fails", async () => {
    const cfg = createCronConfig("server-cron-command-required-delivery-failure");
    loadConfigMock.mockReturnValue(cfg);
    const deliveryError = "network unavailable while delivering command output";
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error(deliveryError));

    await withCronService(cfg, async (state) => {
      const job = await addCommandJob(
        state,
        "successful-command-required-delivery",
        "process.stdout.write('ok')",
        { deleteAfterRun: true, delivery: { mode: "announce", bestEffort: false } },
      );

      await state.cron.run(job.id, "force");

      const updated = state.cron.getJob(job.id);
      expect(updated).toMatchObject({
        enabled: false,
        state: {
          lastRunStatus: "ok",
          consecutiveErrors: 0,
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: deliveryError,
        },
      });
      expect(updated?.state.lastError).toBeUndefined();
      expect(updated?.state.nextRunAtMs).toBeUndefined();
      expect(finishedEvent(job.id)).toMatchObject({ status: "ok", completionStatus: "failed" });
    });
  });

  it.each([
    { notify: "queue changed", expected: "queue changed" },
    { notify: "NO_REPLY", expected: undefined },
    { notify: "NO_REPLY\nNO_REPLY", expected: "NO_REPLY" },
    { notify: "NO_REPLY.", expected: "NO_REPLY." },
  ])(
    "prepares isolated script notify $notify before announcement",
    async ({ notify, expected }) => {
      const cfg = createTriggerConfig("server-cron-script-announce");
      cfg.gateway = {
        publicOrigin: "https://gateway.example",
        controlUi: { basePath: "/control" },
      };
      loadConfigMock.mockReturnValue(cfg);
      cronScriptExecutorMock.mockResolvedValueOnce({
        kind: "completed",
        notify,
        stateChanged: false,
      });

      await withCronService(cfg, async (state) => {
        const job = await addScriptJob(
          state,
          "script-announce",
          "return { notify: 'queue changed' }",
          {
            deleteAfterRun: false,
            delivery: { mode: "announce", channel: "telegram", to: "123", threadId: 456 },
          },
        );

        await state.cron.run(job.id, "force");

        expect(cronScriptExecutorMock).toHaveBeenCalledWith(
          expect.objectContaining({
            job: expect.objectContaining({
              id: job.id,
              payload: expect.objectContaining({
                script: "return { notify: 'queue changed' }",
                timeoutSeconds: 300,
                toolBudget: 50,
              }),
            }),
          }),
        );
        if (expected === undefined) {
          expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
          expect(state.cron.getJob(job.id)?.state.deliverySuppressionReason).toBe("silent");
        } else {
          expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              jobId: job.id,
              payload: [{ text: expected }],
              inspectionUrl: `https://gateway.example/control/automations?job=${job.id}&run=cron%3A${job.id}%3A${state.cron.getJob(job.id)?.state.lastRunAtMs}`,
              target: expect.objectContaining({ threadId: 456 }),
            }),
          );
          expect(state.cron.getJob(job.id)?.state.deliverySuppressionReason).toBeUndefined();
        }
        expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
      });
    },
  );

  it("keeps script failure detail transient while preserving structured error payloads", async () => {
    const cfg = createTriggerConfig("server-cron-script-failure-detail");
    loadConfigMock.mockReturnValue(cfg);
    const rawError =
      "TOKEN=opaque-secret /private/script.sh https://internal.example.test/run provider-body Error: stack";
    cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "error",
      code: "internal_error",
      error: rawError,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(null, { status: 204 }),
      finalUrl: "https://example.invalid/cron",
      release: vi.fn(async () => {}),
    });
    const broadcast = vi.fn();
    await withCronService(
      cfg,
      async (state) => {
        const job = await addScriptJob(state, "script failure detail", "return invalid", {
          deleteAfterRun: false,
          failureAlert: { after: 1 },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "123",
            completionDestination: {
              mode: "webhook",
              to: "https://example.invalid/cron-finished",
            },
            failureDestination: { mode: "announce", channel: "telegram", to: "456" },
          },
        });
        broadcast.mockClear();
        runCronChangedMock.mockClear();

        await state.cron.run(job.id, "force");
        await vi.waitFor(() => expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce());

        const announceRequest = callRecord(sendCronAnnouncePayloadStrictMock);
        const announce = requireRecord(announceRequest.payload, "script failure announce");
        expect(announce.text).toContain(
          'Automation "script failure detail" failed 1 times\nCause: automation script failed internally',
        );
        expect(announce.text).not.toContain(rawError);

        const broadcastEvent = broadcast.mock.calls
          .filter(([name]) => name === "cron")
          .map(([, event]) => requireRecord(event, "cron broadcast event"))
          .find((event) => event.action === "finished" && event.jobId === job.id);
        expect(broadcastEvent).not.toHaveProperty("failureNotificationDetail");
        expect(JSON.stringify(broadcastEvent)).not.toContain("failureNotificationDetail");

        const hookEvent = finishedEvent(job.id);
        expect(hookEvent).not.toHaveProperty("failureNotificationDetail");
        expect(JSON.stringify(hookEvent)).not.toContain("failureNotificationDetail");

        const webhookRequest = callRecord(fetchWithSsrFGuardMock);
        const webhookBody = JSON.parse(
          String(requireRecord(webhookRequest.init, "script failure webhook init").body),
        ) as Record<string, unknown>;
        expect(webhookBody.error).toContain(rawError);
        expect(webhookBody).not.toHaveProperty("failureNotificationDetail");
      },
      { broadcast },
    );
  });

  it.each([
    {
      name: "default required",
      bestEffort: undefined,
      retained: true,
      completion: "failed",
    },
    { name: "explicit required", bestEffort: false, retained: true, completion: "failed" },
    { name: "explicit best-effort", bestEffort: true, retained: false, completion: "succeeded" },
  ])(
    "keeps script execution successful after $name announce failure",
    async ({ name, bestEffort, retained, completion }) => {
      const cfg = createTriggerConfig(`server-cron-script-${name}`);
      loadConfigMock.mockReturnValue(cfg);
      mockScriptResult("queue changed");
      sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error("delivery rejected"));

      await withCronService(cfg, async (state) => {
        const job = await addScriptJob(
          state,
          `script ${name}`,
          "return { notify: 'queue changed' }",
          {
            deleteAfterRun: true,
            delivery: {
              mode: "announce",
              channel: "telegram",
              to: "123",
              ...(bestEffort === undefined ? {} : { bestEffort }),
            },
          },
        );

        await state.cron.run(job.id, "force");

        const updated = state.cron.getJob(job.id);
        expect(Boolean(updated)).toBe(retained);
        if (updated) {
          expect(updated).toMatchObject({
            enabled: false,
            state: {
              lastRunStatus: "ok",
              lastDeliveryStatus: "not-delivered",
              consecutiveErrors: 0,
            },
          });
          expect(updated.state.lastError).toBeUndefined();
        }
        expect(finishedEvent(job.id)).toMatchObject({ status: "ok", completionStatus: completion });
      });
    },
  );

  it.each([
    { mode: "webhook", notify: "queue changed", deleteAfterRun: false },
    { mode: "webhook", notify: undefined, deleteAfterRun: false },
    { mode: "announce", notify: undefined, deleteAfterRun: true },
  ] as const)(
    "delivers $mode script notify=$notify and retains=$deleteAfterRun",
    async ({ mode, notify, deleteAfterRun }) => {
      const cfg = createTriggerConfig("server-cron-script-notify");
      mockScriptResult(notify);
      if (notify) {
        fetchWithSsrFGuardMock.mockResolvedValueOnce({
          response: new Response(null, { status: 204 }),
          finalUrl: "https://example.invalid/cron",
          release: vi.fn(async () => {}),
        });
      }
      await withCronService(cfg, async (state) => {
        const job = await addScriptJob(
          state,
          "script-notify",
          notify ? "return { notify: 'queue changed' }" : "return {}",
          {
            deleteAfterRun,
            delivery:
              mode === "webhook"
                ? { mode, to: "https://example.invalid/cron-finished" }
                : { mode, channel: "telegram", to: "123" },
          },
        );
        await state.cron.run(job.id, "force");
        if (notify) {
          expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
          const request = callRecord(fetchWithSsrFGuardMock);
          expect(String(requireRecord(request.init, "fetch init").body)).toContain(
            '"summary":"queue changed"',
          );
        } else if (mode === "webhook") {
          expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
        } else {
          expect(sendCronAnnouncePayloadStrictMock).not.toHaveBeenCalled();
          expect(state.cron.getJob(job.id)).toBeUndefined();
          expect(runCronChangedMock.mock.calls.map(([event]) => event)).toContainEqual(
            expect.objectContaining({
              jobId: job.id,
              action: "finished",
              status: "ok",
              completionStatus: "succeeded",
              deliveryStatus: "not-delivered",
              delivered: false,
              deliverySuppressionReason: "empty",
            }),
          );
        }
        if (!deleteAfterRun) {
          expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        }
      });
    },
  );

  it("redacts command summary before cron_changed hook delivery", async () => {
    const cfg = createCronConfig("server-cron-command-hook-redaction");
    await withCronService(cfg, async (state) => {
      const job = await addCommandJob(
        state,
        "hook-redacted-command",
        "process.stdout.write('Visit www.example.com/device and enter code 123456; Log in with token=opaque-secret-value\\n')",
        { deleteAfterRun: false },
      );

      runCronChangedMock.mockClear();
      await state.cron.run(job.id, "force");

      const event = finishedEvent();
      const summary = typeof event?.summary === "string" ? event.summary : "";
      expect(summary).toContain("[redacted-url]");
      expect(summary).toContain("[redacted-code]");
      expect(summary).toContain("token=***");
      expect(summary).not.toContain("www.example.com/device");
      expect(summary).not.toContain("123456");
      expect(summary).not.toContain("opaque-secret-value");
    });
  });

  it("passes redacted command output and a separate inspection link to delivery", async () => {
    const cfg = createCronConfig("server-cron-command-announce-redaction");
    cfg.gateway = { publicOrigin: "https://gateway.example", controlUi: { basePath: "/control" } };
    await withCronService(cfg, async (state) => {
      const job = await addCommandJob(
        state,
        "announce-redacted-command",
        "process.stdout.write('Visit https://private.example/device and log in with token=opaque-secret-value\\n')",
        {
          deleteAfterRun: false,
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
      );

      await state.cron.run(job.id, "force");

      const announcePayload = callRecord(sendCronAnnouncePayloadStrictMock);
      const payloads = announcePayload.payload;
      expect(payloads).toHaveLength(1);
      const payload = requireRecord(
        Array.isArray(payloads) ? payloads[0] : undefined,
        "cron announce reply payload",
      );
      const message = typeof payload.text === "string" ? payload.text : "";
      expect(message).toContain("token=***");
      expect(message).toContain("[redacted-url]");
      expect(message).not.toContain("opaque-secret-value");
      expect(message).not.toContain("https://private.example/device");
      expect(announcePayload.inspectionUrl).toBe(
        `https://gateway.example/control/automations?job=${job.id}&run=cron%3A${job.id}%3A${state.cron.getJob(job.id)?.state.lastRunAtMs}`,
      );
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
      expect(state.cron.getJob(job.id)?.state.lastDeliveryStatus).toBe("delivered");
    });
  });

  it.each(["next-heartbeat", "now"] as const)(
    "routes global-scope main cron jobs through the %s lane",
    async (wakeMode) => {
      const cfg = createCronConfig("server-cron-global", {
        session: { mainKey: "main", scope: "global" },
      });
      await withCronService(cfg, async (state) => {
        const job = await addSystemEventJob(state, "global", "hello global", {
          sessionTarget: "main",
          wakeMode,
        });
        await state.cron.run(job.id, "force");
        if (wakeMode === "next-heartbeat") {
          expect(callArg(enqueueSystemEventMock, 0, 0, "system event text")).toBe("hello global");
        }
        expect(callRecord(enqueueSystemEventMock, 0, 1).sessionKey).toBe("agent:main:global");
        const request = callRecord(
          wakeMode === "now" ? requestHeartbeatAndWaitMock : requestHeartbeatMock,
        );
        expect(request).toMatchObject({ agentId: "main", sessionKey: "global" });
        if (wakeMode === "now") {
          expect(request.heartbeat).toEqual({
            target: "last",
            to: undefined,
            accountId: undefined,
          });
        }
      });
    },
  );

  it("returns the settled heartbeat result through the cron wake adapter", async () => {
    requestHeartbeatAndWaitMock.mockResolvedValueOnce({
      status: "failed",
      reason: "agent-runner-failure",
    });
    await withCronService(createCronConfig("server-cron-heartbeat-settlement"), async (state) => {
      const lifecycle = { abortSignal: new AbortController().signal };
      await expect(
        getCronState(state).deps.requestHeartbeatAndWait?.(
          {
            source: "interval",
            intent: "task",
            reason: "heartbeat-task:report",
            agentId: "main",
            scheduledEveryMs: 15 * 60_000,
            tasks: [{ jobId: "report", name: "report", prompt: "Run report" }],
          },
          lifecycle,
        ),
      ).resolves.toEqual({ status: "failed", reason: "agent-runner-failure" });
      expect(requestHeartbeatAndWaitMock).toHaveBeenCalledWith(
        {
          source: "interval",
          intent: "task",
          reason: "heartbeat-task:report",
          agentId: "main",
          sessionKey: undefined,
          heartbeat: undefined,
          scheduledEveryMs: 15 * 60_000,
          tasks: [{ jobId: "report", name: "report", prompt: "Run report" }],
        },
        lifecycle,
      );
    });
  });

  it("passes awaited target-last wakes as destination-only overrides", async () => {
    const cfg = {
      ...createCronConfig("server-cron-awaited-heartbeat-route"),
      agents: {
        defaults: {
          heartbeat: {
            every: "1h",
            prompt: "Default heartbeat prompt",
            target: "none",
            directPolicy: "block",
            timeoutSeconds: 900,
            to: "telegram:dm",
            accountId: "default",
          },
        },
      },
    } as OpenClawConfig;
    await withCronService(cfg, async (state) => {
      const cronDeps = getCronDeps(state);

      await cronDeps.requestHeartbeatAndWait?.(
        {
          source: "cron",
          intent: "immediate",
          reason: "cron:test",
          sessionKey: "telegram:group:123:topic:456",
          heartbeat: { target: "last" },
        },
        {},
      );

      const call = callRecord(requestHeartbeatAndWaitMock);
      expect(call.sessionKey).toBe("agent:main:telegram:group:123:topic:456");
      expect(call.heartbeat).toEqual({ target: "last", to: undefined, accountId: undefined });
      expect(
        cronDeps?.resolveHeartbeatTimeoutMs?.({
          source: "cron",
          intent: "immediate",
          reason: "cron:test",
          agentId: "main",
          heartbeat: { target: "last" },
        }),
      ).toBe(900_000);
    });
  });

  it("preserves the unlimited agent timeout for heartbeat watchdogs", async () => {
    const cfg = {
      ...createCronConfig("server-cron-unlimited-heartbeat"),
      agents: { defaults: { timeoutSeconds: 0, heartbeat: { every: "1h" } } },
    } as OpenClawConfig;
    await withCronService(cfg, async (state) => {
      expect(
        getCronDeps(state)?.resolveHeartbeatTimeoutMs?.({
          source: "cron",
          intent: "immediate",
          reason: "cron:test",
          agentId: "main",
          heartbeat: { target: "last" },
        }),
      ).toBeUndefined();
    });
  });

  it("preserves untargeted cron wake requests for heartbeat fanout", async () => {
    const cfg = createMultiAgentConfig("server-cron-untargeted");
    await withCronService(cfg, async (state) => {
      const cronDeps = getCronDeps(state);

      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "immediate",
        reason: "cron:job:failure-alert",
      });

      expect(requestHeartbeatMock).toHaveBeenCalledWith({
        source: "cron",
        intent: "immediate",
        reason: "cron:job:failure-alert",
        agentId: undefined,
        sessionKey: undefined,
        heartbeat: undefined,
      });
    });
  });

  it("routes relative cron wake session keys to the configured default agent", async () => {
    const cfg = createCronConfig("server-cron-relative-default");
    cfg.agents = { entries: { primary: { model: "test/primary" } } };
    await withCronService(cfg, async (state) => {
      const cronDeps = getCronDeps(state);

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: "discord:channel:ops",
        contextKey: "cron:test",
      });
      cronDeps?.requestHeartbeat?.({
        source: "cron",
        intent: "event",
        reason: "cron:test",
        sessionKey: "discord:channel:ops",
      });

      expect(lastCallRecord(enqueueSystemEventMock, 1)).toMatchObject({
        contextKey: "cron:test",
        sessionKey: "agent:primary:discord:channel:ops",
      });
      expect(lastCallRecord(requestHeartbeatMock, 0)).toMatchObject({
        agentId: "primary",
        sessionKey: "agent:primary:discord:channel:ops",
      });
    });
  });

  it("rejects unknown agent-prefixed keys instead of rebinding them to the default agent", async () => {
    const cfg = createCronConfig("server-cron-unknown-agent");
    cfg.agents = { entries: { primary: { model: "test/primary" }, ops: { model: "test/ops" } } };
    await withCronService(cfg, async (state) => {
      const cronDeps = getCronDeps(state);

      expect(() =>
        cronDeps?.enqueueSystemEvent?.("hello", { sessionKey: "agent:ghost:discord:channel:ops" }),
      ).toThrow("cron job agent is unavailable: ghost");
      expect(() =>
        cronDeps?.requestHeartbeat?.({
          source: "cron",
          intent: "event",
          reason: "cron:test",
          sessionKey: "agent:ghost:discord:channel:ops",
        }),
      ).toThrow("cron job agent is unavailable: ghost");
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      expect(requestHeartbeatMock).not.toHaveBeenCalled();
    });
  });

  it("threads cron wake sessionKey through the CronService adapter", async () => {
    const cfg = createMultiAgentConfig("server-cron-wake-service");
    await withCronService(cfg, async (state) => {
      const sessionKey = "agent:ops:cron:nightly:run:abc-123";
      await expect(state.cron.wake({ mode: "now", text: "hello", sessionKey })).resolves.toEqual({
        ok: true,
      });

      expect(
        callArg(
          enqueueSystemEventMock,
          enqueueSystemEventMock.mock.calls.length - 1,
          0,
          "event text",
        ),
      ).toBe("hello");
      expect(lastCallRecord(enqueueSystemEventMock, 1).sessionKey).toMatch(/^agent:ops:/);
      expect(lastCallRecord(requestHeartbeatMock, 0)).toMatchObject({
        source: "manual",
        intent: "immediate",
        reason: "wake",
        agentId: "ops",
        sessionKey: expect.stringMatching(/^agent:ops:/),
      });
    });
  });

  it("routes a targetless cron wake through the configured system agent", async () => {
    const cfg = {
      ...createCronConfig("server-cron-system-owner-wake"),
      agents: { defaults: { systemAgent: { agentId: "ops" } }, entries: { main: {}, ops: {} } },
    } as OpenClawConfig;
    await withCronService(cfg, async (state) => {
      expect(await state.cron.wake({ mode: "now", text: "system wake" })).toEqual({ ok: true });

      expect(lastCallRecord(enqueueSystemEventMock, 1)).toMatchObject({
        sessionKey: "agent:ops:main",
      });
      expect(lastCallRecord(requestHeartbeatMock, 0)).toMatchObject({
        source: "manual",
        agentId: "ops",
        sessionKey: "agent:ops:main",
      });
    });
  });

  it.each([
    {
      name: "blocks loopback by default",
      ssrfPolicy: undefined,
      expectedRequests: 0,
      expectedDeliveryStatus: "not-delivered",
    },
    {
      name: "allows loopback with the private-network opt-in",
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      expectedRequests: 1,
      expectedDeliveryStatus: "delivered",
    },
    {
      name: "allows exactly configured loopback hostnames",
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      expectedRequests: 1,
      expectedDeliveryStatus: "delivered",
    },
  ])("$name", async ({ ssrfPolicy, expectedRequests, expectedDeliveryStatus }) => {
    const receivedMethods: string[] = [];
    const server = createServer((req, res) => {
      receivedMethods.push(req.method ?? "");
      req.resume();
      res.writeHead(204).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback webhook listener address");
    }

    const cfg = createCronConfig(`server-cron-ssrf-${expectedDeliveryStatus}`);
    if (ssrfPolicy) {
      cfg.cron = { ...cfg.cron, webhookSsrfPolicy: ssrfPolicy };
    }
    loadConfigMock.mockReturnValue(cfg);
    const actualFetchGuard = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
      "../infra/net/fetch-guard.js",
    );
    fetchWithSsrFGuardMock.mockImplementationOnce(actualFetchGuard.fetchWithSsrFGuard);

    const state = createCronService(cfg);
    try {
      const job = await addSystemEventJob(state, "ssrf-webhook-blocked", "hello", {
        deleteAfterRun: false,
        sessionTarget: "main",
        delivery: {
          mode: "webhook",
          to: `http://127.0.0.1:${address.port}/cron-finished`,
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(receivedMethods).toEqual(Array.from({ length: expectedRequests }, () => "POST"));
      const updatedState = state.cron.getJob(job.id)?.state;
      expect(updatedState).toMatchObject({
        lastRunStatus: "ok",
        lastDelivered: expectedRequests === 1,
        lastDeliveryStatus: expectedDeliveryStatus,
      });
      if (expectedRequests === 0) {
        expect(updatedState?.lastDeliveryError).toMatch(/blocked.*private|private.*blocked/i);
      } else {
        expect(updatedState?.lastDeliveryError).toBeUndefined();
      }
    } finally {
      state.cron.stop();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("passes opaque custom session targets through to isolated cron runs", async () => {
    const cfg = createCronConfig("server-cron-custom-session");
    await withCronService(cfg, async (state) => {
      const sessionKey = "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
      const job = await addAgentTurnJob(state, "custom-session", "hello", {
        sessionTarget: `session:${sessionKey}`,
      });

      await state.cron.run(job.id, "force");

      const options = expectIsolatedRunFields({ sessionKey });
      expect(requireRecord(options.job, "isolated job").id).toBe(job.id);
    });
  });

  it("removes only one agent's cron jobs and restores them if roster commit fails", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-delete-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: {
        defaults: { workspace: path.join(tmpDir, "workspace") },
        entries: { main: {}, yinze: {}, other: {} },
      },
    } as OpenClawConfig;
    const state = loadCronService(cfg);
    const addJob = async (agentId: string, name: string) =>
      await addAgentTurnJob(state, name, name, {
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        agentId,
      });
    try {
      await addJob("yinze", "deleted-one");
      await addJob("yinze", "deleted-two");
      await addJob("other", "kept");

      await expect(
        state.cron.removeAgentJobsTransactional("yinze", async () => {
          throw new Error("config commit failed");
        }),
      ).rejects.toThrow("config commit failed");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual(
        expect.arrayContaining(["deleted-one", "deleted-two", "kept"]),
      );

      await state.cron.removeAgentJobsTransactional("yinze", async () => "committed");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "kept",
      ]);
    } finally {
      state.cron.stop();
    }
  });

  it("keeps removed jobs deleted when the roster commit outcome is uncertain", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-uncertain-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: { entries: { main: {}, yinze: {}, other: {} } },
    } as OpenClawConfig;
    await withCronService(cfg, async (state) => {
      for (const [agentId, name] of [
        ["yinze", "deleted"],
        ["other", "kept"],
      ] as const) {
        await addAgentTurnJob(state, name, name, {
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          agentId,
        });
      }

      await expect(
        state.cron.removeAgentJobsTransactional("yinze", async () => {
          throw new AgentDeletionCommitUncertainError(new Error("config outcome unknown"));
        }),
      ).rejects.toThrow("config outcome unknown");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "kept",
      ]);
    });
  });

  it("keeps agent-less jobs owned by the current runtime default", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-default-change-${Date.now()}`);
    const startupCfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: { entries: { yinze: {} } },
    } as OpenClawConfig;
    const runtimeCfg = {
      ...startupCfg,
      agents: { entries: { other: {} } },
    } as OpenClawConfig;
    await withCronService(startupCfg, async (state) => {
      await addAgentTurnJob(state, "follows-runtime-default", "keep", {
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      });
      loadConfigMock.mockReturnValue(runtimeCfg);

      await state.cron.removeAgentJobsTransactional("yinze", async () => {});
      await expect(
        state.cron.add({
          name: "new-runtime-default",
          enabled: true,
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "keep too" },
        }),
      ).resolves.toBeDefined();
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "follows-runtime-default",
        "new-runtime-default",
      ]);
    });
  });

  it("rejects an agent job queued while that agent is removed from the roster", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-delete-race-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: {
        defaults: { workspace: path.join(tmpDir, "workspace") },
        entries: { main: {}, yinze: {} },
      },
    } as OpenClawConfig;
    const deletedCfg = {
      ...cfg,
      agents: { ...cfg.agents, entries: { main: {} } },
    } as OpenClawConfig;
    const state = loadCronService(cfg);
    const commitStarted = createDeferred();
    const releaseCommit = createDeferred();
    try {
      await addAgentTurnJob(state, "old-job", "old", {
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        agentId: "yinze",
      });
      const retained = await addAgentTurnJob(state, "retained-job", "retained", {
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        agentId: "main",
      });
      const removal = state.cron.removeAgentJobsTransactional("yinze", async () => {
        commitStarted.resolve();
        await releaseCommit.promise;
      });
      await commitStarted.promise;
      loadConfigMock.mockReturnValue(deletedCfg);
      const lateAdd = addAgentTurnJob(state, "late-job", "late", {
        schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
        agentId: "yinze",
      });
      const lateUpdate = state.cron.update(retained.id, { agentId: "yinze" });
      releaseCommit.resolve();

      await removal;
      await expect(lateAdd).rejects.toThrow("cron job agent is unavailable: yinze");
      await expect(lateUpdate).rejects.toThrow("cron job agent is unavailable: yinze");
      expect((await state.cron.list({ includeDisabled: true })).map((job) => job.name)).toEqual([
        "retained-job",
      ]);
    } finally {
      releaseCommit.resolve();
      state.cron.stop();
    }
  });

  it("broadcasts refreshed session rows when cron bindings change", async () => {
    const cfg = createCronConfig("server-cron-binding-broadcast");
    const sessionStorePath = path.join(
      os.tmpdir(),
      `server-cron-binding-broadcast-sessions-${Date.now()}`,
      "sessions.json",
    );
    (cfg.session as { store?: string }).store = sessionStorePath;
    const fs = await import("node:fs/promises");
    await fs.mkdir(path.dirname(sessionStorePath), { recursive: true });
    await fs.writeFile(
      sessionStorePath,
      JSON.stringify({ "agent:main:probe": { sessionId: "sess-probe", updatedAt: Date.now() } }),
      "utf-8",
    );
    loadConfigMock.mockReturnValue(cfg);
    const broadcast = vi.fn();
    await withCronService(
      cfg,
      async (state) => {
        // The automation source registers on start (stale-reload safety).
        await state.cron.start();
        const sessionsChanged = () =>
          broadcast.mock.calls.filter((call) => call[0] === "sessions.changed");
        const job = await addAgentTurnJob(state, "bound schedule", "ping", {
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          sessionTarget: "session:agent:main:probe",
        });
        // Payload row fields depend on shared-process session-store state, so
        // this test pins only the broadcast mechanism; hasAutomation projection
        // is covered by session-utils and session-automation-index tests.
        const added = requireRecord(sessionsChanged().at(-1)?.[1], "added payload");
        expect(added.sessionKey).toBe("agent:main:probe");
        expect(added.reason).toBe("cron-binding");

        broadcast.mockClear();
        await state.cron.update(job.id, { enabled: false });
        const disabled = requireRecord(sessionsChanged().at(-1)?.[1], "disabled payload");
        expect(disabled.sessionKey).toBe("agent:main:probe");
        expect(disabled.reason).toBe("cron-binding");
      },
      { broadcast },
    );
  });

  registerGatewayCronContextTests({
    createCronConfig,
    createCronService,
    getCronState,
    addAgentTurnJob,
    addSystemEventJob,
    loadConfigMock,
    runCronIsolatedAgentTurnMock,
    requestHeartbeatAndWaitMock,
  });

  registerGatewayCronQueueTests({
    createCronConfig,
    loadCronService,
    withCronService,
    getCronState,
    addAgentTurnJob,
    loadConfigMock,
    runCronIsolatedAgentTurnMock,
    expectIsolatedRunFields,
  });

  // Retain holny's execution-failure sibling control separately from activation failure.
  it("does not skip due cron-expression siblings after an execution failure", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-13T18:15:00.000Z");
    vi.setSystemTime(now);
    const clock = createGatewaySchedulerClock(now);
    const cfg = createCronConfig("server-cron-batch-sibling-failure");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    try {
      await state.cron.start();
      const jobIds: string[] = [];
      for (const name of ["batch-job-a", "batch-job-b", "batch-job-c"]) {
        const job = await addAgentTurnJob(state, name, `run ${name}`, {
          agentId: "main",
          delivery: { mode: "none" },
          schedule: { kind: "cron", expr: "* * * * *", staggerMs: 0 },
        });
        jobIds.push(job.id);
      }
      runCronIsolatedAgentTurnMock.mockImplementationOnce(async () => {
        throw new Error("first sibling execution failure");
      });
      vi.setSystemTime(now + 60_000);
      clock.setTime(Date.now());
      await onCronTimer(getCronState(state));
      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledTimes(3);
      const attemptedIds = runCronIsolatedAgentTurnMock.mock.calls.map(
        (_, index) =>
          requireRecord(
            callRecord(runCronIsolatedAgentTurnMock, index).job,
            "scheduled sibling job",
          ).id,
      );
      expect(new Set(attemptedIds)).toEqual(new Set(jobIds));
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });
});

it("rejects already-running admission so the watcher records the failed handoff", async () => {
  const job: CronJob = {
    ...cronJob("watched command", { kind: "systemEvent", text: "done" }),
    id: "job-x",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    state: {},
  };
  const exit = runExit({ reason: "exit", exitCode: 3, stdout: "built ok\n", stderr: "warned\n" });
  const run = vi.fn<Parameters<typeof fireOnExitJob>[2]["run"]>(async () => ({
    ok: true,
    ran: false,
    reason: "already-running",
  }));
  await expect(fireOnExitJob(job, exit, { run })).rejects.toThrow("already-running");
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
