import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
  sendGatewayCronWebhook,
} from "../gateway/server-cron-notifications.js";
import {
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  runOutsideGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { runCronCommandJob } from "./command-runner.js";
import { resolveCronDeliveryPreviews } from "./delivery-preview.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob, CronJobCreate } from "./types.js";

type WebhookRequest = {
  body: Record<string, unknown>;
  path: string;
};

async function createWebhookReceiver(responseStatus: number | null = 204) {
  const requests: WebhookRequest[] = [];
  let resolveRequest!: (request: WebhookRequest) => void;
  const request = new Promise<WebhookRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((incoming, response) => {
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      body += chunk;
    });
    incoming.on("end", () => {
      const received = {
        body: JSON.parse(body) as Record<string, unknown>,
        path: incoming.url ?? "",
      };
      requests.push(received);
      resolveRequest(received);
      if (responseStatus !== null) {
        response.writeHead(responseStatus, { Connection: "close" });
        response.end();
      }
    });
  });
  const { claim, releaseListener } = await reserveTestPortListener({
    offsets: [0],
    createListener: () => server,
  });
  return {
    request,
    requests,
    url: `http://127.0.0.1:${claim.port}/cron`,
    close: async () => {
      server.closeAllConnections();
      try {
        await releaseListener();
      } finally {
        await claim.release();
      }
    },
  };
}

async function withReceiver(
  prefix: string,
  run: (
    storePath: string,
    receiver: Awaited<ReturnType<typeof createWebhookReceiver>>,
    startCron: (deps?: Partial<CronServiceDeps>) => Promise<CronService>,
  ) => Promise<void>,
  responseStatus: number | null = 204,
) {
  const receiver = await createWebhookReceiver(responseStatus);
  const crons: CronService[] = [];
  try {
    await withOpenClawTestState(
      { layout: "state-only", prefix: `openclaw-cron-${prefix}-` },
      async (state) => {
        const storePath = state.path("cron", "jobs.json");
        try {
          await run(storePath, receiver, async (deps) => {
            const cron = createCron(storePath, deps);
            crons.push(cron);
            await cron.start();
            return cron;
          });
        } finally {
          for (const cron of crons) {
            cron.stop();
          }
        }
      },
    );
  } finally {
    await receiver.close();
  }
}

function createCron(storePath: string, deps: Partial<CronServiceDeps> = {}) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    storePath,
    cronEnabled: true,
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
}

function addJob(cron: CronService, name: string, overrides: Partial<CronJobCreate> = {}) {
  return cron.add({
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: name },
    ...overrides,
  });
}

const sendFailureAlert: NonNullable<CronServiceDeps["sendCronFailureAlert"]> = (params) =>
  sendGatewayCronFailureAlert({
    ...params,
    deps: {} as never,
    logger: createNoopLogger(),
    resolveCronAgent: () => ({ agentId: "main", cfg: {} as never }),
    ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
  });

const runCommand: NonNullable<CronServiceDeps["runCommandJob"]> = ({ job, abortSignal }) =>
  runCronCommandJob({ job, abortSignal, nowMs: Date.now });

const sendWebhook: NonNullable<CronServiceDeps["sendCronWebhook"]> = (params) =>
  sendGatewayCronWebhook({ ...params, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } });

function failureDelivery(to: string): NonNullable<CronJobCreate["delivery"]> {
  return { mode: "none", failureDestination: { mode: "webhook", to } };
}

function commandPayload(command: string): CronJobCreate["payload"] {
  return { kind: "command", argv: [process.execPath, "-e", command] };
}

function agentResult(result: Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>) {
  return vi.fn(async () => ({ ...result }));
}

async function runJob(cron: CronService, id: string) {
  await expect(cron.run(id, "force")).resolves.toEqual({ ok: true, ran: true });
}

function runHistory(storePath: string, jobId: string, limit = 1) {
  return readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId, limit });
}

function historyEntry(storePath: string, jobId: string) {
  const history = runHistory(storePath, jobId);
  expect(history.total).toBe(1);
  const entry = history.entries[0];
  if (!entry) {
    throw new Error(`Expected cron run history for job ${jobId}`);
  }
  return entry;
}

async function persistedJob(storePath: string, jobId: string) {
  return (await loadCronStore(storePath)).jobs.find((job) => job.id === jobId);
}

async function expectState(storePath: string, jobId: string, expected: Partial<CronJob["state"]>) {
  expect((await persistedJob(storePath, jobId))?.state).toMatchObject(expected);
}

describe("cron delivery outcomes", { concurrent: false }, () => {
  it("omits providerless channel causes while preserving watchdog timeout diagnostics", async () => {
    await withReceiver("providerless", async (storePath, receiver, startCron) => {
      let execution: "channel-failure" | "watchdog-timeout" = "channel-failure";
      let notifyWatchdogExecutionStarted!: () => void;
      const watchdogExecutionStarted = new Promise<void>((resolve) => {
        notifyWatchdogExecutionStarted = resolve;
      });
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(
        async ({ abortSignal, onExecutionStarted }) => {
          if (execution === "channel-failure") {
            return {
              status: "error",
              error:
                "heartbeat failed: MatrixError: [500] M_UNKNOWN: Internal server error occurred",
            };
          }
          if (!abortSignal) {
            throw new Error("expected cron watchdog abort signal");
          }
          onExecutionStarted?.();
          notifyWatchdogExecutionStarted();
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          return { status: "error", error: "cron watchdog aborted the runner" };
        },
      );
      const cron = await startCron({
        runIsolatedAgentJob,
        sendCronFailureAlert: sendFailureAlert,
      });
      const createJob = async (name: string, timeoutSeconds?: number) =>
        await addJob(cron, name, {
          payload: {
            kind: "agentTurn",
            message: name,
            ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
          },
          delivery: failureDelivery(receiver.url),
          failureAlert: { after: 1 },
        });

      const channelJob = await createJob("providerless channel failure");
      await runJob(cron, channelJob.id);
      await vi.waitFor(() => expect(receiver.requests).toHaveLength(1));
      expect(cron.getJob(channelJob.id)?.state.lastErrorReason).toBeUndefined();
      expect(historyEntry(storePath, channelJob.id).errorReason).toBeUndefined();
      expect(receiver.requests[0]?.body.message).not.toContain("Cause: timeout");
      expect(receiver.requests[0]?.body.message).toContain("Last error: heartbeat failed:");

      execution = "watchdog-timeout";
      const watchdogJob = await createJob("providerless cron watchdog timeout", 0.05);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const watchdogRun = cron.run(watchdogJob.id, "force");
        await watchdogExecutionStarted;
        await vi.advanceTimersByTimeAsync(50);
        await expect(watchdogRun).resolves.toEqual({ ok: true, ran: true });
        await vi.waitFor(() => expect(receiver.requests).toHaveLength(2));
      } finally {
        vi.useRealTimers();
      }
      expect(cron.getJob(watchdogJob.id)?.state.lastErrorReason).toBe("timeout");
      expect(historyEntry(storePath, watchdogJob.id).errorReason).toBe("timeout");
      expect(receiver.requests[1]?.body.message).toContain("Cause: timeout");
    });
  });

  it("delivers a command result through the guarded webhook boundary and persists it", async () => {
    await withReceiver("command", async (storePath, receiver, startCron) => {
      const cron = await startCron({
        runCommandJob: runCommand,
        sendCronWebhook: sendWebhook,
      });
      const job = await addJob(cron, "primary webhook delivery", {
        payload: commandPayload("process.stdout.write('DELIVERY_OUTCOME')"),
        delivery: { mode: "webhook", to: receiver.url },
      });

      await runJob(cron, job.id);
      expect(await receiver.request).toMatchObject({
        path: "/cron",
        body: {
          action: "finished",
          jobId: job.id,
          status: "ok",
          summary: "DELIVERY_OUTCOME",
        },
      });
      await expectState(storePath, job.id, {
        lastRunStatus: "ok",
        lastDelivered: true,
        lastDeliveryStatus: "delivered",
      });
      expect(historyEntry(storePath, job.id)).toMatchObject({
        status: "ok",
        deliveryStatus: "delivered",
        delivered: true,
      });

      for (const command of [
        "process.exit(0)",
        "process.stdout.write('  \\n')",
        "process.exit(1)",
      ]) {
        await cron.update(job.id, {
          payload: commandPayload(command),
        });
        await cron.run(job.id, "force");
        const failed = command === "process.exit(1)";
        expect(receiver.requests).toHaveLength(failed ? 2 : 1);
        await expectState(storePath, job.id, {
          lastRunStatus: failed ? "error" : "ok",
          lastDeliveryStatus: failed ? "delivered" : "not-delivered",
        });
        if (!failed) {
          expect((await persistedJob(storePath, job.id))?.state.deliverySuppressionReason).toBe(
            "empty",
          );
        }
      }
      expect(receiver.requests[1]?.body).toMatchObject({ status: "error" });
    });
  });

  it.each([
    [503, "not-delivered", false, "failed"],
    [null, "unknown", undefined, "unknown"],
  ] as const)(
    "persists primary webhook evidence for HTTP %s",
    async (responseStatus, deliveryStatus, delivered, completionStatus) => {
      await withReceiver(
        "outcome",
        async (storePath, receiver, startCron) => {
          const cron = await startCron({
            cronEnabled: false,
            runIsolatedAgentJob: agentResult({ status: "ok", summary: "WEBHOOK_OUTCOME" }),
            sendCronWebhook: sendWebhook,
          });
          try {
            const job = await addJob(cron, "webhook outcome", {
              delivery: { mode: "webhook", to: receiver.url, bestEffort: false },
            });
            vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
            const run = cron.run(job.id, "force");
            expect(await receiver.request).toMatchObject({
              body: { jobId: job.id, summary: "WEBHOOK_OUTCOME" },
            });
            if (responseStatus === null) {
              await vi.advanceTimersByTimeAsync(10_000);
            }
            await run;
            vi.useRealTimers();
            expect(receiver.requests).toHaveLength(1);
            const stored = await persistedJob(storePath, job.id);
            expect(stored?.state).toMatchObject({
              lastRunStatus: "ok",
              lastDeliveryStatus: deliveryStatus,
            });
            expect(stored?.state.lastDelivered).toBe(delivered);
            const history = historyEntry(storePath, job.id);
            expect(history).toMatchObject({ status: "ok", deliveryStatus, completionStatus });
            expect(history?.delivered).toBe(delivered);
            expect(history?.delivery?.delivered).toBe(delivered);
            if (responseStatus === null) {
              expect(history?.deliveryError).toContain("request timed out");
            }
          } finally {
            vi.useRealTimers();
          }
        },
        responseStatus,
      );
    },
  );

  it("applies threshold and cooldown once before transporting execution failure alerts", async () => {
    await withReceiver("failure", async (storePath, receiver, startCron) => {
      const cron = await startCron({
        runIsolatedAgentJob: agentResult({ status: "error", error: "monitor failed" }),
        sendCronFailureAlert: sendFailureAlert,
        onEvent: (event) => {
          if (event.action !== "finished") {
            return;
          }
          dispatchGatewayCronFinishedNotifications({
            evt: event,
            job: event.job ?? cron.getJob(event.jobId),
            logger: createNoopLogger(),
            ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
          });
        },
      });
      const job = await addJob(cron, "60-second monitor", {
        delivery: failureDelivery(receiver.url),
      });

      for (let index = 0; index < 21; index += 1) {
        await runJob(cron, job.id);
      }
      const disabled = await addJob(cron, "disabled failure alert", {
        delivery: failureDelivery(receiver.url),
        failureAlert: false,
      });
      for (let index = 0; index < 2; index += 1) {
        await runJob(cron, disabled.id);
      }

      await receiver.request;
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(receiver.requests).toHaveLength(1);
      expect(receiver.requests[0]).toMatchObject({
        path: "/cron",
        body: {
          jobId: job.id,
          jobName: "60-second monitor",
          message: 'Automation "60-second monitor" failed 2 times\nLast error: monitor failed',
        },
      });
      await expectState(storePath, job.id, {
        lastRunStatus: "error",
        lastError: "monitor failed",
        consecutiveErrors: 21,
        lastFailureAlertAtMs: expect.any(Number),
        lastFailureNotificationDeliveryStatus: "not-requested",
      });
      const history = runHistory(storePath, job.id, 25);
      expect(history.total).toBe(21);
      expect(history.entries).toHaveLength(21);
      expect(history.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: "error", error: "monitor failed" }),
        ]),
      );
      expect(
        history.entries.filter((entry) => entry.failureNotificationDelivery?.status === "unknown"),
      ).toHaveLength(1);
    });
  });

  it("routes required completion-delivery failure immediately without changing execution streak", async () => {
    await withReceiver("completion", async (storePath, receiver, startCron) => {
      let now = Date.now();
      const runIsolatedAgentJob = agentResult({
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
        deliveryError: "primary route rejected",
      });
      const cron = await startCron({
        nowMs: () => now,
        runIsolatedAgentJob,
        sendCronFailureAlert: sendFailureAlert,
      });
      const delivery = {
        mode: "announce",
        bestEffort: false,
        channel: "telegram",
        to: "123",
        failureDestination: { mode: "webhook", to: receiver.url },
      } as const;
      const job = await addJob(cron, "required completion delivery", { delivery });

      await runJob(cron, job.id);
      expect(await receiver.request).toMatchObject({
        path: "/cron",
        body: {
          jobId: job.id,
          message:
            'Automation "required completion delivery" delivery failed\nLast error: primary route rejected',
        },
      });
      await vi.waitFor(() =>
        expectState(storePath, job.id, {
          lastRunStatus: "ok",
          lastDeliveryStatus: "not-delivered",
          lastDeliveryError: "primary route rejected",
          consecutiveErrors: 0,
          lastFailureNotificationDelivered: true,
          lastFailureNotificationDeliveryStatus: "delivered",
          lastFailureAlertAtMs: now,
        }),
      );

      now += 60_000;
      await cron.run(job.id, "force");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(receiver.requests).toHaveLength(1);
      const history = runHistory(storePath, job.id, 10);
      const failedCompletion = expect.objectContaining({
        completionStatus: "failed",
        deliveryStatus: "not-delivered",
      });
      expect(history.entries).toEqual([failedCompletion, failedCompletion]);
      expect(
        history.entries.filter((entry) => entry.failureNotificationDelivery?.status === "unknown"),
      ).toHaveLength(1);

      now += 3_540_000;
      runIsolatedAgentJob.mockResolvedValue({
        status: "ok",
        delivered: false,
        deliveryAttempted: true,
        deliveryError: "primary target no longer exists",
      });
      await cron.run(job.id, "force");
      await vi.waitFor(() => expect(receiver.requests).toHaveLength(2));

      const disabled = await addJob(cron, "disabled completion failure alert", {
        delivery,
        failureAlert: false,
      });
      await cron.run(disabled.id, "force");
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(receiver.requests).toHaveLength(2);
    });
  });

  it.each(["transport", "admission"] as const)(
    "falls back to the exact job owner when Gateway alert %s rejects",
    async (failure) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-alert-fallback-" },
        async (state) => {
          const enqueueSystemEvent = vi.fn();
          const requestHeartbeat = vi.fn();
          const storePath = state.path("cron", "jobs.json");
          let delivery: Promise<void> | undefined;
          const expectedError =
            failure === "admission"
              ? "Gateway is restarting"
              : "Blocked hostname or private/internal/special-use IP address";
          const cron = createCron(storePath, {
            enqueueSystemEvent,
            requestHeartbeat,
            runIsolatedAgentJob: agentResult({ status: "error", error: "provider unavailable" }),
            sendCronFailureAlert: (params) => {
              const send = () =>
                sendGatewayCronFailureAlert({
                  ...params,
                  deps: {} as never,
                  logger: createNoopLogger(),
                  resolveCronAgent: () => ({ agentId: "work", cfg: {} as never }),
                });
              if (failure === "admission") {
                // Without a live parent, a detached alert must respect the restart fence.
                markGatewayRestartDraining();
                delivery = runOutsideGatewayRootWorkAdmission(send);
              } else {
                delivery = send();
              }
              return delivery;
            },
          });
          try {
            await cron.start();
            const sessionKey = "agent:work:cron:failure-fallback";
            const job = await addJob(cron, "fallback owner", {
              agentId: "work",
              sessionKey,
              wakeMode: "now",
              delivery: { mode: "none" },
              failureAlert: {
                after: 1,
                mode: "webhook",
                to: "http://127.0.0.1:9/failure",
              },
            });

            await cron.run(job.id, "force");

            if (!delivery) {
              throw new Error("Expected a failure alert transport");
            }
            await expect(delivery).rejects.toThrow(expectedError);
            expect(enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
              expect.stringContaining('Automation "fallback owner" failed 1 times'),
              { agentId: "work", sessionKey, contextKey: `cron:${job.id}:failure-alert` },
            );
            expect(requestHeartbeat).toHaveBeenCalledWith({
              source: "notifications-event",
              intent: "immediate",
              reason: "wake",
              agentId: "work",
              sessionKey,
            });
            await expectState(storePath, job.id, {
              lastFailureNotificationDelivered: false,
              lastFailureNotificationDeliveryStatus: "not-delivered",
              lastFailureNotificationDeliveryError: expect.stringContaining(expectedError),
            });
          } finally {
            cron.stop();
            resetGatewayWorkAdmission();
          }
        },
      );
    },
  );

  it("sends skipped-run alerts through the real webhook path and persists alert state", async () => {
    await withReceiver("skipped", async (storePath, receiver, startCron) => {
      const cron = await startCron({
        cronConfig: {
          failureAlert: {
            enabled: true,
            after: 1,
            cooldownMs: 0,
            includeSkipped: true,
            mode: "webhook",
            to: receiver.url,
          },
        },
        runIsolatedAgentJob: agentResult({ status: "skipped", error: "requests-in-flight" }),
        sendCronFailureAlert: sendFailureAlert,
      });
      const job = await addJob(cron, "skipped run alert", {
        delivery: { mode: "none" },
      });

      await runJob(cron, job.id);
      expect(await receiver.request).toMatchObject({
        path: "/cron",
        body: {
          jobId: job.id,
          jobName: "skipped run alert",
          message:
            'Automation "skipped run alert" skipped 1 times\nSkip reason: requests-in-flight',
        },
      });
      await vi.waitFor(() =>
        expectState(storePath, job.id, {
          lastRunStatus: "skipped",
          consecutiveSkipped: 1,
          lastFailureAlertAtMs: expect.any(Number),
          lastFailureNotificationDelivered: true,
          lastFailureNotificationDeliveryStatus: "delivered",
        }),
      );
      expect(historyEntry(storePath, job.id)).toMatchObject({
        status: "skipped",
        error: "requests-in-flight",
      });
    });
  });

  it("builds delivery previews from persisted webhook and opt-out jobs", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-delivery-preview-" },
      async (state) => {
        const cron = createCron(state.path("cron", "jobs.json"));
        try {
          await cron.start();
          const webhookJob = await addJob(cron, "webhook preview", {
            payload: commandPayload("process.exit(0)"),
            delivery: { mode: "webhook", to: "https://hooks.example.test/cron" },
          });
          const noDeliveryJob = await addJob(cron, "no delivery preview", {
            payload: commandPayload("process.exit(0)"),
            delivery: { mode: "none" },
          });

          const jobs = await cron.list({ includeDisabled: true });
          const previews = await resolveCronDeliveryPreviews({ cfg: {} as never, jobs });
          expect(previews).toMatchObject({
            [webhookJob.id]: {
              label: "webhook:https://hooks.example.test/cron",
              detail: "webhook",
            },
            [noDeliveryJob.id]: {
              label: "not requested",
              detail: "not requested",
            },
          });
        } finally {
          cron.stop();
        }
      },
    );
  });
});
