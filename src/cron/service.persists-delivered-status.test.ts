import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createFinishedBarrier,
  createStartedCronServiceWithFinishedBarrier,
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";

const noopLogger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness();
installCronTestHooks({ logger: noopLogger });

type CronAddInput = Parameters<CronService["add"]>[0];

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

function buildMainSessionSystemEventJob(name: string): CronAddInput {
  return {
    name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "tick" },
  };
}

function createIsolatedCronWithFinishedBarrier(params: {
  storePath: string;
  delivered?: boolean;
  deliveryError?: string;
  onFinished?: (evt: {
    jobId: string;
    delivered?: boolean;
    deliveryStatus?: string;
    deliveryError?: string;
    source?: string;
    correlationId?: string;
    cronJobId?: string;
  }) => void;
}) {
  const finished = createFinishedBarrier();
  const cron = new CronService({
    storePath: params.storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeatNow: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      ...(params.delivered === undefined ? {} : { delivered: params.delivered }),
      ...(params.deliveryError === undefined ? {} : { deliveryError: params.deliveryError }),
    })),
    onEvent: (evt) => {
      if (evt.action === "finished") {
        params.onFinished?.({
          jobId: evt.jobId,
          delivered: evt.delivered,
          deliveryStatus: evt.deliveryStatus,
          deliveryError: evt.deliveryError,
          source: evt.source,
          correlationId: evt.correlationId,
          cronJobId: evt.cronJobId,
        });
      }
      finished.onEvent(evt);
    },
  });
  return { cron, finished };
}

async function runSingleJobAndReadState(params: {
  cron: CronService;
  finished: ReturnType<typeof createFinishedBarrier>;
  job: CronAddInput;
}) {
  const job = await params.cron.add(params.job);
  vi.setSystemTime(new Date(job.state.nextRunAtMs! + 5));
  await vi.runOnlyPendingTimersAsync();
  await params.finished.waitForOk(job.id);

  const jobs = await params.cron.list({ includeDisabled: true });
  return { job, updated: jobs.find((entry) => entry.id === job.id) };
}

function expectSuccessfulCronRun(
  updated:
    | {
        state: {
          lastStatus?: string;
          lastRunStatus?: string;
          [key: string]: unknown;
        };
      }
    | undefined,
) {
  expect(updated?.state.lastStatus).toBe("ok");
  expect(updated?.state.lastRunStatus).toBe("ok");
}

function expectDeliveryNotRequested(
  updated:
    | {
        state: {
          lastDelivered?: boolean;
          lastDeliveryStatus?: string;
          lastDeliveryError?: string;
        };
      }
    | undefined,
) {
  expectSuccessfulCronRun(updated);
  expect(updated?.state.lastDelivered).toBeUndefined();
  expect(updated?.state.lastDeliveryStatus).toBe("not-requested");
  expect(updated?.state.lastDeliveryError).toBeUndefined();
}

async function runIsolatedJobAndReadState(params: {
  job: CronAddInput;
  delivered?: boolean;
  deliveryError?: string;
  onFinished?: (evt: {
    jobId: string;
    delivered?: boolean;
    deliveryStatus?: string;
    deliveryError?: string;
    source?: string;
    correlationId?: string;
    cronJobId?: string;
  }) => void;
}) {
  const store = await makeStorePath();
  const { cron, finished } = createIsolatedCronWithFinishedBarrier({
    storePath: store.storePath,
    ...(params.delivered !== undefined ? { delivered: params.delivered } : {}),
    ...(params.deliveryError !== undefined ? { deliveryError: params.deliveryError } : {}),
    ...(params.onFinished ? { onFinished: params.onFinished } : {}),
  });

  await cron.start();
  try {
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: params.job,
    });
    return updated;
  } finally {
    cron.stop();
  }
}

describe("CronService persists delivered status", () => {
  it("persists lastDelivered=true when isolated job reports delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("delivered-true"),
      delivered: true,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(true);
    expect(updated?.state.lastDeliveryStatus).toBe("delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("persists lastDelivered=false when isolated job explicitly reports not delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("delivered-false"),
      delivered: false,
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("persists deliveryError without downgrading execution status", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("delivery-error"),
      delivered: false,
      deliveryError: "announce failed",
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBe(false);
    expect(updated?.state.lastDeliveryStatus).toBe("not-delivered");
    expect(updated?.state.lastDeliveryError).toBe("announce failed");
    expect(updated?.state.lastError).toBeUndefined();
  });

  it("persists not-requested delivery state when delivery is not configured", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("no-delivery"),
    });
    expectDeliveryNotRequested(updated);
  });

  it("persists unknown delivery state when delivery is requested but the runner omits delivered", async () => {
    const updated = await runIsolatedJobAndReadState({
      job: {
        ...buildIsolatedAgentTurnJob("delivery-unknown"),
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      },
    });
    expectSuccessfulCronRun(updated);
    expect(updated?.state.lastDelivered).toBeUndefined();
    expect(updated?.state.lastDeliveryStatus).toBe("unknown");
    expect(updated?.state.lastDeliveryError).toBeUndefined();
  });

  it("does not set lastDelivered for main session jobs", async () => {
    const store = await makeStorePath();
    const { cron, enqueueSystemEvent, finished } = createStartedCronServiceWithFinishedBarrier({
      storePath: store.storePath,
      logger: noopLogger,
    });

    await cron.start();
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: buildMainSessionSystemEventJob("main-session"),
    });

    expectDeliveryNotRequested(updated);
    expect(enqueueSystemEvent).toHaveBeenCalled();

    cron.stop();
  });

  it("emits delivered in the finished event", async () => {
    let capturedEvent:
      | {
          jobId: string;
          delivered?: boolean;
          deliveryStatus?: string;
          deliveryError?: string;
          source?: string;
          correlationId?: string;
          cronJobId?: string;
        }
      | undefined;
    await runIsolatedJobAndReadState({
      job: buildIsolatedAgentTurnJob("event-test"),
      delivered: false,
      deliveryError: "announce failed",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent?.delivered).toBe(false);
    expect(capturedEvent?.deliveryStatus).toBe("not-delivered");
    expect(capturedEvent?.deliveryError).toBe("announce failed");
  });

  it("emits cron attribution fields for manual finished events", async () => {
    const store = await makeStorePath();
    let capturedEvent:
      | {
          jobId: string;
          source?: string;
          correlationId?: string;
          cronJobId?: string;
        }
      | undefined;
    const { cron } = createIsolatedCronWithFinishedBarrier({
      storePath: store.storePath,
      delivered: false,
      deliveryError: "announce failed",
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    await cron.start();
    try {
      const job = await cron.add({
        ...buildIsolatedAgentTurnJob("manual-event-test"),
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      await cron.run(job.id, "force");

      expect(capturedEvent).toBeDefined();
      expect(capturedEvent?.jobId).toBe(job.id);
      expect(capturedEvent?.source).toBe("cron");
      expect(capturedEvent?.correlationId).toBe(job.id);
      expect(capturedEvent?.cronJobId).toBe(job.id);
    } finally {
      cron.stop();
    }
  });
});
