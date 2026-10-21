// Shared Gateway cron fixtures keep adapter mocks and process lifetimes consistent across suites.
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetActiveCronTaskRunsForTests } from "../cron/service/active-run-cancellation.test-support.js";
import { resolveSelectedCronJobsStorePath } from "../cron/store/paths.js";
import type { CronJobCreate } from "../cron/types.js";
import type { HeartbeatRunResult } from "../infra/heartbeat-wake.js";
import type { ManagedRun, RunExit } from "../process/supervisor/types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";

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
  runCronIsolatedAgentTurnMock,
  runCronSessionTurnMock,
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
  runCronIsolatedAgentTurnMock: vi.fn<RunCronIsolatedAgentTurnMock>(async () => ({
    status: "ok",
    summary: "ok",
  })),
  runCronSessionTurnMock: vi.fn<typeof import("../cron/session-run.js").runCronSessionTurn>(
    async () => ({ status: "ok", summary: "ok" }),
  ),
  runCronChangedMock: vi.fn(async (_event: unknown, _context?: unknown) => {}),
  getGlobalHookRunnerMock: vi.fn(() => ({
    hasHooks: (hookName: string) => hookName === "cron_changed",
    runCronChanged: runCronChangedMock,
  })),
  abortAndDrainEmbeddedAgentRunMock: vi.fn(async () => ({
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
    acquireScopeCleanup: vi.fn(() => vi.fn(async () => {})),
  })),
  createCronScriptRuntimeMock: vi.fn(),
  cronTriggerEvaluatorMock: vi.fn(),
  cronScriptExecutorMock: vi.fn(),
  isAgentDeletionBlockedMock: vi.fn((_agentId: string) => false),
}));

// mock-isolation: Legacy enqueue wiring is synthetic; automation notice preparation stays real.
vi.mock("../infra/system-events.js", async (importOriginal) => {
  const { createCronSystemEventMocks } =
    await import("./server-cron.system-event-receipt.test-support.js");
  return {
    ...(await importOriginal<typeof import("../infra/system-events.js")>()),
    ...createCronSystemEventMocks(enqueueSystemEventMock, systemEventReceiptRemoveMock),
  };
});

vi.mock("../infra/heartbeat-wake.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
    "../infra/heartbeat-wake.js",
  );
  return {
    ...actual,
    requestHeartbeat: requestHeartbeatMock,
    requestHeartbeatAndWait: requestHeartbeatAndWaitMock,
  };
});

// mock-isolation: Keep heartbeat enrollment inert while testing cron lifecycle wiring.
vi.mock("../infra/heartbeat-runner.js", () => ({
  // Heartbeat monitor convergence enumerates agents at cron start; keep it
  // inert so these tests exercise cron wiring, not heartbeat enrollment.
  resolveHeartbeatAgents: () => [],
  resolveHeartbeatSchedulerSeed: () => "test-seed",
}));

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

// mock-isolation: Webhook effects use the fixture transport and never open real network requests.
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

// mock-isolation: Model execution belongs to the fixture; loading the runner starts unrelated runtime owners.
vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

// mock-isolation: Adapter routing retains Cron custody without invoking controller/model execution.
vi.mock("../cron/session-run.js", () => ({
  runCronSessionTurn: runCronSessionTurnMock,
}));

export { runCronIsolatedAgentTurnMock, runCronSessionTurnMock };

// mock-isolation: Hooks are fixture-owned so registered host plugins cannot run during cron tests.
vi.mock("../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: getGlobalHookRunnerMock,
}));

// mock-isolation: Cancellation targets the fixture run, never the process-global agent registry.
vi.mock("../agents/embedded-agent.js", () => ({
  abortAndDrainEmbeddedAgentRun: abortAndDrainEmbeddedAgentRunMock,
}));

// mock-isolation: MCP retirement must not touch process-global plugin sessions.
vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

// mock-isolation: Deletion authority is fixture-controlled, independent of the process-global registry.
vi.mock("../agents/agent-lifecycle-registry.js", () => ({
  AgentDeletionAuthorityRollbackError: class extends AggregateError {},
  AgentDeletionCommitUncertainError: class extends Error {},
  isAgentDeletionBlocked: isAgentDeletionBlockedMock,
}));

// mock-isolation: Stream process custody uses the fixture supervisor, never real process spawning.
vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: getProcessSupervisorMock,
}));

// mock-isolation: Trigger scripts use fixture evaluators without creating a real script runtime.
vi.mock("../cron/trigger-script.js", () => ({
  createCronScriptRuntime: createCronScriptRuntimeMock,
}));

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

export function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
    // SAFETY: the adapter above consumes legacy cron.store before runtime config is used.
  } as OpenClawConfig;
}

type CronServiceOverrides = Partial<
  Omit<Parameters<typeof buildGatewayCronService>[0], "cfg" | "deps">
>;

function createCronService(cfg: OpenClawConfig, overrides: CronServiceOverrides = {}) {
  return buildGatewayCronService({
    cfg,
    // SAFETY: agent and delivery dependencies are replaced by the suite module mocks.
    deps: {} as CliDeps,
    broadcast: () => {},
    ...overrides,
    scheduler: overrides.scheduler ?? createTestGatewayScheduler(),
  });
}

export function loadCronService(cfg: OpenClawConfig, overrides: CronServiceOverrides = {}) {
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

function addCronJob(
  service: CronServiceFixture,
  name: string,
  payload: CronJobCreate["payload"],
  overrides: CronJobOverrides = {},
) {
  return service.cron.add(cronJob(name, payload, overrides));
}

export function addSystemEventJob(
  service: CronServiceFixture,
  name: string,
  text: string,
  overrides: CronJobOverrides = {},
) {
  return addCronJob(service, name, { kind: "systemEvent", text }, overrides);
}

export function addAgentTurnJob(
  service: CronServiceFixture,
  name: string,
  message: string,
  overrides: CronJobOverrides = {},
) {
  return addCronJob(service, name, { kind: "agentTurn", message }, overrides);
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

export function createWatchedRun(settleOnCancel = true, exitResult: Partial<RunExit> = {}) {
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
    waitForExtinction: vi.fn<NonNullable<ManagedRun["waitForExtinction"]>>(async () => {
      await exit.promise;
    }),
  };
}

export function mockCronSupervisor(...runs: ReturnType<typeof createWatchedRun>[]) {
  let nextRun = 0;
  const spawn = vi.fn(async () => {
    const index = nextRun++;
    return {
      ...(runs.length ? expectDefined(runs[index], "watched process") : createWatchedRun()),
      runId: `cron-watch-${index}`,
    };
  });
  const cancelScope = vi.fn();
  getProcessSupervisorMock.mockReturnValue({
    spawn,
    cancelScope,
    acquireScopeCleanup: vi.fn(() => vi.fn(async () => {})),
  });
  return { spawn, cancelScope };
}

export function resetGatewayCronMocks() {
  resetActiveCronTaskRunsForTests();
  enqueueSystemEventMock.mockClear();
  systemEventReceiptRemoveMock.mockClear();
  requestHeartbeatMock.mockClear();
  requestHeartbeatAndWaitMock.mockReset();
  loadConfigMock.mockClear();
  fetchWithSsrFGuardMock.mockClear();
  sendCronAnnouncePayloadStrictMock.mockClear();
  runCronIsolatedAgentTurnMock.mockClear();
  runCronSessionTurnMock.mockClear();
  runCronChangedMock.mockClear();
  getGlobalHookRunnerMock.mockClear();
  abortAndDrainEmbeddedAgentRunMock.mockClear();
  retireSessionMcpRuntimeMock.mockClear();
  requestSafeGatewayRestartMock.mockClear();
  getProcessSupervisorMock.mockReset();
  getProcessSupervisorMock.mockReturnValue({
    spawn: vi.fn(),
    cancelScope: vi.fn(),
    acquireScopeCleanup: vi.fn(() => vi.fn(async () => {})),
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
}
