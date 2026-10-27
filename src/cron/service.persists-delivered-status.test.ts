import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred } from "../../test/helpers/promise.js";
const mocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn<typeof import("../infra/net/fetch-guard.js").fetchWithSsrFGuard>(),
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
import { normalizeCronJobPatch } from "./normalize.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronTestDeps, cronTestInput } from "./service.fixture-builders.test-support.js";
import type { CronEvent, CronService } from "./service.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "./service.test-harness.js";
import { abortActiveCronTaskRuns } from "./service/active-run-cancellation.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";
import { loadCronStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import type { CronJob } from "./types.js";

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("../infra/net/fetch-guard.js")>(
    "../infra/net/fetch-guard.js",
  );
  mocks.fetchWithSsrFGuard.mockReset().mockImplementation(actual.fetchWithSsrFGuard);
});

const { logger, makeStorePath } = setupCronServiceSuite();

type CronAddInput = Parameters<CronService["add"]>[0];
const destination = { channel: "forum", to: "123" };
const commandOk = { status: "ok", summary: "HOOKSCHED_PAYLOAD" } as const;
const commandError = { status: "error", error: "command exited with code 1" } as const;
const failureAlert = { after: 1, channel: "telegram", to: "123" };
const deliveryRejected = {
  status: "ok",
  delivered: false,
  deliveryError: "delivery rejected",
} as const;
const verifiedDelivery = {
  delivered: true,
  resolved: { ok: true, ...destination },
  messageToolSentTo: [destination],
};

function expectFields(actual: object | undefined, expected: object) {
  expect(actual).toBeDefined();
  for (const [key, value] of Object.entries(expected)) {
    expect(actual && Reflect.get(actual, key), key).toEqual(value);
  }
}

function gate<T>(value: T) {
  const entered = createDeferred();
  const done = createDeferred<T>();
  return {
    entered: entered.promise,
    release: () => done.resolve(value),
    run: async () => {
      entered.resolve();
      return await done.promise;
    },
  };
}

async function createCommandWebhook(
  options: {
    responseStatus?: number;
    holdResponse?: boolean;
    timeoutSeconds?: number;
    oneShot?: boolean;
    runCommandJob?: CronServiceDeps["runCommandJob"];
    beforeClose?: () => void;
  } = {},
) {
  const requests: string[] = [];
  const bodyReceived = createDeferred<string>();
  const server = createServer((request, response) => {
    void text(request).then((body) => {
      requests.push(body);
      bodyReceived.resolve(body);
      if (options.responseStatus !== undefined) {
        response.writeHead(options.responseStatus);
        if (options.holdResponse) {
          response.flushHeaders();
          response.write("accepted");
        } else {
          response.end();
        }
      }
    });
  });
  const url = await listenLoopback(server);
  const sendCronFailureAlert = vi.fn(async () => {});
  const runCronFailureRepair = vi.fn(async () => {});
  const enqueueSystemEvent = vi.fn();
  const service = await createScheduledService({
    sendCronFailureAlert,
    runCronFailureRepair,
    enqueueSystemEvent,
    runCommandJob: options.runCommandJob ?? runCronCommandJob,
    sendCronWebhook: (params) =>
      sendGatewayCronWebhook({ ...params, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } }),
  });
  const { cron } = service;
  const job = await cron.add({
    ...agentJob("command webhook"),
    ...(options.oneShot
      ? {
          schedule: { kind: "at" as const, at: new Date(Date.now() + 60_000).toISOString() },
          failureAlert,
        }
      : {}),
    payload: {
      kind: "command",
      argv: [process.execPath, "-e", "process.stdout.write('HOOKSCHED_PAYLOAD')"],
      ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    },
    delivery: { mode: "webhook", to: `${url}/hook` },
  });
  return {
    ...service,
    job,
    requests,
    sendCronFailureAlert,
    runCronFailureRepair,
    enqueueSystemEvent,
    run: (mode: "force" | "due" = "force") => cron.run(job.id, mode),
    state: () => cron.getJob(job.id)?.state,
    expectRequest: async (expected: object = { summary: "HOOKSCHED_PAYLOAD" }) => {
      expect(JSON.parse(await bodyReceived.promise)).toMatchObject({ jobId: job.id, ...expected });
    },
    expectDelivery: (
      event: CronEvent,
      delivered: boolean | undefined,
      status: CronJob["state"]["lastDeliveryStatus"],
    ) => {
      expect(cron.getJob(job.id)?.state).toMatchObject({
        lastRunStatus: "ok",
        lastDelivered: delivered,
        lastDeliveryStatus: status,
      });
      expect(event).toMatchObject({ status: "ok", delivered, deliveryStatus: status });
    },
    [Symbol.asyncDispose]: async () => {
      options.beforeClose?.();
      cron.stop();
      await closeHttpServer(server);
    },
  };
}

const agentJob = (name: string, overrides: Partial<CronAddInput> = {}) =>
  cronTestInput({ name, delivery: { mode: "announce", ...destination }, ...overrides });

async function createScheduledService(deps: Partial<CronServiceDeps> = {}) {
  const { storePath, cleanup } = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const finished = createDeferred<CronEvent>();
  const events: CronEvent[] = [];
  const { cron, state } = createCronServiceWithStateForTest({
    ...cronTestDeps({ storePath, nowMs: undefined }),
    scheduler: createTestGatewayScheduler(clock.clock),
    log: logger,
    ...deps,
    onEvent: (event) => {
      if (event.action === "finished") {
        events.push(event);
        finished.resolve(event);
      }
    },
  });
  await cron.start();
  return {
    cron,
    storePath,
    clock,
    finished: finished.promise,
    events,
    tick: () => onTimer(state),
    [Symbol.asyncDispose]: async () => {
      cron.stop();
      await cleanup();
    },
  };
}

async function createAgentOutputWebhook(
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"],
) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    void text(request).then((body) => {
      requests.push(body);
      response.writeHead(204);
      response.end();
    });
  });
  const url = await listenLoopback(server);
  const service = await createScheduledService({
    enqueueSystemEvent: vi.fn(),
    runIsolatedAgentJob,
    sendCronWebhook: (params) =>
      sendGatewayCronWebhook({ ...params, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } }),
  });
  const { cron } = service;
  const job = await cron.add({
    ...agentJob("isolated output webhook"),
    delivery: { mode: "webhook", to: `${url}/hook` },
  });
  return {
    ...service,
    job,
    requests,
    run: () => cron.run(job.id, "force"),
    lastBody: () => JSON.parse(requests.at(-1)!) as Record<string, unknown>,
    [Symbol.asyncDispose]: async () => {
      cron.stop();
      await closeHttpServer(server);
    },
  };
}

describe("isolated agent webhook full output", () => {
  const fullOutput = `CRON_FULL_OUTPUT_PROOF_${"Automated report line with details. ".repeat(90)}`;
  const boundedSummary = `${fullOutput.slice(0, 2000)}…`;

  it("sends untruncated outputText while the summary keeps its bounded shape", async () => {
    await using h = await createAgentOutputWebhook(async () => ({
      status: "ok",
      summary: boundedSummary,
      outputText: fullOutput,
    }));
    await h.run();
    const body = h.lastBody();
    expect(body.outputText).toBe(fullOutput);
    expect(body.summary).toBe(boundedSummary);
    expect(String(body.summary)).toHaveLength(2001);
    expect(String(body.summary).endsWith("…")).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it("omits outputText when the run produced no non-empty output text", async () => {
    const runIsolatedAgentJob = vi
      .fn<CronServiceDeps["runIsolatedAgentJob"]>()
      .mockResolvedValueOnce({ status: "ok", summary: "quiet check finished" })
      .mockResolvedValueOnce({ status: "ok", summary: "whitespace output", outputText: "   " });
    await using h = await createAgentOutputWebhook(runIsolatedAgentJob);
    await h.run();
    expect(h.lastBody()).not.toHaveProperty("outputText");
    await h.run();
    expect(h.lastBody()).not.toHaveProperty("outputText");
  });

  it("keeps failed-run webhooks free of both summary and outputText", async () => {
    await using h = await createAgentOutputWebhook(async () => ({
      status: "error",
      error: "agent run failed",
      summary: boundedSummary,
      outputText: fullOutput,
    }));
    await h.run();
    const body = h.lastBody();
    expect(body).toMatchObject({ status: "error", error: "agent run failed" });
    expect(body).not.toHaveProperty("summary");
    expect(body).not.toHaveProperty("outputText");
  });
});

describe("CronService persists delivered status", () => {
  it("delivers a command webhook after a forward wall-clock jump", async () => {
    const execution = gate(commandOk);
    await using h = await createCommandWebhook({
      oneShot: true,
      responseStatus: 204,
      timeoutSeconds: 1,
      runCommandJob: execution.run,
    });
    const run = h.run();
    await execution.entered;
    vi.setSystemTime(Date.now() + 86_400_000);
    execution.release();
    await run;
    const event = await h.finished;
    expect(h.requests).toHaveLength(1);
    await h.expectRequest({ action: "finished", ...commandOk });
    h.expectDelivery(event, true, "delivered");
    expect(h.sendCronFailureAlert).not.toHaveBeenCalled();
  });

  it.each(["deadline", "cancellation"] as const)(
    "finalizes a hanging webhook on %s",
    async (cause) => {
      if (cause === "cancellation") {
        vi.useRealTimers();
      }
      await using h = await createCommandWebhook({
        timeoutSeconds: cause === "deadline" ? 1 : 0,
      });
      const run = h.run();
      await h.expectRequest();
      if (cause === "deadline") {
        let settled = false;
        void h.finished.then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(999);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
      } else {
        const cancelledAt = performance.now();
        expect(abortActiveCronTaskRuns("Cancelled by operator.")).toBe(1);
        await h.finished;
        expect(performance.now() - cancelledAt).toBeLessThan(1_000);
      }
      const event = await h.finished;
      await run;
      const diagnostic =
        cause === "deadline" ? "webhook delivery timed out" : "webhook delivery cancelled";
      h.expectDelivery(event, undefined, "unknown");
      expect(event.summary).toBe("HOOKSCHED_PAYLOAD");
      expect(event.deliveryError).toContain(diagnostic);
      if (cause === "cancellation") {
        expect(event.deliveryError).toContain("Cancelled by operator.");
      }
      expect(h.state()?.runningAtMs).toBeUndefined();
      expect(h.state()?.lastDeliveryError).toContain(diagnostic);
    },
  );

  it.each([0, 9])(
    "counts a completed core failure after webhook cancellation with %s prior failures",
    async (consecutiveErrors) => {
      await using h = await createCommandWebhook({
        timeoutSeconds: 0,
        runCommandJob: async () => ({
          ...commandError,
          ...(consecutiveErrors === 0
            ? { errorClassification: { kind: "permanent" as const } }
            : {}),
        }),
      });
      await h.cron.update(h.job.id, {
        state: { consecutiveErrors },
        failureAlert,
      });
      h.clock.setTime(h.job.state.nextRunAtMs!);
      const run = h.run("due");
      await h.expectRequest(commandError);
      expect(abortActiveCronTaskRuns("Cancelled during webhook delivery.")).toBe(1);
      await run;
      expect(await h.finished).toMatchObject({ ...commandError, deliveryStatus: "unknown" });
      const updated = await h.cron.readJob(h.job.id);
      expect(updated?.state.consecutiveErrors).toBe(consecutiveErrors + 1);
      expect(updated?.state.lastDeliveryError).toContain("Cancelled during webhook delivery.");
      expect(updated?.enabled).toBe(consecutiveErrors === 0);
      if (consecutiveErrors === 9) {
        expect(updated?.state.autoDisabled).toMatchObject({
          reason: "consecutive-failures",
          consecutiveErrors: 10,
        });
      } else {
        expect(h.sendCronFailureAlert).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([200, 503])(
    "preserves HTTP %s when cancellation races with response cleanup",
    async (responseStatus) => {
      const cleanup = gate(undefined);
      mocks.fetchWithSsrFGuard.mockImplementationOnce(async (request) => {
        const response = await fetch(request.url, {
          ...request.init,
          ...(request.signal ? { signal: request.signal } : {}),
        });
        return {
          response,
          finalUrl: request.url,
          release: cleanup.run,
        };
      });
      await using h = await createCommandWebhook({
        oneShot: true,
        responseStatus,
        holdResponse: true,
        beforeClose: cleanup.release,
        runCommandJob: vi.fn(async () => commandOk),
      });
      const runPromise = h.run();
      await cleanup.entered;
      expect(abortActiveCronTaskRuns("Cancelled after webhook acceptance.")).toBe(1);

      const event = await h.finished;
      cleanup.release();
      await runPromise;
      expect(h.requests).toHaveLength(1);
      await h.expectRequest();
      h.expectDelivery(
        event,
        responseStatus === 200,
        responseStatus === 200 ? "delivered" : "not-delivered",
      );
      if (responseStatus === 200) {
        expect(event.deliveryError).toBeUndefined();
      } else {
        expect(event.deliveryError).toContain("Webhook request failed with HTTP 503");
        expect(event.deliveryError).toContain("Cancelled after webhook acceptance.");
      }
      expect(h.state()?.lastDeliveryError).toBe(event.deliveryError);
      expect(h.state()?.autoDisabled).toBeUndefined();
      expect(h.sendCronFailureAlert).not.toHaveBeenCalled();
      expect(h.runCronFailureRepair).not.toHaveBeenCalled();
      expect(h.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "persists failed-run delivery evidence (verified=%s)",
    async (verified) => {
      const error = verified
        ? "provider failed after verified delivery"
        : "Agent couldn't generate a response.";
      await using h = await createScheduledService({
        runIsolatedAgentJob: async () => ({
          status: "error",
          delivered: true,
          error,
          ...(verified ? { delivery: verifiedDelivery } : {}),
        }),
      });
      const { cron, clock, tick, finished } = h;
      const added = await cron.add(agentJob("failed-run delivery"));
      clock.setTime(added.state.nextRunAtMs! + 5);
      await tick();
      const event = await finished;
      const updated = (await cron.list({ includeDisabled: true })).find(
        (entry) => entry.id === added.id,
      );
      const deliveryStatus = verified ? "delivered" : "not-delivered";
      expectFields(updated?.state, {
        lastRunStatus: "error",
        lastDelivered: verified,
        lastDeliveryStatus: deliveryStatus,
        lastDeliveryError: verified ? undefined : error,
      });
      expectFields(event, {
        completionStatus: "failed",
        delivered: verified,
        deliveryStatus,
        ...(!verified ? { failureNotificationDelivery: undefined } : { deliveryError: undefined }),
      });
    },
  );

  it.each([
    ["best-effort to required", true, [false], "succeeded"],
    ["required A to B to A", false, [true, false], "failed"],
  ] as const)(
    "authors completion from the admitted delivery policy: %s",
    async (_name, admittedBestEffort, edits, expectedCompletionStatus) => {
      const execution = gate(deliveryRejected);
      await using h = await createScheduledService({
        runIsolatedAgentJob: vi.fn(execution.run),
      });
      const { cron, finished } = h;
      const job = await cron.add({
        ...agentJob(`admitted-policy-${admittedBestEffort}`),
        delivery: { mode: "announce", ...destination, bestEffort: admittedBestEffort },
      });

      const run = cron.run(job.id, "force");
      await execution.entered;
      for (const bestEffort of edits) {
        await cron.update(job.id, { delivery: { bestEffort } });
      }
      execution.release();
      await run;

      expect(await finished).toMatchObject({
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
    },
  );
  it("rejects null command environments", () => {
    expect(() =>
      normalizeCronJobPatch({
        payload: { kind: "command", argv: ["echo"], env: null },
      }),
    ).toThrow("command env");
  });
  it("persists scheduled suppression in state, history, and events and clears it after delivery", async () => {
    const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>().mockResolvedValue({
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
      deliverySuppressionReason: "channel_transform",
    });
    await using h = await createScheduledService({ runIsolatedAgentJob });
    const { cron, storePath, clock, tick, events, finished } = h;
    const job = await cron.add(agentJob("suppression-readback"));
    const readHistory = () =>
      readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(storePath),
        jobId: job.id,
      }).entries;
    const suppressed = { deliverySuppressionReason: "channel_transform" };
    clock.setTime(job.state.nextRunAtMs!);
    await tick();
    expect((await finished).status).toBe("ok");
    const persisted = (await loadCronStore(storePath)).jobs.find((entry) => entry.id === job.id);
    expect.soft(persisted?.state).toMatchObject({
      lastRunStatus: "ok",
      lastDelivered: false,
      lastDeliveryStatus: "not-delivered",
      ...suppressed,
    });
    expect.soft(persisted?.state.lastDeliveryError).toBeUndefined();
    expect.soft(events).toEqual([expect.objectContaining(suppressed)]);
    expect.soft(readHistory()).toEqual([expect.objectContaining(suppressed)]);

    runIsolatedAgentJob.mockResolvedValue({ status: "ok", delivered: true });
    clock.setTime(clock.clock.now() + 1);
    await cron.run(job.id, "force");
    expect([
      (await loadCronStore(storePath)).jobs[0]?.state.deliverySuppressionReason,
      events.at(-1)?.deliverySuppressionReason,
      readHistory()[0]?.deliverySuppressionReason,
    ]).toEqual([undefined, undefined, undefined]);
  });
});
