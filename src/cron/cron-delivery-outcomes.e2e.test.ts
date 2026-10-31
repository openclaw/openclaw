import { createServer } from "node:http";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  dispatchGatewayCronFinishedNotifications,
  sendGatewayCronFailureAlert,
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
import { resolveCronDeliveryPreviews } from "./delivery-preview.js";
import { makeCronJob } from "./delivery.test-helpers.js";
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

async function createWebhookReceiver() {
  const requests: WebhookRequest[] = [];
  const request = createDeferred<WebhookRequest>();
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
      request.resolve(received);
      response.writeHead(204, { Connection: "close" });
      response.end();
    });
  });
  const { claim, releaseListener } = await reserveTestPortListener({
    offsets: [0],
    createListener: () => server,
  });
  return {
    request: request.promise,
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
) {
  const receiver = await createWebhookReceiver();
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

function failureDelivery(to: string): NonNullable<CronJobCreate["delivery"]> {
  return { mode: "none", failureDestination: { mode: "webhook", to } };
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
  return expectDefined(history.entries[0], `cron run history for job ${jobId}`);
}

async function expectState(storePath: string, jobId: string, expected: Partial<CronJob["state"]>) {
  const storedJob = (await loadCronStore(storePath)).jobs.find((job) => job.id === jobId);
  expect(storedJob?.state).toMatchObject(expected);
}

describe("cron delivery outcomes", { concurrent: false }, () => {
  it("omits providerless channel causes while preserving watchdog timeout diagnostics", async () => {
    await withReceiver("providerless", async (storePath, receiver, startCron) => {
      let execution: "channel-failure" | "watchdog-timeout" = "channel-failure";
      const watchdogExecutionStarted = createDeferred();
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
          watchdogExecutionStarted.resolve();
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
        await watchdogExecutionStarted.promise;
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
      expect(history.entries).toContainEqual(
        expect.objectContaining({ status: "error", error: "monitor failed" }),
      );
      expect(
        history.entries.filter((entry) => entry.failureNotificationDelivery?.status === "unknown"),
      ).toHaveLength(1);
    });
  });

  it.each(["transport", "admission"] as const)(
    "falls back to the exact job owner when Gateway alert %s rejects",
    async (failure) => {
      await withOpenClawTestState(
        { layout: "state-only", prefix: "openclaw-cron-alert-fallback-" },
        async (state) => {
          const enqueueSystemEvent = vi.fn();
          const enqueueSessionEvent = vi.fn<NonNullable<CronServiceDeps["enqueueSessionEvent"]>>();
          const storePath = state.path("cron", "jobs.json");
          let delivery: Promise<void> | undefined;
          const expectedError =
            failure === "admission"
              ? "Gateway is restarting"
              : "Blocked hostname or private/internal/special-use IP address";
          const cron = createCron(storePath, {
            enqueueSystemEvent,
            enqueueSessionEvent,
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
            expect(enqueueSystemEvent).not.toHaveBeenCalled();
            expect(enqueueSessionEvent).toHaveBeenCalledExactlyOnceWith(
              expect.stringContaining('Automation "fallback owner" failed 1 times'),
              {
                agentId: "work",
                sessionKey,
                contextKey: `cron:${job.id}:failure-alert`,
                jobId: job.id,
              },
            );
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

  it("builds delivery previews for webhook and opt-out jobs", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "openclaw-cron-delivery-preview-" },
      async () => {
        const payload: CronJob["payload"] = {
          kind: "command",
          argv: [process.execPath, "-e", "process.exit(0)"],
        };
        const jobs = [
          makeCronJob({
            id: "webhook",
            payload,
            delivery: { mode: "webhook", to: "https://hooks.example.test/cron" },
          }),
          makeCronJob({ id: "none", payload, delivery: { mode: "none" } }),
        ];
        expect(await resolveCronDeliveryPreviews({ cfg: {}, jobs })).toMatchObject({
          webhook: { label: "webhook:https://hooks.example.test/cron", detail: "webhook" },
          none: { label: "not requested", detail: "not requested" },
        });
      },
    );
  });
});
