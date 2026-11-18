import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createRequireRecord } from "../../test/helpers/record.js";
import { AgentDeletionCommitUncertainError } from "../agents/agent-deletion-errors.js";
import {
  detachActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  attachActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import type { CliDeps } from "../cli/deps.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../config/config.js";
import type * as deliveryTarget from "../cron/isolated-agent/delivery-target.js";
import { waitForCronRunQueue } from "../cron/service/run-queue.js";
import { onTimer as onCronTimer } from "../cron/service/timer.test-support.js";
import { resolveCronJobsStorePath, resolveDefaultCronStorePath } from "../cron/store/paths.js";
import { makeCronStreamSandboxTarget } from "../cron/stream-sandbox.test-support.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../infra/outbound/deliver-types.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { registerGatewayCronCompletionTests } from "./server-cron-completion.test-support.js";
import { registerGatewayCronContextTests } from "./server-cron.context.test-support.js";
import { registerGatewayCronMutationAuthorityTests } from "./server-cron.mutation-lifecycle.test-support.js";
import { createWatchedRun, runExit } from "./server-cron.process.test-support.js";
import { registerGatewayCronPublicationTests } from "./server-cron.publication.test-support.js";
import { registerGatewayCronQueueTests } from "./server-cron.queue.test-support.js";
import { registerGatewayCronSystemJobTests } from "./server-cron.system-jobs.test-support.js";

type RunCronIsolatedAgentTurnMock = (params: {
  abortSignal?: AbortSignal;
}) => Promise<{ status: "ok"; summary: string }>;

const mocks = vi.hoisted(() => {
  const changed = vi.fn(async (_event: unknown, _context?: unknown) => {});
  return {
    enqueue: vi.fn(),
    removeEvent: vi.fn(() => true),
    config: vi.fn(),
    fetch: vi.fn(),
    announce: vi.fn<typeof import("../cron/delivery.js").sendCronAnnouncePayloadStrict>(
      async ({ payload }) => ({
        status: "sent",
        payloads: Array.isArray(payload) ? payload : [payload],
        results: [{ channel: "telegram", messageId: "cron-message" }],
        receipt: {
          primaryPlatformMessageId: "cron-message",
          platformMessageIds: ["cron-message"],
          parts: [{ platformMessageId: "cron-message", kind: "text", index: 0 }],
          sentAt: 0,
        },
      }),
    ),
    target: vi.fn<typeof deliveryTarget.resolveDeliveryTarget>(async (...args) => {
      const { resolveCronTestDeliveryTarget } =
        await import("./server-cron.delivery.test-support.js");
      return resolveCronTestDeliveryTarget(...args);
    }),
    runSession: vi.fn<typeof import("../cron/session-run.js").runCronSessionTurn>(),
    sessionEvent: vi.fn<
      typeof import("../auto-reply/reply/session-event-handoff.js").enqueueSessionEventForHost
    >(() => ({
      id: "gateway-cron-fixture-event",
      cancel: () => false,
      accepted: Promise.resolve({ ok: true as const }),
      settled: Promise.resolve({
        status: "completed" as const,
        executionStarted: true,
        delivered: false,
      }),
    })),
    runAgent: vi.fn<RunCronIsolatedAgentTurnMock>(async () => ({
      status: "ok",
      summary: "ok",
    })),
    changed,
    hooks: vi.fn(() => ({
      hasHooks: (hookName: string) => hookName === "cron_changed",
      runCronChanged: changed,
    })),
    captureMcp:
      vi.fn<
        typeof import("../agents/agent-bundle-mcp-manager-api.js").captureSessionMcpRuntimeRetirement
      >(),
    retireMcp: vi.fn(async (assertCurrent: () => void) => assertCurrent()),
    restart: vi.fn(() => {
      throw new Error("Cron must back off without restarting the Gateway");
    }),
    supervisor: vi.fn(() => ({
      acquireScopeCleanup: vi.fn(() => async () => {}),
      spawn: vi.fn(),
      cancelScope: vi.fn(),
    })),
    scriptRuntime: vi.fn(),
    trigger: vi.fn(),
    script: vi.fn(),
  };
});

// mock-isolation: Legacy enqueue wiring is synthetic; automation notice preparation stays real.
vi.mock("../infra/system-events.js", async (importOriginal) => {
  const { createCronSystemEventMocks } =
    await import("./server-cron.system-event-receipt.test-support.js");
  return {
    ...(await importOriginal<typeof import("../infra/system-events.js")>()),
    ...createCronSystemEventMocks(mocks.enqueue, mocks.removeEvent),
  };
});

vi.mock("../infra/restart-coordinator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/restart-coordinator.js")>()),
  scheduleSafeGatewayRestart: mocks.restart,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => mocks.config(),
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => mocks.config(),
}));

// mock-isolation: Cron callback cases supply network responses without external requests.
vi.mock("../infra/net/fetch-guard.js", () => ({ fetchWithSsrFGuard: mocks.fetch }));

vi.mock("../cron/delivery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../cron/delivery.js")>()),
  sendCronAnnouncePayloadStrict: mocks.announce,
}));

vi.mock("../cron/isolated-agent/delivery-target.js", async (importOriginal) => ({
  ...(await importOriginal<typeof deliveryTarget>()),
  resolveDeliveryTarget: mocks.target,
}));

// mock-isolation: Fixed downstream execution leaves Gateway target resolution and Cron settlement real.
vi.mock("../cron/session-run.js", () => ({
  runCronSessionTurn: mocks.runSession,
}));

// mock-isolation: Wake routing stops at host admission; controller custody has real-owner proof.
vi.mock("../auto-reply/reply/session-event-handoff.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/session-event-handoff.js")>()),
  enqueueSessionEventForHost: mocks.sessionEvent,
}));

// mock-isolation: Scripted agent outcomes isolate cron scheduling from model execution.
vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: mocks.runAgent,
}));

// mock-isolation: Each cron case owns its hooks instead of sharing the active plugin registry.
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: mocks.hooks,
}));

vi.mock("../agents/agent-bundle-mcp-manager-api.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-bundle-mcp-manager-api.js")>()),
  captureSessionMcpRuntimeRetirement: mocks.captureMcp,
}));

// mock-isolation: Cron command fixtures control child settlement without spawning processes.
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: mocks.supervisor,
}));

// mock-isolation: Cron trigger cases provide script outcomes without executing user scripts.
vi.mock("../cron/trigger-script.js", () => ({
  createCronScriptRuntime: mocks.scriptRuntime,
}));

import { listenLoopback } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  abortActiveCronTaskRuns,
  registerActiveCronTaskRun,
  trackActiveCronTaskRunSettlement,
  getSuspensionVisibleCronTaskRunCount,
} from "../cron/service/active-run-cancellation.js";
import { resetActiveCronTaskRunsForTests } from "../cron/service/active-run-cancellation.test-support.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { CronJob, CronJobCreate } from "../cron/types.js";
import { buildGatewayCronService as buildGatewayCronServiceRuntime } from "./server-cron.js";

function buildGatewayCronService(
  params: Omit<Parameters<typeof buildGatewayCronServiceRuntime>[0], "storePath">,
) {
  const legacyStore = (params.cfg.cron as { store?: unknown } | undefined)?.store;
  const env =
    typeof legacyStore === "string"
      ? {
          ...process.env,
          ...params.env,
          OPENCLAW_SKIP_CRON: "0",
          OPENCLAW_STATE_DIR: path.dirname(legacyStore),
        }
      : (params.env ?? process.env);
  return buildGatewayCronServiceRuntime({
    ...params,
    env,
    storePath:
      typeof legacyStore === "string"
        ? resolveCronJobsStorePath(legacyStore, env, env)
        : resolveDefaultCronStorePath(env),
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
  setRuntimeConfigSnapshot(cfg);
  return buildGatewayCronService({
    cfg,
    deps: {} as CliDeps,
    broadcast: () => {},
    ...overrides,
    scheduler: overrides.scheduler ?? createTestGatewayScheduler(),
  });
}

function loadCronService(cfg: OpenClawConfig, overrides: CronServiceOverrides = {}) {
  mocks.config.mockReturnValue(cfg);
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
  mocks.supervisor.mockReturnValue({ acquireScopeCleanup, spawn, cancelScope });
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
  if (!call || argIndex >= call.length) {
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
  return mocks.changed.mock.calls
    .map((_, index) => callRecord(mocks.changed, index))
    .find((event) => event.action === "finished" && (jobId === undefined || event.jobId === jobId));
}

function mockScriptResult(notify?: string) {
  mocks.script.mockResolvedValueOnce({
    kind: "completed",
    ...(notify === undefined ? {} : { notify }),
    stateChanged: false,
  });
}

function expectIsolatedRunFields(fields: Record<string, unknown>) {
  const options = callRecord(mocks.runAgent);
  expect(options).toMatchObject({ trigger: "cron", ...fields });
  return options;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    resetActiveCronTaskRunsForTests();
    for (const mock of Object.values(mocks)) {
      mock.mockClear();
    }
    mocks.announce.mockReset();
    mocks.fetch.mockReset();
    mocks.runSession.mockReset().mockResolvedValue({ status: "ok" });
    mocks.captureMcp
      .mockReset()
      .mockImplementation(({ sessionId }) =>
        sessionId ? { sessionId, retire: mocks.retireMcp } : undefined,
      );
    mocks.supervisor.mockReset().mockReturnValue({
      acquireScopeCleanup: vi.fn(() => async () => {}),
      spawn: vi.fn(),
      cancelScope: vi.fn(),
    });
    mocks.trigger.mockReset().mockResolvedValue({ kind: "evaluated", fire: false });
    mocks.script.mockReset().mockResolvedValue({ kind: "completed", stateChanged: false });
    mocks.scriptRuntime.mockReset().mockReturnValue({
      evaluateTrigger: mocks.trigger,
      executePayload: mocks.script,
    });
    mocks.hooks.mockReturnValue({
      hasHooks: (hookName: string) => hookName === "cron_changed",
      runCronChanged: mocks.changed,
    });
  });

  afterEach(clearRuntimeConfigSnapshot);

  registerGatewayCronSystemJobTests({
    createCronConfig,
    withCronService,
    setRuntimeConfig: (cfg) => mocks.config.mockReturnValue(cfg),
  });

  registerGatewayCronMutationAuthorityTests({
    createCronConfig,
    loadCronService,
    createCronService,
    addCronJob,
  });

  it("disables Gateway-hosted automation execution while preserving timed agent turns", async () => {
    const cfg = createCronConfig("server-cron-disabled-host-execution");
    cfg.agents = { entries: { main: {} } };
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-14T12:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    const previous = loadCronService({ ...cfg, cron: { ...cfg.cron, enabled: false } });
    let restricted: CronServiceFixture | undefined;
    const { spawn } = mockCronSupervisor();
    const spawnSandbox = vi.fn(async () => ({
      ...createWatchedRun(),
      activity: { resultSettled: false, lastOutputAtMs: Date.now() },
      runId: "sandbox-stream",
    }));
    vi.doMock("./cron-stream-sandbox.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./cron-stream-sandbox.js")>()),
      createCronStreamSandboxExecutor: () => ({ spawn: spawnSandbox, recover: async () => {} }),
    }));
    try {
      const command = await addCommandJob(previous, "persisted command", "process.exit(0)", {
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      });
      const streamJob = await addSystemEventJob(previous, "persisted stream", "event", {
        schedule: { kind: "stream", command: ["source"] },
        sessionTarget: "main",
      });
      await previous.cron.stopAndDrain?.();

      restricted = loadCronService(cfg, {
        env: { OPENCLAW_DISABLE_CRON_HOST_EXECUTION: "1" },
        scheduler: createTestGatewayScheduler(clock.clock),
      });
      await restricted.cron.start();
      await restricted.reconcileStreamWatchers();
      expect(restricted.cron.getJob(streamJob.id)).toMatchObject({
        enabled: true,
        state: {
          streamStatus: "disabled",
          streamError: expect.stringContaining("OPENCLAW_DISABLE_CRON_HOST_EXECUTION"),
        },
      });
      await expect(restricted.cron.run(command.id, "force")).rejects.toThrow(
        "OPENCLAW_DISABLE_CRON_HOST_EXECUTION",
      );
      await expect(addCommandJob(restricted, "new command", "process.exit(0)")).rejects.toThrow(
        "OPENCLAW_DISABLE_CRON_HOST_EXECUTION",
      );
      const sandbox = await restricted.cron.add(
        cronJob(
          "sandbox stream",
          { kind: "agentTurn", message: "handle event" },
          {
            schedule: { kind: "stream", command: ["source"] },
          },
        ),
        { streamSandbox: makeCronStreamSandboxTarget() },
      );
      expect(sandbox.state.streamStatus).toBe("running");
      expect(spawnSandbox).toHaveBeenCalledOnce();
      const agent = await addAgentTurnJob(restricted, "scheduled agent", "run on schedule", {
        schedule: { kind: "every", everyMs: 60_000, anchorMs: Date.now() },
      });
      await expect(
        restricted.cron.update(agent.id, { payload: { kind: "command", argv: ["true"] } }),
      ).rejects.toThrow("OPENCLAW_DISABLE_CRON_HOST_EXECUTION");

      vi.setSystemTime(Date.now() + 60_000);
      clock.setTime(Date.now());
      await onCronTimer(getCronState(restricted));
      await waitForCronRunQueue(getCronState(restricted));
      expect(restricted.cron.getJob(command.id)?.state).toMatchObject({ lastStatus: "skipped" });
      expect(restricted.cron.getJob(agent.id)?.state).toMatchObject({ lastStatus: "ok" });
      expect(spawn).not.toHaveBeenCalled();
      await expect(restricted.cron.update(command.id, { enabled: false })).resolves.toMatchObject({
        enabled: false,
      });
    } finally {
      vi.doUnmock("./cron-stream-sandbox.js");
      await (restricted ?? previous).cron.stopAndDrain?.();
      vi.useRealTimers();
    }
  });

  it("keeps sole-agent ownerless jobs dynamic across a restart and roster rename", async () => {
    const opsCfg = createCronConfig("server-cron-sole-owner", {
      agents: { entries: { ops: {} } },
    });
    const initial = loadCronService(opsCfg);
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

      mocks.config.mockReturnValue({
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
      mocks.config.mockReturnValue({
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
      expectIsolatedRunFields({ agentId: "main", cronStorePath: state.storePath });
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
      const result = state.cron.getJob(job.id)?.state;
      expect(result).toMatchObject({ lastTriggerEvalAtMs: Date.now(), triggerEvalCount: 1 });
      expect(result?.lastRunStatus).toBeUndefined();
      expect(result?.lastError).toBeUndefined();
      expect(mocks.trigger).toHaveBeenCalledWith(
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
            expect(mocks.retireMcp).toHaveBeenCalledTimes(ownsSession ? 1 : 0);
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
      mocks.runAgent.mockImplementationOnce(async () => {
        runnerEntered.resolve();
        return await runnerResult.promise;
      });

      runPromise = state.cron.run(job.id, "force");
      await runnerEntered.promise;
      await vi.advanceTimersByTimeAsync(60_100);
      const runResult = await runPromise;

      expect(runResult).toEqual({ ok: true, ran: true });
      expect(mocks.restart).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
      runnerResult.resolve({ status: "ok", summary: "done" });
      await Promise.allSettled([runnerResult.promise, ...(runPromise ? [runPromise] : [])]);
      await vi.waitFor(() => expect(getSuspensionVisibleCronTaskRunCount()).toBe(0));
      vi.useRealTimers();
    }
  });

  it("forwards durable recurring wake changes through the finished cron_changed hook", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T12:00:00.000Z"));
    const clock = createGatewaySchedulerClock(Date.now());
    const cfg = createCronConfig("server-cron-hook-scheduled");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    const runtimeCfg = { ...cfg };
    mocks.config.mockReturnValue(runtimeCfg);
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

      mocks.changed.mockClear();
      vi.setSystemTime(dueAtMs);
      clock.setTime(Date.now());
      expect(await state.cron.run(job.id, "due")).toEqual({ ok: true, ran: true });
      expect(state.cron.getJob(job.id)?.state.lastRunStatus).toBe("ok");

      const finishedCallIndex = mocks.changed.mock.calls.findIndex(([candidate]) => {
        return requireRecord(candidate, "cron_changed event").action === "finished";
      });
      expect(finishedCallIndex).toBeGreaterThanOrEqual(0);
      const event = callRecord(mocks.changed, finishedCallIndex);
      const persistedNextRunAtMs = state.cron.getJob(job.id)?.state.nextRunAtMs;
      expect(persistedNextRunAtMs).toBeGreaterThan(dueAtMs);
      expect(event).toMatchObject({
        action: "finished",
        jobId: job.id,
        nextRunAtMs: persistedNextRunAtMs,
        sessionTarget: "main",
        agentId: "main",
        job: { agentId: "main", state: { nextRunAtMs: persistedNextRunAtMs } },
      });
      const context = callRecord(mocks.changed, finishedCallIndex, 1);
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
    mocks.changed.mockImplementationOnce(async () => await deferred.promise);
    const cfg = createCronConfig("server-cron-hook-admission");
    const state = loadCronService(cfg);

    try {
      await addSystemEventJob(state, "held hook", "hello", {
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
      });
      await vi.waitFor(() => expect(mocks.changed).toHaveBeenCalledTimes(1));
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
      expect(mocks.announce).not.toHaveBeenCalled();
      expect(mocks.changed.mock.calls.map(([event]) => event)).toContainEqual(
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
    loadConfigMock: mocks.config,
    sendCronAnnouncePayloadStrictMock: mocks.announce,
    cronScriptExecutorMock: mocks.script,
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

      mockScriptResult("scheduled result");
      mocks.announce.mockImplementationOnce(async (...args: unknown[]) => {
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

        expect(mocks.announce).toHaveBeenCalledOnce();
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
    mocks.config.mockReturnValue(cfg);
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
    mocks.announce.mockImplementationOnce(async (...args: unknown[]) => {
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

      expect(mocks.announce).toHaveBeenCalledOnce();
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
    mocks.config.mockReturnValue(cfg);
    mocks.announce.mockRejectedValueOnce(error);

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

      expect(mocks.announce).toHaveBeenCalledOnce();
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
    mocks.announce.mockImplementationOnce(async (request) => {
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
        expect(mocks.announce).toHaveBeenCalledOnce();
        const completion = mocks.announce.mock.calls[0]?.[0];
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

    const deliveryError = "Channel is required (no configured channels detected)";
    mocks.announce.mockRejectedValueOnce(new Error(deliveryError));

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

    const deliveryError = "network unavailable while delivering command output";
    mocks.announce.mockRejectedValueOnce(new Error(deliveryError));

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

      mocks.script.mockResolvedValueOnce({
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

        expect(mocks.script).toHaveBeenCalledWith(
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
          expect(mocks.announce).not.toHaveBeenCalled();
          expect(state.cron.getJob(job.id)?.state.deliverySuppressionReason).toBe("silent");
        } else {
          expect(mocks.announce).toHaveBeenCalledExactlyOnceWith(
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

    const rawError =
      "TOKEN=opaque-secret /private/script.sh https://internal.example.test/run provider-body Error: stack";
    mocks.script.mockResolvedValueOnce({
      kind: "error",
      code: "internal_error",
      error: rawError,
    });
    mocks.fetch.mockResolvedValueOnce({
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
        mocks.changed.mockClear();

        await state.cron.run(job.id, "force");
        await vi.waitFor(() => expect(mocks.announce).toHaveBeenCalledOnce());
        await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());

        const announceRequest = callRecord(mocks.announce);
        const announce = requireRecord(announceRequest.payload, "script failure announce");
        expect(announce.text).toContain(
          'Automation "script failure detail" was auto-disabled after 1 consecutive run failures.\nCause: automation script failed internally',
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

        const webhookRequest = callRecord(mocks.fetch);
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

      mockScriptResult("queue changed");
      mocks.announce.mockRejectedValueOnce(new Error("delivery rejected"));

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
        mocks.fetch.mockResolvedValueOnce({
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
          expect(mocks.fetch).toHaveBeenCalledOnce();
          const request = callRecord(mocks.fetch);
          expect(String(requireRecord(request.init, "fetch init").body)).toContain(
            '"summary":"queue changed"',
          );
        } else if (mode === "webhook") {
          expect(mocks.fetch).not.toHaveBeenCalled();
        } else {
          expect(mocks.announce).not.toHaveBeenCalled();
          expect(state.cron.getJob(job.id)).toBeUndefined();
          expect(mocks.changed.mock.calls.map(([event]) => event)).toContainEqual(
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

  it.each([
    {
      destination: "hook",
      source:
        "process.stdout.write('Visit www.example.com/device and enter code 123456; Log in with token=opaque-secret-value\\n')",
      redacted: ["[redacted-url]", "[redacted-code]", "token=***"],
      privateText: ["www.example.com/device", "123456", "opaque-secret-value"],
    },
    {
      destination: "announce",
      source:
        "process.stdout.write('Visit https://private.example/device and log in with token=opaque-secret-value\\n')",
      redacted: ["token=***", "[redacted-url]"],
      privateText: ["opaque-secret-value", "https://private.example/device"],
    },
  ])(
    "redacts command output for $destination delivery",
    async ({ destination, source, redacted, privateText }) => {
      const cfg = createCronConfig("server-cron-command-redaction");
      if (destination === "announce") {
        cfg.gateway = {
          publicOrigin: "https://gateway.example",
          controlUi: { basePath: "/control" },
        };
      }
      await withCronService(cfg, async (state) => {
        const job = await addCommandJob(state, "redacted-command", source, {
          deleteAfterRun: false,
          ...(destination === "announce"
            ? { delivery: { mode: "announce", channel: "telegram", to: "123" } }
            : {}),
        });
        if (destination === "hook") {
          mocks.changed.mockClear();
        }
        await state.cron.run(job.id, "force");
        let text: unknown;
        if (destination === "hook") {
          text = finishedEvent()?.summary;
        } else {
          const announce = callRecord(mocks.announce);
          expect(announce.payload).toHaveLength(1);
          text = requireRecord(
            Array.isArray(announce.payload) ? announce.payload[0] : undefined,
            "cron reply",
          ).text;
          expect(announce.inspectionUrl).toBe(
            `https://gateway.example/control/automations?job=${job.id}&run=cron%3A${job.id}%3A${state.cron.getJob(job.id)?.state.lastRunAtMs}`,
          );
          expect(state.cron.getJob(job.id)?.state).toMatchObject({
            lastRunStatus: "ok",
            lastDeliveryStatus: "delivered",
          });
        }
        for (const expected of redacted) {
          expect(text).toContain(expected);
        }
        for (const secret of privateText) {
          expect(text).not.toContain(secret);
        }
      });
    },
  );

  it("routes relative cron wake session keys to the configured default agent", async () => {
    const cfg = createCronConfig("server-cron-relative-default");
    cfg.agents = { entries: { primary: { model: "test/primary" } } };
    await withCronService(cfg, async (state) => {
      const cronDeps = getCronDeps(state);

      cronDeps?.enqueueSystemEvent?.("hello", {
        sessionKey: "discord:channel:ops",
        contextKey: "cron:test",
      });

      expect(lastCallRecord(mocks.enqueue, 1)).toMatchObject({
        contextKey: "cron:test",
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
      expect(mocks.enqueue).not.toHaveBeenCalled();
    });
  });

  it.each<
    [
      string,
      NonNullable<OpenClawConfig["cron"]>["webhookSsrfPolicy"],
      0 | 1,
      "not-delivered" | "delivered",
    ]
  >([
    ["blocks loopback by default", undefined, 0, "not-delivered"],
    ["allows private-network opt-in", { dangerouslyAllowPrivateNetwork: true }, 1, "delivered"],
    ["allows configured loopback hostnames", { allowedHostnames: ["127.0.0.1"] }, 1, "delivered"],
  ])("%s", async (_name, ssrfPolicy, expectedRequests, expectedDeliveryStatus) => {
    const receivedMethods: string[] = [];
    const server = createServer((req, res) => {
      receivedMethods.push(req.method ?? "");
      req.resume();
      res.writeHead(204).end();
    });
    const origin = await listenLoopback(server);

    const cfg = createCronConfig(`server-cron-ssrf-${expectedDeliveryStatus}`);
    if (ssrfPolicy) {
      cfg.cron = { ...cfg.cron, webhookSsrfPolicy: ssrfPolicy };
    }
    mocks.config.mockReturnValue(cfg);
    const actualFetchGuard = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
      "../infra/net/fetch-guard.js",
    );
    mocks.fetch.mockImplementationOnce(actualFetchGuard.fetchWithSsrFGuard);
    mocks.runSession.mockResolvedValueOnce({ status: "ok", summary: "Webhook fixture result" });

    const state = createCronService(cfg);
    try {
      const job = await addSystemEventJob(state, "ssrf-webhook-blocked", "hello", {
        deleteAfterRun: false,
        sessionTarget: "main",
        delivery: {
          mode: "webhook",
          to: `${origin}/cron-finished`,
        },
      });

      await state.cron.run(job.id, "force");

      expect(mocks.fetch).toHaveBeenCalledOnce();
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

  it.each([false, true])("handles roster commit failure (uncertain=%s)", async (uncertain) => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-agent-delete-${Date.now()}`);
    const cfg = {
      cron: { store: path.join(tmpDir, "cron.json") },
      agents: {
        ...(uncertain ? {} : { defaults: { workspace: path.join(tmpDir, "workspace") } }),
        entries: { main: {}, yinze: {}, other: {} },
      },
    } as OpenClawConfig;
    await withCronService(cfg, async (state) => {
      const removedNames = uncertain ? ["deleted"] : ["deleted-one", "deleted-two"];
      for (const name of [...removedNames, "kept"]) {
        await addAgentTurnJob(state, name, name, {
          schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
          agentId: name === "kept" ? "other" : "yinze",
        });
      }
      const error = uncertain
        ? new AgentDeletionCommitUncertainError(new Error("config outcome unknown"))
        : new Error("config commit failed");
      await expect(
        state.cron.removeAgentJobsTransactional("yinze", async () => {
          throw error;
        }),
      ).rejects.toThrow(error.message);
      const names = async () =>
        (await state.cron.list({ includeDisabled: true })).map((job) => job.name);
      if (!uncertain) {
        expect(await names()).toEqual(expect.arrayContaining([...removedNames, "kept"]));
        await state.cron.removeAgentJobsTransactional("yinze", async () => "committed");
      }
      expect(await names()).toEqual(["kept"]);
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
      mocks.config.mockReturnValue(runtimeCfg);

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
      mocks.config.mockReturnValue(deletedCfg);
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

  registerGatewayCronPublicationTests({
    createCronConfig,
    withCronService,
    addAgentTurnJob,
    getCronDeps,
  });

  registerGatewayCronContextTests({
    createCronConfig,
    createMultiAgentConfig,
    withCronService,
    finishedEvent,
    legacyEventMocks: mocks,
    createCronService,
    getCronState,
    addAgentTurnJob,
    addSystemEventJob,
    loadConfigMock: mocks.config,
    runCronIsolatedAgentTurnMock: mocks.runAgent,
    runCronSessionTurnMock: mocks.runSession,
    enqueueSessionEventMock: mocks.sessionEvent,
  });

  registerGatewayCronQueueTests({
    createCronConfig,
    loadCronService,
    withCronService,
    getCronState,
    addAgentTurnJob,
    loadConfigMock: mocks.config,
    runCronIsolatedAgentTurnMock: mocks.runAgent,
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
      mocks.runAgent.mockImplementationOnce(async () => {
        throw new Error("first sibling execution failure");
      });
      vi.setSystemTime(now + 60_000);
      clock.setTime(Date.now());
      await onCronTimer(getCronState(state));
      expect(mocks.runAgent).toHaveBeenCalledTimes(3);
      const attemptedIds = mocks.runAgent.mock.calls.map(
        (_, index) =>
          requireRecord(callRecord(mocks.runAgent, index).job, "scheduled sibling job").id,
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
