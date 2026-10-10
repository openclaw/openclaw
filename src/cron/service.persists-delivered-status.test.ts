// Delivered status tests cover persistence of cron delivery outcomes.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

import { sendGatewayCronWebhook } from "../gateway/server-cron-notifications.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { runCronCommandJob } from "./command-runner.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { CronService } from "./service.js";
import type { CronEvent } from "./service.js";
import {
  createFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import { abortActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  mocks.fetchWithSsrFGuard.mockReset().mockImplementation(actual.fetchWithSsrFGuard);
});

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];
type DeliveryCase = {
  name: string;
  delivery?: CronAddInput["delivery"];
  failureAlert?: CronAddInput["failureAlert"];
  result: Partial<Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>>;
  state: Partial<CronJob["state"]>;
  event: Partial<CronEvent>;
};
const successfulRun = { lastStatus: "ok", lastRunStatus: "ok" } as const;
const noFailureNotification = {
  lastFailureNotificationDelivered: undefined,
  lastFailureNotificationDeliveryStatus: "not-requested",
  lastFailureNotificationDeliveryError: undefined,
} as const;
const verifiedDelivery = {
  delivered: true,
  resolved: { ok: true, channel: "forum", to: "123" },
  messageToolSentTo: [{ channel: "forum", to: "123" }],
};

function expectFields(actual: object | undefined, expected: object) {
  expect(actual).toBeDefined();
  for (const [key, value] of Object.entries(expected)) {
    expect(actual && Reflect.get(actual, key), key).toEqual(value);
  }
}

async function createCommandWebhook(
  options: {
    responseStatus?: number;
    holdResponse?: boolean;
    timeoutSeconds?: number;
    runCommandJob?: CronServiceDeps["runCommandJob"];
  } = {},
) {
  const requests: string[] = [];
  const bodyReceived = createDeferred<string>();
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push(body);
      bodyReceived.resolve(body);
      if (options.responseStatus !== undefined) {
        response.writeHead(options.responseStatus, {
          Connection: "close",
          "Content-Type": "text/plain",
        });
        if (options.holdResponse) {
          response.flushHeaders();
          response.write("accepted");
        } else {
          response.end();
        }
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  const { storePath } = await makeStorePath();
  const done = createDeferred<CronEvent>();
  const cron = createService(storePath, {
    runCommandJob:
      options.runCommandJob ??
      (async ({ job, abortSignal }) =>
        await runCronCommandJob({ job, abortSignal, nowMs: Date.now })),
    sendCronWebhook: (params) =>
      sendGatewayCronWebhook({ ...params, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } }),
    onEvent: (event) => {
      if (event.action === "finished") {
        done.resolve(event);
      }
    },
  });
  await cron.start();
  const job = await cron.add({
    ...buildIsolatedAgentTurnJob("command webhook"),
    payload: {
      kind: "command",
      argv: [process.execPath, "-e", "process.stdout.write('HOOKSCHED_PAYLOAD')"],
      ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    },
    delivery: { mode: "webhook", to: `http://127.0.0.1:${address.port}/hook` },
  });
  return {
    cron,
    job,
    requests,
    requestBody: bodyReceived.promise,
    finished: done.promise,
    close: async () => {
      cron.stop();
      await closeWebhookServer(server);
    },
  };
}

async function closeWebhookServer(server: ReturnType<typeof createServer>) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function buildIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "none" },
  };
}

function buildAnnounceIsolatedAgentTurnJob(name: string): CronAddInput {
  return {
    ...buildIsolatedAgentTurnJob(name),
    delivery: { mode: "announce", channel: "forum", to: "123" },
  };
}

function createService(storePath: string, deps: Partial<CronServiceDeps> = {}) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
  });
}

async function runIsolatedJobAndReadState(
  params: {
    job: CronAddInput;
  } & Partial<Awaited<ReturnType<CronServiceDeps["runIsolatedAgentJob"]>>>,
) {
  const { job, ...result } = params;
  const { storePath } = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const finished = createDeferred<CronEvent>();
  const cron = createService(storePath, {
    scheduler: createTestGatewayScheduler(clock.clock),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const, summary: "done", ...result })),
    onEvent: (event) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
  });
  await cron.start();
  try {
    const added = await cron.add(job);
    await clock.advanceTo(added.state.nextRunAtMs! + 5);
    const event = await finished.promise;
    const updated = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === added.id,
    );
    return { event, updated };
  } finally {
    cron.stop();
  }
}

describe("CronService persists delivered status", () => {
  it.each([
    {
      name: "failing endpoint",
      responseStatus: 503,
      expectedStatus: "not-delivered",
      clockJumpMs: 0,
    },
    {
      name: "forward wall-clock jump",
      responseStatus: 204,
      expectedStatus: "delivered",
      clockJumpMs: 86_400_000,
    },
  ])(
    "records command webhook delivery through a real HTTP server: $name",
    async ({ responseStatus, expectedStatus, clockJumpMs }) => {
      const started = createDeferred();
      const finish = createDeferred();
      const { cron, job, requests, finished, close } = await createCommandWebhook({
        responseStatus,
        ...(clockJumpMs > 0
          ? {
              timeoutSeconds: 1,
              runCommandJob: async () => {
                started.resolve();
                await finish.promise;
                return { status: "ok", summary: "HOOKSCHED_PAYLOAD" };
              },
            }
          : {}),
      });
      try {
        const run = cron.run(job.id, "force");
        if (clockJumpMs > 0) {
          await started.promise;
          vi.setSystemTime(Date.now() + clockJumpMs);
          finish.resolve();
        }
        await run;
        const finishedEvent = await finished;
        expect(requests).toHaveLength(1);
        expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({
          action: "finished",
          jobId: job.id,
          status: "ok",
          summary: "HOOKSCHED_PAYLOAD",
        });
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "ok",
          lastDeliveryStatus: expectedStatus,
          lastDelivered: responseStatus === 204,
        });
        expect(finishedEvent?.deliveryStatus).toBe(expectedStatus);
        if (responseStatus === 503) {
          expect(cron.getJob(job.id)?.state.lastDeliveryError).toContain("HTTP 503");
          expect(finishedEvent?.deliveryError).toContain("HTTP 503");
        }
      } finally {
        await close();
      }
    },
  );

  it.each(["deadline", "cancellation"] as const)(
    "finalizes a hanging webhook on %s",
    async (cause) => {
      if (cause === "cancellation") {
        vi.useRealTimers();
      }
      const { cron, job, requestBody, finished, close } = await createCommandWebhook({
        timeoutSeconds: cause === "deadline" ? 1 : 0,
      });
      try {
        const run = cron.run(job.id, "force");
        expect(JSON.parse(await requestBody)).toMatchObject({
          jobId: job.id,
          summary: "HOOKSCHED_PAYLOAD",
        });
        if (cause === "deadline") {
          let settled = false;
          void finished.then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(999);
          expect(settled).toBe(false);
          await vi.advanceTimersByTimeAsync(1);
        } else {
          const cancelledAt = performance.now();
          expect(abortActiveCronTaskRuns("Cancelled by operator.")).toBe(1);
          await finished;
          expect(performance.now() - cancelledAt).toBeLessThan(1_000);
        }
        const event = await finished;
        await run;
        const diagnostic =
          cause === "deadline" ? "webhook delivery timed out" : "webhook delivery cancelled";
        expect(event).toMatchObject({
          status: "ok",
          summary: "HOOKSCHED_PAYLOAD",
          delivered: undefined,
          deliveryStatus: "unknown",
        });
        expect(event.deliveryError).toContain(diagnostic);
        if (cause === "cancellation") {
          expect(event.deliveryError).toContain("Cancelled by operator.");
        }
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "ok",
          lastDelivered: undefined,
          lastDeliveryStatus: "unknown",
          runningAtMs: undefined,
        });
        expect(cron.getJob(job.id)?.state.lastDeliveryError).toContain(diagnostic);
      } finally {
        await close();
      }
    },
  );

  it.each([200, 503])(
    "preserves HTTP %s when cancellation races with response cleanup",
    async (responseStatus) => {
      const cleanupStarted = createDeferred();
      const cleanup = createDeferred();
      mocks.fetchWithSsrFGuard.mockImplementationOnce(async (value: unknown) => {
        const request = value as {
          url: string;
          init?: RequestInit;
          signal?: AbortSignal;
        };
        const response = await fetch(request.url, {
          ...request.init,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        return {
          response,
          finalUrl: request.url,
          release: async () => {
            cleanupStarted.resolve();
            await cleanup.promise;
          },
        };
      });
      const { cron, job, requests, finished, close } = await createCommandWebhook({
        responseStatus,
        holdResponse: true,
        runCommandJob: vi.fn(async () => ({ status: "ok" as const, summary: "HOOKSCHED_PAYLOAD" })),
      });
      try {
        const runPromise = cron.run(job.id, "force");
        await cleanupStarted.promise;
        expect(abortActiveCronTaskRuns("Cancelled after webhook acceptance.")).toBe(1);

        const event = await finished;
        cleanup.resolve();
        await runPromise;
        expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
        expect(requests).toHaveLength(1);
        expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({
          jobId: job.id,
          summary: "HOOKSCHED_PAYLOAD",
        });
        expect(event).toMatchObject({
          status: "ok",
          delivered: responseStatus === 200,
          deliveryStatus: responseStatus === 200 ? "delivered" : "not-delivered",
        });
        if (responseStatus === 200) {
          expect(event.deliveryError).toBeUndefined();
        } else {
          expect(event.deliveryError).toContain("Webhook request failed with HTTP 503");
          expect(event.deliveryError).toContain("Cancelled after webhook acceptance.");
        }
        expect(cron.getJob(job.id)?.state).toMatchObject({
          lastRunStatus: "ok",
          lastDelivered: responseStatus === 200,
          lastDeliveryStatus: responseStatus === 200 ? "delivered" : "not-delivered",
        });
        expect(cron.getJob(job.id)?.state.lastDeliveryError).toBe(event.deliveryError);
      } finally {
        cleanup.resolve();
        await close();
      }
    },
  );

  it.each([
    {
      name: "verified primary delivery before a run error",
      result: {
        status: "error",
        delivered: true,
        delivery: verifiedDelivery,
        error: "provider failed after verified delivery",
      },
      state: {
        lastRunStatus: "error",
        consecutiveErrors: 1,
        lastDelivered: true,
        lastDeliveryStatus: "delivered",
        lastDeliveryError: undefined,
      },
      event: {
        completionStatus: "failed",
        delivered: true,
        deliveryStatus: "delivered",
        deliveryError: undefined,
      },
    },
    {
      name: "unverified delivery on a failed run",
      result: { status: "error", delivered: true, error: "Agent couldn't generate a response." },
      state: {
        ...noFailureNotification,
        lastRunStatus: "error",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
        lastDeliveryError: "Agent couldn't generate a response.",
      },
      event: {
        delivered: false,
        deliveryStatus: "not-delivered",
        failureNotificationDelivery: undefined,
      },
    },
    {
      name: "scheduler-authorized alert intent",
      failureAlert: { after: 1 },
      result: { status: "error", error: "provider unavailable" },
      state: { ...noFailureNotification, lastFailureNotificationDeliveryStatus: "unknown" },
      event: { failureNotificationDelivery: { status: "unknown" } },
    },
    {
      name: "suppressed best-effort failure destination",
      delivery: {
        mode: "none",
        bestEffort: true,
        failureDestination: { mode: "webhook", to: "https://example.invalid/cron-failure" },
      },
      result: { status: "error", error: "Agent couldn't generate a response." },
      state: {
        ...noFailureNotification,
        lastRunStatus: "error",
        lastDeliveryStatus: "not-requested",
      },
      event: { deliveryStatus: "not-requested", failureNotificationDelivery: undefined },
    },
    {
      name: "requested delivery without a runner outcome",
      result: {},
      state: {
        ...successfulRun,
        lastDelivered: undefined,
        lastDeliveryStatus: "unknown",
        lastDeliveryError: undefined,
      },
      event: {},
    },
  ] satisfies DeliveryCase[])("persists and emits $name", async (scenario) => {
    const { updated, event } = await runIsolatedJobAndReadState({
      job: {
        ...buildAnnounceIsolatedAgentTurnJob(scenario.name),
        ...("delivery" in scenario ? { delivery: scenario.delivery } : {}),
        ...("failureAlert" in scenario ? { failureAlert: scenario.failureAlert } : {}),
      },
      ...scenario.result,
    });
    expectFields(updated?.state, scenario.state);
    expectFields(event, scenario.event);
  });

  it.each([
    {
      name: "best-effort to required",
      admittedBestEffort: true,
      edits: [false],
      expectedCompletionStatus: "succeeded",
    },
    {
      name: "required A to B to A",
      admittedBestEffort: false,
      edits: [true, false],
      expectedCompletionStatus: "failed",
    },
  ])(
    "authors completion from the admitted delivery policy: $name",
    async ({ admittedBestEffort, edits, expectedCompletionStatus }) => {
      const store = await makeStorePath();
      const started = createDeferred();
      const finish = createDeferred<{
        status: "ok";
        delivered: false;
        deliveryError: string;
      }>();
      let finishedEvent: CronEvent | undefined;
      const cron = createService(store.storePath, {
        runIsolatedAgentJob: vi.fn(async () => {
          started.resolve();
          return await finish.promise;
        }),
        onEvent: (event) => {
          if (event.action === "finished") {
            finishedEvent = event;
          }
        },
      });
      await cron.start();
      const job = await cron.add({
        ...buildAnnounceIsolatedAgentTurnJob(`admitted-policy-${admittedBestEffort}`),
        delivery: {
          mode: "announce",
          channel: "forum",
          to: "123",
          bestEffort: admittedBestEffort,
        },
      });

      const run = cron.run(job.id, "force");
      await started.promise;
      for (const bestEffort of edits) {
        await cron.update(job.id, { delivery: { bestEffort } });
      }
      finish.resolve({
        status: "ok",
        delivered: false,
        deliveryError: "delivery rejected",
      });
      await run;

      expect(finishedEvent).toMatchObject({
        status: "ok",
        deliveryStatus: "not-delivered",
        completionStatus: expectedCompletionStatus,
        deliveryError: "delivery rejected",
        error: undefined,
      });
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        consecutiveErrors: 0,
        lastError: undefined,
        lastDeliveryError: "delivery rejected",
      });
      cron.stop();
      await store.cleanup();
    },
  );
});

describe("cron payload conversion", () => {
  it("persists payload kind conversions without reopening the tool allowlist", async () => {
    const { storePath } = await makeStorePath();
    const cron = createService(storePath, { cronEnabled: false, runIsolatedAgentJob: vi.fn() });

    try {
      const job = await cron.add({
        name: "convert payload",
        enabled: false,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
      });
      const updated = await cron.update(job.id, {
        payload: { kind: "command", argv: ["echo", "ready"], env: undefined },
      });
      expect(updated.payload).toEqual({
        kind: "command",
        argv: ["echo", "ready"],
        toolsAllow: ["read"],
      });
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual(updated.payload);

      await cron.update(job.id, { payload: { kind: "script", script: "return {};" } });
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
        kind: "script",
        script: "return {};",
        timeoutSeconds: 300,
        toolBudget: 50,
        toolsAllow: ["read"],
      });
      await cron.update(job.id, { payload: { kind: "agentTurn", message: "after" } });
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
        kind: "agentTurn",
        message: "after",
        toolsAllow: ["read"],
      });

      await expect(
        cron.update(job.id, {
          payload: { kind: "command", argv: ["echo"], env: null as never },
        }),
      ).rejects.toThrow("command env");
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
        kind: "agentTurn",
        message: "after",
        toolsAllow: ["read"],
      });

      const configured = { kind: "command", argv: ["echo"], env: { MODE: "test" } } as const;
      await cron.update(job.id, { payload: { ...configured, argv: [...configured.argv] } });
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
        ...configured,
        toolsAllow: ["read"],
      });
    } finally {
      cron.stop();
    }
  });
});

describe("CronService persists delivery suppression", () => {
  it("persists scheduled suppression in state, history, and events and clears it after delivery", async () => {
    const { storePath } = await makeStorePath();
    const schedulerClock = createGatewaySchedulerClock(Date.now());
    const events: CronEvent[] = [];
    const finished = createFinishedBarrier();
    const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>();
    runIsolatedAgentJob.mockResolvedValue({
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
      deliverySuppressionReason: "channel_transform",
    });
    const cron = createService(storePath, {
      scheduler: createTestGatewayScheduler(schedulerClock.clock),
      runIsolatedAgentJob,
      onEvent: (event) => {
        if (event.action === "finished") {
          events.push(event);
        }
        finished.onEvent(event);
      },
    });
    await cron.start();
    try {
      const job = await cron.add({
        name: "suppression-readback",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "test" },
        delivery: { mode: "announce", channel: "forum", to: "123" },
      });
      const done = finished.waitForOk(job.id);
      await schedulerClock.advanceTo(job.state.nextRunAtMs!);
      await done;
      const persisted = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
      expect.soft(persisted?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDelivered: false,
        lastDeliveryStatus: "not-delivered",
        deliverySuppressionReason: "channel_transform",
      });
      expect.soft(persisted?.state.lastDeliveryError).toBeUndefined();
      expect
        .soft(events)
        .toEqual([expect.objectContaining({ deliverySuppressionReason: "channel_transform" })]);
      const history = readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(storePath),
        jobId: job.id,
      });
      expect
        .soft(history.entries)
        .toEqual([expect.objectContaining({ deliverySuppressionReason: "channel_transform" })]);

      runIsolatedAgentJob.mockResolvedValue({ status: "ok", delivered: true });
      schedulerClock.setTime(schedulerClock.clock.now() + 1);
      await cron.run(job.id, "force");
      expect(
        (await loadCronStore(storePath)).jobs[0]?.state.deliverySuppressionReason,
      ).toBeUndefined();
      expect(events.at(-1)?.deliverySuppressionReason).toBeUndefined();
      expect(
        readCronRunHistoryPageForTests({ storeKey: cronStoreKey(storePath), jobId: job.id })
          .entries[0]?.deliverySuppressionReason,
      ).toBeUndefined();
    } finally {
      cron.stop();
    }
  });
});
