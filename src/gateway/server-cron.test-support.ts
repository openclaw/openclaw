// Shared Gateway cron fixtures keep adapter mocks and process lifetimes consistent across suites.
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetActiveCronTaskRunsForTests } from "../cron/service/active-run-cancellation.test-support.js";
import { resolveCronJobsStorePath, resolveDefaultCronStorePath } from "../cron/store/paths.js";
import type { CronJobCreate } from "../cron/types.js";
import type { ManagedRun, RunExit } from "../process/supervisor/types.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";

type RunCronIsolatedAgentTurnMock = (params: {
  abortSignal?: AbortSignal;
}) => Promise<{ status: "ok"; summary: string }>;

const {
  enqueueSystemEventMock,
  systemEventReceiptRemoveMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  sendCronAnnouncePayloadStrictMock,
  runCronIsolatedAgentTurnMock,
  runCronSessionTurnMock,
  getGlobalHookRunnerMock,
  runCronChangedMock,
  abortAndDrainEmbeddedAgentRunMock,
  getProcessSupervisorMock,
  createCronScriptRuntimeMock,
  cronTriggerEvaluatorMock,
  cronScriptExecutorMock,
  isAgentDeletionBlockedMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  systemEventReceiptRemoveMock: vi.fn(() => true),
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

vi.mock("../config/config.js", async (original) => ({
  ...(await original<typeof import("../config/config.js")>()),
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../config/io.js", async (original) => ({
  ...(await original<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => loadConfigMock(),
}));

vi.mock("../infra/restart-coordinator.js", async (original) => ({
  ...(await original<typeof import("../infra/restart-coordinator.js")>()),
  scheduleSafeGatewayRestart: () => {
    throw new Error("Cron must back off without restarting the Gateway");
  },
}));

// mock-isolation: Webhook effects use the fixture transport and never open real network requests.
vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/delivery.js", async (original) => ({
  ...(await original<typeof import("../cron/delivery.js")>()),
  sendCronAnnouncePayloadStrict: sendCronAnnouncePayloadStrictMock,
}));

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
import { runExit } from "./server-cron.process.test-support.js";

export function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: { mainKey: "main" },
    cron: { store: path.join(tmpDir, "cron.json") },
    // SAFETY: the adapter above consumes legacy cron.store before runtime config is used.
  } as OpenClawConfig;
}

type CronServiceOverrides = Partial<
  Omit<Parameters<typeof buildGatewayCronServiceRuntime>[0], "cfg" | "deps" | "storePath">
>;

export function loadCronService(cfg: OpenClawConfig, overrides: CronServiceOverrides = {}) {
  loadConfigMock.mockReturnValue(cfg);
  const legacyStore = (cfg.cron as { store?: unknown } | undefined)?.store;
  const env =
    typeof legacyStore === "string"
      ? { ...process.env, OPENCLAW_SKIP_CRON: "0", OPENCLAW_STATE_DIR: path.dirname(legacyStore) }
      : (overrides.env ?? process.env);
  return buildGatewayCronServiceRuntime({
    cfg,
    // SAFETY: agent and delivery dependencies are replaced by the suite module mocks.
    deps: {} as CliDeps,
    broadcast: () => {},
    ...overrides,
    scheduler: overrides.scheduler ?? createTestGatewayScheduler(),
    env,
    storePath:
      typeof legacyStore === "string"
        ? resolveCronJobsStorePath(legacyStore, env, env)
        : resolveDefaultCronStorePath(env),
  });
}

type CronJobOverrides = Partial<Omit<CronJobCreate, "name" | "payload">>;

function addCronJob(
  service: CronServiceFixture,
  name: string,
  payload: CronJobCreate["payload"],
  overrides: CronJobOverrides = {},
) {
  return service.cron.add({
    name,
    enabled: true,
    schedule: { kind: "at", at: new Date(1).toISOString() },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload,
    ...overrides,
  });
}

type CronServiceFixture = ReturnType<typeof loadCronService>;

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
  loadConfigMock.mockClear();
  fetchWithSsrFGuardMock.mockClear();
  sendCronAnnouncePayloadStrictMock.mockClear();
  runCronIsolatedAgentTurnMock.mockClear();
  runCronSessionTurnMock.mockClear();
  runCronChangedMock.mockClear();
  getGlobalHookRunnerMock.mockClear();
  abortAndDrainEmbeddedAgentRunMock.mockClear();
  getProcessSupervisorMock.mockReset();
  getProcessSupervisorMock.mockReturnValue({
    spawn: vi.fn(),
    cancelScope: vi.fn(),
    acquireScopeCleanup: vi.fn(() => vi.fn(async () => {})),
  });
  cronTriggerEvaluatorMock.mockReset().mockResolvedValue({ kind: "evaluated", fire: false });
  isAgentDeletionBlockedMock.mockReset().mockReturnValue(false);
  cronScriptExecutorMock.mockReset().mockResolvedValue({ kind: "completed", stateChanged: false });
  createCronScriptRuntimeMock.mockReset().mockReturnValue({
    evaluateTrigger: cronTriggerEvaluatorMock,
    executePayload: cronScriptExecutorMock,
  });
  getGlobalHookRunnerMock.mockReturnValue({
    hasHooks: (hookName: string) => hookName === "cron_changed",
    runCronChanged: runCronChangedMock,
  });
}
