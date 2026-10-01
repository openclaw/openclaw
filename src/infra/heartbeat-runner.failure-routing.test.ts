import { afterEach, expect, it, vi } from "vitest";
import { HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT } from "../agents/failover/user-copy.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import { resetCronActiveJobs, markCronJobActive, clearCronJobActive } from "../cron/active-jobs.js";
import { makeCronJob } from "../cron/delivery.test-helpers.js";
import { createNoopLogger } from "../cron/service.test-harness.js";
import {
  finalizeCronFailureNotifications,
  resolveFailureAlert,
} from "../cron/service/failure-alerts.js";
import { createCronServiceState, type DeferredCronNotifications } from "../cron/service/state.js";
import { executeJobCore } from "../cron/service/timer-execution.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  seedMainSessionStore,
  setHeartbeatAgentTurnStatus,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import type { HeartbeatWakeRequest } from "./heartbeat-wake-contracts.js";
import { resetSystemEventsForTest } from "./system-events.js";

installHeartbeatRunnerTestRuntime();
afterEach(() => {
  resetCronActiveJobs();
  resetHeartbeatEventsForTest();
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

it("sends a scheduled failure only through the configured automation failure route", async () => {
  await withTempTelegramHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
    const primaryRecipient = "-1001111111111";
    const failureRecipient = "-1002222222222";
    const cfg = {
      agents: {
        defaults: {
          workspace: tmpDir,
          heartbeat: { every: "5m", target: "telegram", to: primaryRecipient },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: storePath },
    };
    await seedMainSessionStore(storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: primaryRecipient,
    });
    replySpy.mockImplementation(async (_ctx, options) => {
      setHeartbeatAgentTurnStatus(options, "failed");
      return { text: HEARTBEAT_EXTERNAL_RUN_FAILURE_TEXT, isError: true };
    });
    const primarySend = vi.fn().mockResolvedValue({ messageId: "synthetic-message" });
    const deps = { telegram: primarySend, getReplyFromConfig: replySpy, getQueueSize: () => 0 };
    let capturedWake: HeartbeatWakeRequest | undefined;
    const job = makeCronJob({
      id: "synthetic-monitor",
      agentId: "main",
      declarationKey: "heartbeat:main",
      payload: { kind: "heartbeat" },
      sessionTarget: "main",
    });
    const state = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      log: createNoopLogger(),
      nowMs: () => 1000,
      cronConfig: {
        failureAlert: {
          enabled: true,
          after: 1,
          cooldownMs: 0,
          channel: "telegram",
          to: failureRecipient,
        },
      },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
      requestHeartbeatAndWait: (options) => {
        capturedWake = options;
        if (state.deps.cronConfig) {
          expect(options.failureNotificationOwners?.some((owner) => owner())).toBe(true);
        }
        return runHeartbeatOnce({
          cfg,
          ...options,
          deps,
        });
      },
    });
    const marker = markCronJobActive(job.id, {
      agentId: "main",
      declarationKey: job.declarationKey,
    });
    const result = await executeJobCore(state, job, undefined, { activeJobMarker: marker });
    expect(result).toMatchObject({
      status: "error",
      error: "heartbeat failed: agent-runner-failure",
    });
    job.state.consecutiveErrors = 1;
    const notifications: DeferredCronNotifications = [];
    finalizeCronFailureNotifications(state, {
      job,
      alertConfig: resolveFailureAlert(state, job),
      result: { ...result, startedAt: 1000 },
      completionStatus: "failed",
      autoDisableNotificationOwnsFailure: false,
      deferredNotifications: notifications,
    });
    expect(notifications).toMatchObject([
      { kind: "failure-alert", route: { channel: "telegram", to: failureRecipient } },
    ]);
    expect(primarySend).not.toHaveBeenCalled();
    expect(capturedWake?.failureNotificationOwners?.some((owner) => owner())).toBe(false);

    job.state.failureAlertIncident = undefined;
    notifications.length = 0;
    const alertConfig = resolveFailureAlert(state, job);
    if (!alertConfig) {
      throw new Error("Expected synthetic failure policy");
    }
    finalizeCronFailureNotifications(state, {
      job,
      alertConfig: { ...alertConfig, after: 2 },
      result: { ...result, startedAt: 1000 },
      completionStatus: "failed",
      autoDisableNotificationOwnsFailure: false,
      deferredNotifications: notifications,
    });
    expect(notifications).toEqual([]);

    replySpy.mockImplementationOnce(async (_ctx, options) => {
      setHeartbeatAgentTurnStatus(options, "ok");
      return createHeartbeatToolResponsePayload({
        outcome: "progress",
        notify: true,
        summary: "Synthetic result is ready.",
      });
    });
    await expect(
      executeJobCore(state, job, undefined, { activeJobMarker: marker }),
    ).resolves.toMatchObject({ status: "ok" });
    expect(primarySend).toHaveBeenCalledOnce();
    expect(primarySend.mock.calls[0]?.[0]).toBe(primaryRecipient);
    clearCronJobActive(job.id, marker);

    // A retained wake cannot keep claiming a scheduler after that waiter returned.
    primarySend.mockClear();
    await expect(runHeartbeatOnce({ cfg, ...capturedWake, deps })).resolves.toMatchObject({
      status: "failed",
    });
    expect(primarySend).toHaveBeenCalledOnce();

    // Global alert configuration does not retarget a manual heartbeat.
    primarySend.mockClear();
    await expect(
      runHeartbeatOnce({ cfg: { ...cfg, cron: state.deps.cronConfig }, source: "manual", deps }),
    ).resolves.toMatchObject({ status: "failed" });
    expect(primarySend).toHaveBeenCalledOnce();
    expect(primarySend.mock.calls[0]?.[0]).toBe(primaryRecipient);

    // An unconfigured automation failure route retains the existing primary behavior.
    primarySend.mockClear();
    state.deps.cronConfig = undefined;
    const legacyMarker = markCronJobActive(job.id, { agentId: "main" });
    await expect(
      executeJobCore(state, job, undefined, { activeJobMarker: legacyMarker }),
    ).resolves.toMatchObject({ status: "error" });
    expect(capturedWake?.failureNotificationOwners).toBeUndefined();
    expect(primarySend).toHaveBeenCalledOnce();
    clearCronJobActive(job.id, legacyMarker);
  });
});
