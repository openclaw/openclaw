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
  onFinished?: (evt: { jobId: string; delivered?: boolean }) => void;
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
    })),
    onEvent: (evt) => {
      if (evt.action === "finished") {
        params.onFinished?.({ jobId: evt.jobId, delivered: evt.delivered });
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

describe("CronService persists delivered status", () => {
  it("persists lastDelivered=true when isolated job reports delivered", async () => {
    const store = await makeStorePath();
    const { cron, finished } = createIsolatedCronWithFinishedBarrier({
      storePath: store.storePath,
      delivered: true,
    });

    await cron.start();
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: buildIsolatedAgentTurnJob("delivered-true"),
    });

    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastDelivered).toBe(true);

    cron.stop();
  });

  it("persists lastDelivered=false when isolated job explicitly reports not delivered", async () => {
    const store = await makeStorePath();
    const { cron, finished } = createIsolatedCronWithFinishedBarrier({
      storePath: store.storePath,
      delivered: false,
    });

    await cron.start();
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: buildIsolatedAgentTurnJob("delivered-false"),
    });

    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastDelivered).toBe(false);

    cron.stop();
  });

  it("persists lastDelivered=undefined when isolated job does not deliver", async () => {
    const store = await makeStorePath();
    const { cron, finished } = createIsolatedCronWithFinishedBarrier({
      storePath: store.storePath,
    });

    await cron.start();
    const { updated } = await runSingleJobAndReadState({
      cron,
      finished,
      job: buildIsolatedAgentTurnJob("no-delivery"),
    });

    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastDelivered).toBeUndefined();

    cron.stop();
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

    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastDelivered).toBeUndefined();
    expect(enqueueSystemEvent).toHaveBeenCalled();

    cron.stop();
  });

  it("emits delivered in the finished event", async () => {
    const store = await makeStorePath();
    let capturedEvent: { jobId: string; delivered?: boolean } | undefined;
    const { cron, finished } = createIsolatedCronWithFinishedBarrier({
      storePath: store.storePath,
      delivered: true,
      onFinished: (evt) => {
        capturedEvent = evt;
      },
    });

    await cron.start();
    await runSingleJobAndReadState({
      cron,
      finished,
      job: buildIsolatedAgentTurnJob("event-test"),
    });

    expect(capturedEvent).toBeDefined();
    expect(capturedEvent?.delivered).toBe(true);
    cron.stop();
  });
});
