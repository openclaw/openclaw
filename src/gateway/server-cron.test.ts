// Gateway cron tests cover isolated and ordinary session turns, completion
// delivery, lifecycle cleanup, hook emission, and SSRF-guarded webhooks.
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRequireRecord } from "../../test/helpers/record.js";
import { AgentDeletionCommitUncertainError } from "../agents/agent-lifecycle-registry.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { createReplyOperation, replyRunRegistry } from "../auto-reply/reply/reply-run-registry.js";
import { captureSessionEventTargetForHost } from "../auto-reply/reply/session-event-handoff.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import type * as deliveryTarget from "../cron/isolated-agent/delivery-target.js";
import { CronService } from "../cron/service.js";
import { onTimer as onCronTimer } from "../cron/service/timer.test-support.js";
import { loadCronStore } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
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
import type { RunExit } from "../process/supervisor/types.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
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
import { registerGatewayCronReceiptTests } from "./server-cron.receipts.test-support.js";
import { registerGatewayCronWakeTests } from "./server-cron.wake.test-support.js";

type RunCronIsolatedAgentTurnMock = (params: {
  abortSignal?: AbortSignal;
}) => Promise<{ status: "ok"; summary: string }>;

const {
  enqueueSystemEventMock,
  systemEventReceiptRemoveMock,
  enqueueSessionEventMock,
  runSessionEventMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  sendCronAnnouncePayloadStrictMock,
  resolveDeliveryTargetMock,
  runCronIsolatedAgentTurnMock,
  getGlobalHookRunnerMock,
  runCronChangedMock,
  abortAndDrainEmbeddedAgentRunMock,
  retireSessionMcpRuntimeMock,
  requestSafeGatewayRestartMock,
  getProcessSupervisorMock,
  createCronScriptRuntimeMock,
  cronTriggerEvaluatorMock,
  cronScriptExecutorMock,
  isAgentDeletionBlockedMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  systemEventReceiptRemoveMock: vi.fn(() => true),
  enqueueSessionEventMock: vi.fn((..._args: unknown[]) => ({
    id: "event",
    accepted: Promise.resolve({ ok: true as const }),
    cancel: () => true,
    settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
  })),
  runSessionEventMock: vi.fn<(...args: unknown[]) => Promise<CronRunOutcome>>(async () => ({
    status: "ok",
    summary: "ok",
  })),
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
  resolveDeliveryTargetMock: vi.fn<typeof deliveryTarget.resolveDeliveryTarget>(
    async (_cfg, agentId, target) => {
      const channel = !target.channel || target.channel === "last" ? "telegram" : target.channel;
      const to = target.to ?? "123";
      const sessionKey = `agent:${agentId}:${channel}:direct:${to}`;
      return {
        ok: true,
        channel,
        to,
        accountId: target.accountId,
        threadId: target.threadId,
        mode: "explicit",
        sessionRoute: {
          sessionKey,
          baseSessionKey: sessionKey,
          peer: { kind: "direct", id: to },
          chatType: "direct",
          from: `${channel}:${to}`,
          to,
          recipientSessionExact: false,
        },
      };
    },
  ),
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
  >(async () => ({
    aborted: true,
    drained: true,
    forceCleared: false,
  })),
  retireSessionMcpRuntimeMock: vi.fn(async () => true),
  requestSafeGatewayRestartMock: vi.fn(() => ({
    ok: true,
    status: "scheduled",
    preflight: {
      safe: true,
      counts: {
        queueSize: 0,
        pendingReplies: 0,
        embeddedRuns: 0,
        cronRuns: 0,
        backgroundExecSessions: 0,
        rootRequests: 0,
        agentRuns: 0,
        acpRuns: 0,
        mediaRuns: 0,
        totalActive: 0,
      },
      blockers: [],
      summary: "safe to restart now",
    },
    restart: {
      ok: true,
      pid: 123,
      signal: "SIGUSR2",
      delayMs: 0,
      reason: "cron.isolated_agent_setup_timeout",
      mode: "emit",
      coalesced: false,
      cooldownMsApplied: 0,
    },
  })),
  getProcessSupervisorMock: vi.fn(() => ({
    spawn: vi.fn(),
    cancelScope: vi.fn(),
  })),
  createCronScriptRuntimeMock: vi.fn(),
  cronTriggerEvaluatorMock: vi.fn(),
  cronScriptExecutorMock: vi.fn(),
  isAgentDeletionBlockedMock: vi.fn((_agentId: string) => false),
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

vi.mock("../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/system-events.js")>()),
  enqueueSystemEvent,
  enqueueSystemEventWithReceipt,
}));

// mock-isolation: Cron wiring uses controlled receipts without admitting or executing real session turns.
vi.mock("../auto-reply/reply/session-event-handoff.js", () => ({
  enqueueSessionEventForHost: enqueueSessionEventMock,
  captureSessionEventTargetForHost: vi.fn(async (agentId: string, sessionKey: string) => ({
    agentId,
    sessionKey,
    sessionId: "original",
    generation: "process",
  })),
  assertSessionEventTargetCurrent: () => {},
}));
// mock-isolation: Exercise Gateway cron wiring without running a shared-session agent turn.
vi.mock("../cron/session-run.js", () => ({ runCronSessionTurn: runSessionEventMock }));

vi.mock("../infra/restart-coordinator.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/restart-coordinator.js")>(
    "../infra/restart-coordinator.js",
  );
  return {
    ...actual,
    scheduleSafeGatewayRestart: requestSafeGatewayRestartMock,
  };
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock(),
  };
});

vi.mock("../config/io.js", async () => {
  const actual = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  return {
    ...actual,
    getRuntimeConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../cron/delivery.js")>("../cron/delivery.js");
  return {
    ...actual,
    sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock,
  };
});

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

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

vi.mock("../agents/agent-lifecycle-registry.js", () => ({
  AgentDeletionAuthorityRollbackError: class extends AggregateError {},
  AgentDeletionCommitUncertainError: class extends Error {},
  isAgentDeletionBlocked: isAgentDeletionBlockedMock,
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
import type { CronJob, CronJobCreate, CronRunOutcome } from "../cron/types.js";
import { fireOnExitJob } from "./server-cron-event-dispatch.js";
import { buildGatewayCronService as buildGatewayCronServiceRuntime } from "./server-cron.js";

function buildGatewayCronService(params: Parameters<typeof buildGatewayCronServiceRuntime>[0]) {
  const legacyStore = (params.cfg.cron as { store?: unknown } | undefined)?.store;
  if (typeof legacyStore !== "string") {
    return buildGatewayCronServiceRuntime(params);
  }
  const env = {
    ...process.env,
    OPENCLAW_SKIP_CRON: "0",
    OPENCLAW_STATE_DIR: path.dirname(legacyStore),
  };
  // These fixtures predate the config-to-SQLite move; seed the canonical machine-state owner.
  writeConfigMachineState("cron.store", legacyStore, { env });
  return buildGatewayCronServiceRuntime({ ...params, env });
}

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
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
  run: (state: CronServiceFixture) => Promise<void>,
) {
  const state = loadCronService(cfg);
  try {
    await run(state);
  } finally {
    state.cron.stop();
  }
}

function getCronState(service: CronServiceFixture): CronServiceState {
  return (service.cron as unknown as { state: CronServiceState }).state;
}

type CronTestDeps = Omit<CronServiceState["deps"], "enqueueSystemEvent"> & {
  enqueueSystemEvent?: (
    text: string,
    opts?: Partial<Parameters<NonNullable<CronServiceState["deps"]["enqueueSystemEvent"]>>[1]>,
  ) => unknown;
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

function addSystemEventJob(
  service: CronServiceFixture,
  name: string,
  text: string,
  overrides: CronJobOverrides = {},
) {
  return addCronJob(service, name, { kind: "systemEvent", text }, overrides);
}

function addAgentTurnJob(
  service: CronServiceFixture,
  name: string,
  message: string,
  overrides: CronJobOverrides = {},
) {
  return addCronJob(service, name, { kind: "agentTurn", message }, overrides);
}

function addCommandJob(
  service: CronServiceFixture,
  name: string,
  source: string,
  overrides: CronJobOverrides = {},
) {
  return addCronJob(
    service,
    name,
    { kind: "command", argv: [process.execPath, "-e", source] },
    overrides,
  );
}

function addScriptJob(
  service: CronServiceFixture,
  name: string,
  script: string,
  overrides: CronJobOverrides = {},
) {
  return addCronJob(service, name, { kind: "script", script }, overrides);
}

function runExit(overrides: Partial<RunExit> = {}): RunExit {
  return {
    reason: "manual-cancel",
    exitCode: null,
    exitSignal: null,
    durationMs: 1,
    stdout: "",
    stderr: "",
    timedOut: false,
    noOutputTimedOut: false,
    ...overrides,
  };
}

function createWatchedRun(settleOnCancel = true, exitResult: Partial<RunExit> = {}) {
  const exit = createDeferred<RunExit>();
  return {
    exit,
    startedAtMs: Date.now(),
    cancel: vi.fn(() => {
      if (settleOnCancel) {
        exit.resolve(runExit(exitResult));
      }
    }),
    detachOutput: vi.fn(),
    wait: vi.fn(() => exit.promise),
  };
}

function mockCronSupervisor(...runs: ReturnType<typeof createWatchedRun>[]) {
  let nextRun = 0;
  const spawn = vi.fn(async () => {
    const index = nextRun++;
    return {
      ...(runs.length ? expectDefined(runs[index], "watched process") : createWatchedRun()),
      runId: `cron-watch-${index}`,
    };
  });
  const cancelScope = vi.fn();
  getProcessSupervisorMock.mockReturnValue({ spawn, cancelScope });
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

function expectHookContext(callIndex: number, fields: { config?: unknown; hasGetCron?: boolean }) {
  const context = requireRecord(
    callArg(runCronChangedMock, callIndex, 1, "cron_changed context"),
    "cron_changed context",
  );
  if ("config" in fields) {
    expect(context.config).toBe(fields.config);
  }
  if (fields.hasGetCron === true) {
    expect(context.getCron).toBeTypeOf("function");
  }
}

function expectIsolatedRunFields(fields: Record<string, unknown>) {
  const options = requireRecord(
    callArg(runCronIsolatedAgentTurnMock, 0, 0, "isolated cron run"),
    "isolated cron run",
  );
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
    enqueueSessionEventMock.mockClear();
    vi.mocked(captureSessionEventTargetForHost).mockClear();
    runSessionEventMock.mockReset().mockResolvedValue({ status: "ok", summary: "ok" });
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    sendCronAnnouncePayloadStrictMock.mockClear();
    resolveDeliveryTargetMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    runCronChangedMock.mockClear();
    getGlobalHookRunnerMock.mockClear();
    abortAndDrainEmbeddedAgentRunMock.mockClear();
    retireSessionMcpRuntimeMock.mockClear();
    requestSafeGatewayRestartMock.mockClear();
    getProcessSupervisorMock.mockReset();
    getProcessSupervisorMock.mockReturnValue({
      spawn: vi.fn(),
      cancelScope: vi.fn(),
    });
    cronTriggerEvaluatorMock.mockReset();
    cronTriggerEvaluatorMock.mockResolvedValue({ kind: "evaluated", fire: false });
    cronScriptExecutorMock.mockReset();
    isAgentDeletionBlockedMock.mockReset().mockReturnValue(false);
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

  it("keeps sole-agent ownerless jobs dynamic across a restart and roster rename", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-sole-owner-${Date.now()}`);
    const store = path.join(tmpDir, "cron.json");
    const opsCfg = {
      cron: { store },
      agents: { entries: { ops: {} } },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(opsCfg);
    const initial = createCronService(opsCfg);
    await initial.cron.start();
    const job = await addCronJob(
      initial,
      "dynamic sole owner",
      { kind: "agentTurn", message: "follow the live owner" },
      { schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() } },
    );
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
      await expect(restarted.cron.run(job.id, "force")).resolves.toEqual({
        ok: true,
        ran: true,
      });
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
      const job = await addCronJob(
        state,
        "scheduled system owner",
        { kind: "agentTurn", message: "run on schedule" },
        { schedule: { kind: "every", everyMs: 60_000 } },
      );
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

      expect(state.cron.getJob(job.id)?.state).toMatchObject({
        lastStatus: "ok",
        consecutiveErrors: 0,
        lastError: undefined,
      });
      expect(getCronState(state).activeTimerTicks).toBe(0);
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
    const cfg = createCronConfig("server-cron-trigger-tool-cap");
    cfg.cron = {
      ...cfg.cron,
      triggers: { enabled: true },
    };
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
      await addCronJob(
        state,
        "restart watched build",
        { kind: "systemEvent", text: "done" },
        {
          schedule: { kind: "on-exit", command: "sleep 60" },
          sessionTarget: "main",
        },
      );
      await state.reconcileExitWatchers?.();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());

      state.cron.stop();
      await state.reconcileExitWatchers?.();
      expect(spawn).toHaveBeenCalledOnce();

      await state.cron.start();
      await state.reconcileExitWatchers?.();
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2));
    });
  });

  registerGatewayCronHandoffTests({
    createWatchedRun,
    mockCronSupervisor,
    createCronConfig,
    loadCronService,
    getConcreteCron,
    addCronJob,
    runExit,
    runSessionEventMock,
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
        expect(runSessionEventMock).not.toHaveBeenCalled();
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
          await addCronJob(
            state,
            "Watch concurrent mutation",
            { kind: "systemEvent", text: "done" },
            {
              schedule: { kind: "on-exit", command: "sleep 60" },
              sessionTarget: "main",
            },
          );
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
      runSessionEventMock.mockImplementationOnce(async () => {
        await releasePayload.promise;
        return { status: "ok", summary: "completed" };
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
        await vi.waitFor(() => expect(runSessionEventMock).toHaveBeenCalledOnce());
        expect(state.cron.getJob(job.id)?.enabled).toBe(false);
        await state.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledOnce();

        const rearmed = await state.cron.update(job.id, {
          enabled: true,
          schedule: { kind: "on-exit", command },
        });
        expect(rearmed.updatedAtMs).toBe(job.updatedAtMs);
        await state.reconcileExitWatchers();
        expect(spawn).toHaveBeenCalledTimes(2);

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
        await vi.waitFor(() => expect(runSessionEventMock).toHaveBeenCalledTimes(2));
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

  registerGatewayCronReceiptTests({
    getCronState,
    createWatchedRun,
    mockCronSupervisor,
    createCronConfig,
    loadCronService,
    getCronDeps,
    getConcreteCron,
    addCronJob,
    runExit,
  });

  it("persists an existing watcher exit during drain but fences its new scheduled run", async () => {
    resetGatewayWorkAdmission();
    const watched = createWatchedRun(false);
    const commandExit = watched.exit;
    const { spawn } = mockCronSupervisor(watched);
    const state = loadCronService(createCronConfig("server-cron-on-exit-draining"));
    let suspensionAdmission: ReturnType<typeof tryBeginGatewaySuspendAdmission> | undefined;

    try {
      const job = await addCronJob(
        state,
        "watch and drain naturally",
        { kind: "systemEvent", text: "done" },
        {
          schedule: { kind: "on-exit", command: "true" },
          sessionTarget: "main",
          wakeMode: "now",
        },
      );
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
      expect(runSessionEventMock).not.toHaveBeenCalled();

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
        runSessionEventMock.mockImplementationOnce(async () => {
          await holdPredecessor();
          return { status: "ok", summary: "completed" };
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
          sessionTarget === "main" ? runSessionEventMock : runCronIsolatedAgentTurnMock;
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

    async function cleanupTimedOutCronRun(
      state: CronServiceFixture,
      sessionTarget: "isolated" | "main" = "isolated",
    ) {
      const job = await addAgentTurnJob(state, "shared session turn", "work", { sessionTarget });
      abortAndDrainEmbeddedAgentRunMock.mockImplementation(abortAndDrainEmbeddedAgentRun);
      await getCronDeps(state).cleanupTimedOutAgentRun?.({
        job,
        timeoutMs: 600_000,
        execution: { jobId: job.id, sessionId, sessionKey, runId: "cron-run" },
      });
    }

    const replyOwners: Array<ReturnType<typeof createReplyOperation>> = [];

    function registerRun(
      runId: string,
      kind: "embedded" | "cli" = "embedded",
      onAbort?: () => void,
    ) {
      if (kind === "cli") {
        const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
        const abort = vi.fn(() => {
          operation.complete();
          onAbort?.();
        });
        operation.attachBackend({ kind: "cli", runId, cancel: abort });
        operation.setPhase("running");
        replyOwners.push(operation);
        return { abort, isActive: () => replyRunRegistry.get(sessionKey) === operation };
      }
      const handle = createEmbeddedRunHandle({
        runId,
        abort: vi.fn(() => {
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
          onAbort?.();
        }),
      });
      setActiveEmbeddedRun(sessionId, handle, sessionKey);
      return { abort: handle.abort, isActive: () => isEmbeddedAgentRunHandleActive(sessionId) };
    }

    afterEach(() => {
      for (const operation of replyOwners.splice(0)) {
        operation.complete();
      }
      embeddedRunsTesting.resetActiveEmbeddedRuns();
      abortAndDrainEmbeddedAgentRunMock.mockReset();
    });

    it.each(["embedded", "cli"] as const)(
      "leaves a replacement %s run and its MCP runtime intact after the cron run ended",
      async (kind) => {
        await withCronService(
          createCronConfig("server-cron-timeout-replacement"),
          async (state) => {
            const replacement = registerRun("replacement-run", kind);

            await cleanupTimedOutCronRun(state, kind === "cli" ? "main" : "isolated");

            expect(replacement.abort).not.toHaveBeenCalled();
            expect(replacement.isActive()).toBe(true);
            expect(retireSessionMcpRuntimeMock).not.toHaveBeenCalled();
          },
        );
      },
    );

    it.each(["embedded", "cli"] as const)(
      "aborts the %s cron run and retires its MCP runtime while it still owns the session",
      async (kind) => {
        await withCronService(createCronConfig("server-cron-timeout-owner"), async (state) => {
          const original = registerRun("cron-run", kind);

          await cleanupTimedOutCronRun(state, kind === "cli" ? "main" : "isolated");

          expect(original.abort).toHaveBeenCalledOnce();
          expect(original.isActive()).toBe(false);
          expect(retireSessionMcpRuntimeMock).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ sessionId, reason: "cron-timeout-cleanup" }),
          );
        });
      },
    );
    it("keeps a successor reply even when the old embedded handle still matches", async () => {
      await withCronService(createCronConfig("server-cron-timeout-two-owners"), async (state) => {
        const original = registerRun("cron-run");
        const successor = registerRun("reply-successor", "cli");
        await cleanupTimedOutCronRun(state);
        expect(original.abort).not.toHaveBeenCalled();
        expect(successor.abort).not.toHaveBeenCalled();
        expect(successor.isActive()).toBe(true);
        expect(retireSessionMcpRuntimeMock).not.toHaveBeenCalled();
      });
    });

    it("keeps the MCP runtime of a successor admitted while timeout drainage settles", async () => {
      await withCronService(
        createCronConfig("server-cron-timeout-drain-successor"),
        async (state) => {
          const successorReady = createDeferred<ReturnType<typeof registerRun>>();
          const original = registerRun("cron-run", "cli", () => {
            queueMicrotask(() => successorReady.resolve(registerRun("reply-successor", "cli")));
          });
          await cleanupTimedOutCronRun(state, "main");
          const successor = await successorReady.promise;
          expect(original.abort).toHaveBeenCalledOnce();
          expect(successor.abort).not.toHaveBeenCalled();
          expect(successor.isActive()).toBe(true);
          expect(retireSessionMcpRuntimeMock).not.toHaveBeenCalled();
        },
      );
    });
  });

  it("keeps a stream source running when a conditional or invalid update is rejected", async () => {
    const watched = createWatchedRun();
    const { cancel, detachOutput } = watched;
    const { spawn } = mockCronSupervisor(watched);
    const cfg = createCronConfig("server-cron-stream-rejected-update");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    const state = loadCronService(cfg);

    try {
      const added = await addSystemEventJob(state, "stream source", "event", {
        schedule: { kind: "stream", command: ["source"] },
        sessionTarget: "main",
      });
      const streamJob = "job" in added ? added.job : added;
      const sourceIdentity = streamJob.state.streamSourceIdentity;
      await expect(
        state.cron.updateWithPrecondition(streamJob.id, { enabled: false }, () => {
          throw new Error("revision mismatch");
        }),
      ).rejects.toThrow("revision mismatch");
      await expect(
        state.cron.update(streamJob.id, {
          schedule: { kind: "stream", command: [] },
        }),
      ).rejects.toThrow("non-empty command argv array");
      await state.cron.update(streamJob.id, {
        schedule: { kind: "stream", command: ["source"] },
      });

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
    const cfg = createCronConfig("server-cron-stream-stale-snapshot");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    const state = loadCronService(cfg);

    try {
      // Gate reconcile's first list call: capture the pre-add (empty) snapshot,
      // hold it while the add's direct route starts the owner, then release the
      // stale snapshot. The revision fence must re-list instead of stopping the
      // freshly started owner as "removed".
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
      const added = await addSystemEventJob(state, "stale snapshot stream source", "event", {
        schedule: { kind: "stream", command: ["source"] },
        sessionTarget: "main",
      });
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

  it.each(["immediate", "retirement queued"] as const)(
    "drains stream teardown once when stop and stopAndDrain overlap (%s)",
    async (timing) => {
      const watched = createWatchedRun();
      const { cancel } = watched;
      mockCronSupervisor(watched);
      const cfg = createCronConfig("server-cron-stream-single-drain");
      cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
      const state = loadCronService(cfg);
      const cron = getConcreteCron(state);
      const lockEntered = createDeferred();
      const releaseLock = createDeferred();
      const retirementEntered = createDeferred();
      const blockerError = new Error("release the lock without committing the fixture update");
      let blocker: Promise<unknown> | undefined;
      const retire = cron.retireExternalStreamSource.bind(cron);
      const retirement = vi
        .spyOn(cron, "retireExternalStreamSource")
        .mockImplementation((...args) => {
          const pending = retire(...args);
          retirementEntered.resolve();
          return pending;
        });
      try {
        const job = await addSystemEventJob(state, "single drain stream source", "event", {
          schedule: { kind: "stream", command: ["source"] },
          sessionTarget: "main",
        });
        if (timing === "retirement queued") {
          blocker = cron
            .updateWithPrecondition(job.id, {}, async () => {
              lockEntered.resolve();
              await releaseLock.promise;
              throw blockerError;
            })
            .catch((error: unknown) => error);
          await lockEntered.promise;
        }
        state.cron.stop();
        if (timing === "retirement queued") {
          // The native retirement captured this shutdown before its lock became available.
          await retirementEntered.promise;
        }
        const drained = expect(
          expectDefined(state.cron.stopAndDrain?.(), "Gateway scheduler drain"),
        ).resolves.toBeUndefined();
        releaseLock.resolve();
        if (blocker) {
          expect(await blocker).toBe(blockerError);
        }
        await drained;
        expect(retirement).toHaveBeenCalledOnce();
        expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        releaseLock.resolve();
        await blocker;
        retirement.mockRestore();
        await state.stopStreamWatchers?.();
        state.cron.stop();
      }
    },
  );

  it("retries stream teardown after a prior drain failure", async () => {
    vi.useFakeTimers();
    const watched = createWatchedRun(true, { durationMs: 10_000 });
    const { cancel } = watched;
    cancel.mockImplementationOnce(() => {});
    mockCronSupervisor(watched);
    const cfg = createCronConfig("server-cron-stream-retry-drain");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    const state = loadCronService(cfg);

    try {
      await addSystemEventJob(state, "retry drain stream source", "event", {
        schedule: { kind: "stream", command: ["source"] },
        sessionTarget: "main",
      });

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

  registerGatewayCronMutationAuthorityTests({
    createCronConfig,
    loadCronService,
    createCronService,
    addCronJob,
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
    const cfg = createCronConfig("server-cron-stream-remove-failure");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    const state = loadCronService(cfg);

    try {
      const added = await addSystemEventJob(state, "stubborn stream source", "event", {
        schedule: { kind: "stream", command: ["source"] },
        sessionTarget: "main",
      });
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
      const event = requireRecord(
        callArg(runCronChangedMock, scheduledCallIndex, 0, "scheduled cron_changed event"),
        "scheduled cron_changed event",
      );
      const persistedNextRunAtMs = state.cron.getJob(job.id)?.state.nextRunAtMs;
      expect(persistedNextRunAtMs).toBeGreaterThan(dueAtMs);
      expect(event).toMatchObject({
        action: "scheduled",
        jobId: job.id,
        nextRunAtMs: persistedNextRunAtMs,
        sessionTarget: "main",
        agentId: "main",
      });
      const eventJob = requireRecord(event.job, "scheduled cron_changed job");
      expect(eventJob.agentId).toBe("main");
      expect(requireRecord(eventJob.state, "scheduled cron_changed job state").nextRunAtMs).toBe(
        persistedNextRunAtMs,
      );
      expectHookContext(scheduledCallIndex, { config: runtimeCfg, hasGetCron: true });
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
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "123",
          },
        },
      );

      await state.cron.run(job.id, "force");

      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
      expect(state.cron.getJob(job.id)?.state.lastDeliveryError).toBeUndefined();
      expect(state.cron.getJob(job.id)?.state).toMatchObject({
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
      const cfg = createCronConfig(`cron-${payloadKind}-${reason}-${policy}`);
      cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
      loadConfigMock.mockReturnValue(cfg);
      cronScriptExecutorMock.mockResolvedValueOnce({
        kind: "completed",
        notify: "scheduled result",
        stateChanged: false,
      });
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

      const state = createCronService(cfg);
      try {
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
        const finished = runCronChangedMock.mock.calls
          .map(([event]) => requireRecord(event, "cron_changed event"))
          .find((event) => event.action === "finished" && event.jobId === job.id);
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
      } finally {
        state.cron.stop();
      }
    },
  );

  it("never resends accepted script output after a wrapped partial-delivery failure", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    const cfg = createCronConfig("server-cron-script-wrapped-partial");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "completed",
      notify: "scheduled result",
      stateChanged: false,
    });
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
      const job = await addCronJob(
        state,
        "script partial announcement",
        { kind: "script", script: "return { notify: 'scheduled result' }" },
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
      error: Object.assign(new Error("read ECONNRESET after sending"), {
        code: "ECONNRESET",
      }),
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

  it("does not retry cancelled command output while still notifying terminal failure", async () => {
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

        expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledTimes(2);
        const completion = sendCronAnnouncePayloadStrictMock.mock.calls[0]?.[0];
        const failure = sendCronAnnouncePayloadStrictMock.mock.calls[1]?.[0];
        expect(completion?.completion).toBeDefined();
        expect(completion?.payload).toEqual([
          expect.objectContaining({ text: "scheduled result" }),
        ]);
        expect(deliverySignal?.aborted).toBe(true);
        expect(failure?.completion).toBeUndefined();
        expect(failure?.payload).toEqual(
          expect.objectContaining({
            text: expect.stringContaining('Automation "cancelled" failed 1 times'),
          }),
        );
        expect(failure?.abortSignal).not.toBe(deliverySignal);
        expect(failure?.abortSignal?.aborted).toBe(false);
        expect(state.cron.getJob(job.id)).toMatchObject({
          enabled: false,
          state: { lastRunStatus: "error", lastError: "Cancelled by operator." },
        });
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
    const state = createCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    try {
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
      expect(updated?.state.lastRunStatus).toBe("error");
      expect(updated?.state.lastError).toBe("command exited with code 7");
      expect(updated?.state.consecutiveErrors).toBe(1);
      expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
      expect(updated?.state.lastDeliveryError).toBe(deliveryError);
      expect(updated?.state.nextRunAtMs).toBeGreaterThanOrEqual(
        (updated?.updatedAtMs ?? 0) + 30_000,
      );
    } finally {
      state.cron.stop();
    }
  });

  it("retains a one-shot command without changing execution status when required delivery fails", async () => {
    const cfg = createCronConfig("server-cron-command-required-delivery-failure");
    loadConfigMock.mockReturnValue(cfg);
    const deliveryError = "network unavailable while delivering command output";
    sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error(deliveryError));

    const state = createCronService(cfg);
    try {
      const job = await addCommandJob(
        state,
        "successful-command-required-delivery",
        "process.stdout.write('ok')",
        {
          deleteAfterRun: true,
          delivery: { mode: "announce", bestEffort: false },
        },
      );

      await state.cron.run(job.id, "force");

      const updated = state.cron.getJob(job.id);
      expect(updated?.enabled).toBe(false);
      expect(updated?.state.lastRunStatus).toBe("ok");
      expect(updated?.state.lastError).toBeUndefined();
      expect(updated?.state.consecutiveErrors).toBe(0);
      expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
      expect(updated?.state.lastDeliveryError).toBe(deliveryError);
      expect(updated?.state.nextRunAtMs).toBeUndefined();
      expect(
        runCronChangedMock.mock.calls
          .map((_, index) =>
            requireRecord(
              callArg(runCronChangedMock, index, 0, "cron_changed event"),
              "cron_changed event",
            ),
          )
          .find((event) => event.action === "finished" && event.jobId === job.id),
      ).toMatchObject({ status: "ok", completionStatus: "failed" });
    } finally {
      state.cron.stop();
    }
  });

  it("delivers isolated script notify through the cron announce path", async () => {
    const cfg = createCronConfig("server-cron-script-announce");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    cfg.gateway = { publicOrigin: "https://gateway.example", controlUi: { basePath: "/control" } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "completed",
      notify: "queue changed",
      stateChanged: false,
    });

    const state = createCronService(cfg);
    try {
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

      const stateDir = path.dirname(state.storePath);
      expect(stateDir).not.toBe(process.env.OPENCLAW_STATE_DIR);
      expect(captureSessionEventTargetForHost).toHaveBeenCalledExactlyOnceWith(
        "main",
        "agent:main:main",
        { env: expect.objectContaining({ OPENCLAW_STATE_DIR: stateDir }) },
      );
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
      expect(sendCronAnnouncePayloadStrictMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          jobId: job.id,
          payload: [{ text: "queue changed" }],
          inspectionUrl: `https://gateway.example/control/automations?job=${job.id}&run=cron%3A${job.id}%3A${state.cron.getJob(job.id)?.state.lastRunAtMs}`,
          target: expect.objectContaining({ threadId: 456 }),
        }),
      );
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      state.cron.stop();
    }
  });

  it("keeps script failure detail transient while preserving structured error payloads", async () => {
    const cfg = createCronConfig("server-cron-script-failure-detail");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
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
    const state = createCronService(cfg, { broadcast });

    try {
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

      const announceRequest = requireRecord(
        callArg(sendCronAnnouncePayloadStrictMock, 0, 0, "script failure announce request"),
        "script failure announce request",
      );
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

      const hookEvent = runCronChangedMock.mock.calls
        .map((_, index) =>
          requireRecord(
            callArg(runCronChangedMock, index, 0, "cron_changed event"),
            "cron_changed event",
          ),
        )
        .find((event) => event.action === "finished" && event.jobId === job.id);
      expect(hookEvent).not.toHaveProperty("failureNotificationDetail");
      expect(JSON.stringify(hookEvent)).not.toContain("failureNotificationDetail");

      const webhookRequest = requireRecord(
        callArg(fetchWithSsrFGuardMock, 0, 0, "script failure webhook request"),
        "script failure webhook request",
      );
      const webhookBody = JSON.parse(
        String(requireRecord(webhookRequest.init, "script failure webhook init").body),
      ) as Record<string, unknown>;
      expect(webhookBody.error).toContain(rawError);
      expect(webhookBody).not.toHaveProperty("failureNotificationDetail");
    } finally {
      state.cron.stop();
    }
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
      const cfg = createCronConfig(`server-cron-script-${name}`);
      cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
      loadConfigMock.mockReturnValue(cfg);
      cronScriptExecutorMock.mockResolvedValueOnce({
        kind: "completed",
        notify: "queue changed",
        stateChanged: false,
      });
      sendCronAnnouncePayloadStrictMock.mockRejectedValueOnce(new Error("delivery rejected"));

      const state = createCronService(cfg);
      try {
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
        expect(
          runCronChangedMock.mock.calls
            .map((_, index) =>
              requireRecord(
                callArg(runCronChangedMock, index, 0, "cron_changed event"),
                "cron_changed event",
              ),
            )
            .find((event) => event.action === "finished" && event.jobId === job.id),
        ).toMatchObject({ status: "ok", completionStatus: completion });
      } finally {
        state.cron.stop();
      }
    },
  );

  it("delivers isolated script notify through the cron webhook path", async () => {
    const cfg = createCronConfig("server-cron-script-webhook");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({
      kind: "completed",
      notify: "queue changed",
      stateChanged: false,
    });
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: new Response(null, { status: 204 }),
      finalUrl: "https://example.invalid/cron",
      release: vi.fn(async () => {}),
    });

    const state = createCronService(cfg);
    try {
      const job = await addScriptJob(
        state,
        "script-webhook",
        "return { notify: 'queue changed' }",
        {
          deleteAfterRun: false,
          delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
        },
      );

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      const request = requireRecord(
        callArg(fetchWithSsrFGuardMock, 0, 0, "script webhook request"),
        "script webhook request",
      );
      expect(String(requireRecord(request.init, "fetch init").body)).toContain(
        '"summary":"queue changed"',
      );
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      state.cron.stop();
    }
  });

  it("does not deliver a script webhook when notify is absent", async () => {
    const cfg = createCronConfig("server-cron-script-webhook-silent");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({ kind: "completed", stateChanged: false });

    const state = createCronService(cfg);
    try {
      const job = await addScriptJob(state, "silent-script-webhook", "return {}", {
        deleteAfterRun: false,
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");
    } finally {
      state.cron.stop();
    }
  });

  it("does not invoke delivery when a script omits notify", async () => {
    const cfg = createCronConfig("server-cron-script-silent");
    cfg.cron = { ...cfg.cron, triggers: { enabled: true } };
    loadConfigMock.mockReturnValue(cfg);
    cronScriptExecutorMock.mockResolvedValueOnce({ kind: "completed", stateChanged: false });

    const state = createCronService(cfg);
    try {
      const job = await addScriptJob(state, "silent-script", "return {}", {
        deleteAfterRun: true,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      await state.cron.run(job.id, "force");

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
    } finally {
      state.cron.stop();
    }
  });

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

      const event = runCronChangedMock.mock.calls
        .map((_, index) =>
          requireRecord(
            callArg(runCronChangedMock, index, 0, "cron_changed event"),
            "cron_changed event",
          ),
        )
        .find((hookEvent) => hookEvent.action === "finished");
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
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "123",
          },
        },
      );

      await state.cron.run(job.id, "force");

      const announcePayload = requireRecord(
        callArg(sendCronAnnouncePayloadStrictMock, 0, 0, "cron announce payload"),
        "cron announce payload",
      );
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
    "routes global-scope main jobs through ordinary session execution for %s",
    async (wakeMode) => {
      const cfg = {
        ...createCronConfig("server-cron-global"),
        session: { mainKey: "main", scope: "global" },
      } as OpenClawConfig;
      await withCronService(cfg, async (state) => {
        const job = await addSystemEventJob(state, "global", "hello global", {
          sessionTarget: "main",
          wakeMode,
        });
        await state.cron.run(job.id, "force");
        expect(runSessionEventMock).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            agentId: "main",
            sessionKey: "global",
            text: "hello global",
            job: expect.objectContaining({ id: job.id }),
          }),
        );
        expect(enqueueSystemEventMock).not.toHaveBeenCalled();
      });
    },
  );

  it("records the exact ordinary session turn failure", async () => {
    runSessionEventMock.mockResolvedValueOnce({ status: "error", error: "agent-runner-failure" });
    await withCronService(createCronConfig("server-cron-session-settlement"), async (state) => {
      const job = await addSystemEventJob(state, "failed session turn", "Run report", {
        sessionTarget: "main",
        deleteAfterRun: false,
      });
      await state.cron.run(job.id, "force");
      expect(state.cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "error",
        lastError: "agent-runner-failure",
      });
    });
  });

  registerGatewayCronWakeTests({
    createCronConfig,
    loadCronService,
    getCronDeps,
    enqueueSystemEventMock,
    enqueueSessionEventMock,
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

  it("passes opaque custom session targets through to ordinary cron runs", async () => {
    const cfg = createCronConfig("server-cron-custom-session");
    await withCronService(cfg, async (state) => {
      const sessionKey = "agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
      const job = await addAgentTurnJob(state, "custom-session", "hello", {
        sessionTarget: `session:${sessionKey}`,
      });

      await state.cron.run(job.id, "force");

      expect(runSessionEventMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          sessionKey,
          job: expect.objectContaining({ id: job.id }),
        }),
      );
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
    });
  });

  it("does not resurrect a startup agent missing from the runtime roster", async () => {
    const startupCfg = createCronConfig("server-cron-agent-workspace");
    const tmpDir = path.dirname((startupCfg.cron as { store: string }).store);
    startupCfg.agents = {
      defaults: { workspace: path.join(tmpDir, "workspace") },
      entries: {
        main: {},
        yinze: { workspace: path.join(tmpDir, "workspace-yinze") },
      },
    };
    const reloadedCfg = {
      ...startupCfg,
      agents: { ...startupCfg.agents, entries: { main: {} } },
    } as OpenClawConfig;
    await withCronService(startupCfg, async (state) => {
      const job = await addAgentTurnJob(state, "isolated-subagent-workspace", "read SOW.md", {
        agentId: "yinze",
      });

      loadConfigMock.mockReturnValue(reloadedCfg);
      await expect(state.cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      expect(await state.cron.readJob(job.id)).toMatchObject({
        state: {
          lastRunStatus: "error",
          lastError: expect.stringContaining("cron job agent is unavailable: yinze"),
        },
      });
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

  it("does not execute jobs for a journal-fenced agent still present in the roster", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-fenced-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: { entries: { main: {}, yinze: {} } },
    } as OpenClawConfig;
    await withCronService(cfg, async (state) => {
      const job = await addAgentTurnJob(state, "fenced-job", "must not run", {
        agentId: "yinze",
      });
      isAgentDeletionBlockedMock.mockImplementation((agentId: string) => agentId === "yinze");

      await expect(state.cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      expect(await state.cron.readJob(job.id)).toMatchObject({
        state: {
          lastRunStatus: "error",
          lastError: expect.stringContaining("cron job agent is unavailable: yinze"),
        },
      });
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

  it("does not route events to an agent removed from the current roster", () => {
    const cfg = createCronConfig("server-cron-retired-agent-event");
    cfg.agents = { entries: { main: {}, yinze: {} } };
    loadConfigMock.mockReturnValue({ ...cfg, agents: { entries: { main: {} } } });
    const state = createCronService(cfg);
    try {
      expect(() =>
        state.cron.wake({
          mode: "now",
          text: "late event",
          agentId: "yinze",
          sessionKey: "agent:yinze:main",
        }),
      ).toThrow("cron job agent is unavailable: yinze");
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    } finally {
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
      JSON.stringify({
        "agent:main:probe": { sessionId: "sess-probe", updatedAt: Date.now() },
      }),
      "utf-8",
    );
    loadConfigMock.mockReturnValue(cfg);
    const broadcast = vi.fn();
    const state = createCronService(cfg, { broadcast });
    try {
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
    } finally {
      state.cron.stop();
    }
  });

  registerGatewayCronContextTests({
    createCronConfig,
    createCronService,
    getCronState,
    addAgentTurnJob,
    addSystemEventJob,
    loadConfigMock,
    runCronIsolatedAgentTurnMock,
    runSessionEventMock,
  });

  it("cleans a failed scheduled activation before a later cron-expression tick executes", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-13T18:15:00.000Z");
    vi.setSystemTime(now);
    const clock = createGatewaySchedulerClock(now);
    const cfg = createCronConfig("server-cron-activation-write-failure");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    const cronState = getCronState(state);
    try {
      const database = openOpenClawStateDatabase().db;
      try {
        await state.cron.start();
        const job = await addAgentTurnJob(state, "activation-failure", "run it", {
          agentId: "main",
          deleteAfterRun: false,
          delivery: { mode: "none" },
          schedule: { kind: "cron", expr: "* * * * *", staggerMs: 0 },
        });
        const storeKey = cronStoreKey(cronState.deps.storePath);
        const receipts = () =>
          database
            .prepare(
              "SELECT receipt_id, status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY receipt_id",
            )
            .all(storeKey, job.id);
        expect(receipts()).toEqual([]);
        // Real reservation/activation writes; only this synthetic fault is injected.
        database.exec(`
          CREATE TRIGGER fail_gateway_cron_activation
          AFTER UPDATE OF state_json ON cron_jobs
          WHEN NEW.store_key = '${storeKey.replaceAll("'", "''")}'
            AND NEW.job_id = '${job.id}'
            AND json_extract(OLD.state_json, '$.queuedAtMs') IS NOT NULL
            AND json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL
          BEGIN
            SELECT RAISE(ABORT, 'injected scheduled activation failure');
          END;
        `);
        vi.setSystemTime(now + 60_000);
        clock.setTime(Date.now());
        // The published timer-test entry calls the real scheduler and joins the tick.
        await expect(onCronTimer(cronState)).rejects.toThrow(
          "injected scheduled activation failure",
        );
        const failedReceipts = receipts();
        expect(failedReceipts).toHaveLength(1);
        expect(failedReceipts[0]).toMatchObject({ status: "skipped" });
        expect(cronState.queuedRunReservationsByJobId.has(job.id)).toBe(false);
        expect(cronState.runAdmission.active).toBe(0);
        expect(cronState.activeTimerTicks).toBe(0);
        const afterFailure = (await loadCronStore(cronState.deps.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(afterFailure?.state.queuedAtMs).toBeUndefined();
        expect(afterFailure?.state.runningAtMs).toBeUndefined();
        expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
        database.exec("DROP TRIGGER fail_gateway_cron_activation");

        vi.setSystemTime(now + 120_000);
        clock.setTime(Date.now());
        await onCronTimer(cronState);
        expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledOnce();
        expectIsolatedRunFields({ job: expect.objectContaining({ id: job.id }) });
        const afterTick = (await loadCronStore(cronState.deps.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(afterTick?.state).toMatchObject({ lastRunStatus: "ok" });
        expect(afterTick?.state.queuedAtMs).toBeUndefined();
        expect(afterTick?.state.runningAtMs).toBeUndefined();
        expect(receipts()).toHaveLength(2);
        expect(receipts()).toEqual(
          expect.arrayContaining([failedReceipts[0], expect.objectContaining({ status: "ok" })]),
        );
        expect(cronState.queuedRunReservationsByJobId.has(job.id)).toBe(false);
        expect(cronState.runAdmission.active).toBe(0);
        expect(cronState.activeTimerTicks).toBe(0);
      } finally {
        database.exec("DROP TRIGGER IF EXISTS fail_gateway_cron_activation");
      }
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
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
            requireRecord(
              callArg(runCronIsolatedAgentTurnMock, index, 0, "scheduled sibling"),
              "scheduled sibling",
            ).job,
            "scheduled sibling job",
          ).id,
      );
      expect(new Set(attemptedIds)).toEqual(new Set(jobIds));
      expect(getCronState(state).queuedRunReservationsByJobId.size).toBe(0);
      expect(getCronState(state).runAdmission.active).toBe(0);
      expect(getCronState(state).activeTimerTicks).toBe(0);
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });
});

describe("fireOnExitJob (on-exit fire routing)", () => {
  type ExitRunMock = Parameters<typeof fireOnExitJob>[2]["run"];

  const job = (payload: CronJob["payload"], extra: Partial<CronJob> = {}): CronJob => ({
    ...cronJob("watched command", payload),
    id: "job-x",
    enabled: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    state: {},
    ...extra,
  });
  const exit = {
    exitCode: 3,
    reason: "exit",
    stdout: "built ok\n",
    stderr: "warned\n",
    timedOut: false,
    noOutputTimedOut: false,
  };

  it("rejects already-running admission so the watcher records the failed handoff", async () => {
    const run = vi.fn<ExitRunMock>(async () => ({
      ok: true,
      ran: false,
      reason: "already-running",
    }));
    await expect(
      fireOnExitJob(job({ kind: "systemEvent", text: "done" }), exit, { run }),
    ).rejects.toThrow("already-running");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
