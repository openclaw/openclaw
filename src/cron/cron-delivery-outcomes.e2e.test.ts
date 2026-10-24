import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { sendGatewayCronFailureAlert } from "../gateway/server-cron-notifications.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { resolveCronDeliveryPreviews } from "./delivery-preview.js";
import { makeCronJob } from "./delivery.test-helpers.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronTestInput } from "./service.fixture-builders.test-support.js";
import { CronService } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob, CronJobCreate } from "./types.js";

type WebhookRequest = {
  body: Record<string, unknown>;
  path: string;
};

async function createWebhookReceiver() {
  const requests: WebhookRequest[] = [];
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
      response.writeHead(204, { Connection: "close" });
      response.end();
    });
  });
  const { claim, releaseListener } = await reserveTestPortListener({
    offsets: [0],
    createListener: () => server,
  });
  return {
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
  return cron.add(
    cronTestInput({ name, payload: { kind: "agentTurn", message: name }, ...overrides }),
  );
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

async function runJob(cron: CronService, id: string) {
  await expect(cron.run(id, "force")).resolves.toEqual({ ok: true, ran: true });
}

function historyEntry(storePath: string, jobId: string) {
  const history = readCronRunHistoryPageForTests({
    storeKey: cronStoreKey(storePath),
    jobId,
    limit: 1,
  });
  expect(history.total).toBe(1);
  const entry = history.entries[0];
  if (!entry) {
    throw new Error(`Expected cron run history for job ${jobId}`);
  }
  return entry;
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
