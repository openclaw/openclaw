import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { promisify } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import type { CronEvent, CronService } from "./service.js";
import {
  createCronServiceWithStateForTest,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
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
const noFailureNotification = {
  lastFailureNotificationDelivered: undefined,
  lastFailureNotificationDeliveryStatus: "not-requested",
  lastFailureNotificationDeliveryError: undefined,
} as const;
const destination = { channel: "forum", to: "123" };
const commandOk = { status: "ok", summary: "HOOKSCHED_PAYLOAD" } as const;
const commandError = { status: "error", error: "command exited with code 1" } as const;
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
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address() as AddressInfo;
  const sendCronFailureAlert = vi.fn(async () => {});
  const runCronFailureRepair = vi.fn(async () => {});
  const enqueueSystemEvent = vi.fn();
  const { cron, clock, finished } = await createScheduledService({
    sendCronFailureAlert,
    runCronFailureRepair,
    enqueueSystemEvent,
    runCommandJob:
      options.runCommandJob ??
      (async ({ job, abortSignal }) =>
        await runCronCommandJob({ job, abortSignal, nowMs: Date.now })),
    sendCronWebhook: (params) =>
      sendGatewayCronWebhook({ ...params, ssrfPolicy: { allowedHostnames: ["127.0.0.1"] } }),
  });
  const job = await cron.add({
    ...agentJob("command webhook"),
    ...(options.oneShot
      ? {
          schedule: { kind: "at" as const, at: new Date(Date.now() + 60_000).toISOString() },
          failureAlert: { after: 1, channel: "telegram", to: "123" },
        }
      : {}),
    payload: {
      kind: "command",
      argv: [process.execPath, "-e", "process.stdout.write('HOOKSCHED_PAYLOAD')"],
      ...(options.timeoutSeconds === undefined ? {} : { timeoutSeconds: options.timeoutSeconds }),
    },
    delivery: { mode: "webhook", to: `http://127.0.0.1:${address.port}/hook` },
  });
  return {
    clock,
    cron,
    job,
    requests,
    sendCronFailureAlert,
    runCronFailureRepair,
    enqueueSystemEvent,
    finished,
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
      server.closeAllConnections();
      await promisify(server.close.bind(server))();
    },
  };
}

function agentJob(name: string, overrides: Partial<CronAddInput> = {}): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "test" },
    delivery: { mode: "announce", ...destination },
    ...overrides,
  };
}

async function createScheduledService(deps: Partial<CronServiceDeps> = {}, start = true) {
  const { storePath, cleanup } = await makeStorePath();
  const clock = createGatewaySchedulerClock(Date.now());
  const finished = createDeferred<CronEvent>();
  const events: CronEvent[] = [];
  const { cron, state } = createCronServiceWithStateForTest({
    scheduler: createTestGatewayScheduler(clock.clock),
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...deps,
    onEvent: (event) => {
      if (event.action === "finished") {
        events.push(event);
        finished.resolve(event);
      }
    },
  });
  if (start) {
    await cron.start();
  }
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

describe("CronService persists delivered status", () => {
  it.each([
    ["failing endpoint", 503, "not-delivered", 0],
    ["forward wall-clock jump", 204, "delivered", 86_400_000],
  ] as const)(
    "records command webhook delivery through a real HTTP server: %s",
    async (_name, responseStatus, expectedStatus, clockJumpMs) => {
      const execution = gate(commandOk);
      await using h = await createCommandWebhook({
        oneShot: true,
        responseStatus,
        ...(clockJumpMs > 0
          ? {
              timeoutSeconds: 1,
              runCommandJob: execution.run,
            }
          : {}),
      });
      const run = h.run();
      if (clockJumpMs > 0) {
        await execution.entered;
        vi.setSystemTime(Date.now() + clockJumpMs);
        execution.release();
      }
      await run;
      const event = await h.finished;
      expect(h.requests).toHaveLength(1);
      await h.expectRequest({ action: "finished", ...commandOk });
      h.expectDelivery(event, responseStatus === 204, expectedStatus);
      expect(h.sendCronFailureAlert).toHaveBeenCalledTimes(responseStatus === 503 ? 1 : 0);
      if (responseStatus === 503) {
        expect(h.state()?.lastDeliveryError).toContain("HTTP 503");
        expect(event.deliveryError).toContain("HTTP 503");
      }
    },
  );

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
        failureAlert: { after: 1, channel: "telegram", to: "123" },
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
      expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledOnce();
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
        lastStatus: "ok",
        lastRunStatus: "ok",
        lastDelivered: undefined,
        lastDeliveryStatus: "unknown",
        lastDeliveryError: undefined,
      },
      event: {},
    },
  ] satisfies DeliveryCase[])("persists and emits $name", async (scenario) => {
    await using h = await createScheduledService({
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        summary: "done",
        ...scenario.result,
      })),
    });
    const { cron, clock, tick, finished } = h;
    const added = await cron.add(
      agentJob(scenario.name, {
        ...("delivery" in scenario ? { delivery: scenario.delivery } : {}),
        ...("failureAlert" in scenario ? { failureAlert: scenario.failureAlert } : {}),
      }),
    );
    clock.setTime(added.state.nextRunAtMs! + 5);
    await tick();
    const event = await finished;
    const updated = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === added.id,
    );
    expectFields(updated?.state, scenario.state);
    expectFields(event, scenario.event);
  });

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
  it("persists payload kind conversions without reopening the tool allowlist", async () => {
    await using h = await createScheduledService(
      { cronEnabled: false, runIsolatedAgentJob: vi.fn() },
      false,
    );

    const { cron, storePath } = h;
    const job = await cron.add({
      ...agentJob("convert payload", { enabled: false, delivery: undefined }),
      payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
    });
    const expectPayload = async (payload: CronJob["payload"]) => {
      const expected = { ...payload, toolsAllow: ["read"] };
      expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual(expected);
      return expected;
    };
    const command = { kind: "command" as const, argv: ["echo", "ready"] };
    const updated = await cron.update(job.id, {
      payload: { ...command, env: undefined },
    });
    expect(updated.payload).toEqual(await expectPayload(command));

    await cron.update(job.id, { payload: { kind: "script", script: "return {};" } });
    await expectPayload({
      kind: "script",
      script: "return {};",
      timeoutSeconds: 300,
      toolBudget: 50,
    });
    const agent = { kind: "agentTurn", message: "after" } as const;
    await cron.update(job.id, { payload: agent });
    await expectPayload(agent);

    expect(() =>
      normalizeCronJobPatch({
        payload: { kind: "command", argv: ["echo"], env: null },
      }),
    ).toThrow("command env");
    await expectPayload(agent);

    const configured = { kind: "command", argv: ["echo"], env: { MODE: "test" } } as const;
    await cron.update(job.id, { payload: { ...configured, argv: [...configured.argv] } });
    await expectPayload({ ...configured, argv: [...configured.argv] });
  });
  it("persists scheduled suppression in state, history, and events and clears it after delivery", async () => {
    const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>();
    runIsolatedAgentJob.mockResolvedValue({
      status: "ok",
      delivered: false,
      deliveryAttempted: true,
      deliverySuppressionReason: "channel_transform",
    });
    await using h = await createScheduledService({
      runIsolatedAgentJob,
    });
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
