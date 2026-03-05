import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob, CronMessageChannel } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-heartbeat-target",
});

type RunHeartbeatOnce = NonNullable<
  ConstructorParameters<typeof CronService>[0]["runHeartbeatOnce"]
>;

describe("cron main job passes heartbeat target=last", () => {
  function createMainCronJob(params: {
    now: number;
    id: string;
    wakeMode: CronJob["wakeMode"];
  }): CronJob {
    return {
      id: params.id,
      name: params.id,
      enabled: true,
      createdAtMs: params.now - 10_000,
      updatedAtMs: params.now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: params.wakeMode,
      payload: { kind: "systemEvent", text: "Check in" },
      state: { nextRunAtMs: params.now - 1 },
    };
  }

  function createCronWithSpies(params: { storePath: string; runHeartbeatOnce: RunHeartbeatOnce }) {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const cron = new CronService({
      storePath: params.storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent,
      requestHeartbeatNow,
      runHeartbeatOnce: params.runHeartbeatOnce,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    return { cron, requestHeartbeatNow };
  }

  async function runSingleTick(cron: CronService) {
    await cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    cron.stop();
  }

  it("should pass heartbeat.target=last to runHeartbeatOnce for wakeMode=now main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-main-delivery",
      wakeMode: "now",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({
      storePath,
      runHeartbeatOnce,
    });

    await runSingleTick(cron);

    // runHeartbeatOnce should have been called
    expect(runHeartbeatOnce).toHaveBeenCalled();

    // The heartbeat config passed should include target: "last" so the
    // heartbeat runner delivers the response to the last active channel.
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.heartbeat).toBeDefined();
    expect(callArgs?.heartbeat?.target).toBe("last");
  });

  it("should not pass heartbeat target for wakeMode=next-heartbeat main jobs", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "test-next-heartbeat",
      wakeMode: "next-heartbeat",
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron, requestHeartbeatNow } = createCronWithSpies({
      storePath,
      runHeartbeatOnce,
    });

    await runSingleTick(cron);

    // wakeMode=next-heartbeat uses requestHeartbeatNow, not runHeartbeatOnce
    expect(requestHeartbeatNow).toHaveBeenCalled();
    // runHeartbeatOnce should NOT have been called for next-heartbeat mode
    expect(runHeartbeatOnce).not.toHaveBeenCalled();
  });

  it("should pass explicit delivery channel to runHeartbeatOnce", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      ...createMainCronJob({ now, id: "test-explicit-channel", wakeMode: "now" }),
      delivery: {
        mode: "announce",
        channel: "discord" as CronMessageChannel,
        to: "channel:123",
      },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({ storePath, runHeartbeatOnce });
    await runSingleTick(cron);

    expect(runHeartbeatOnce).toHaveBeenCalled();
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    expect(callArgs?.heartbeat?.target).toBe("discord");
    expect(callArgs?.heartbeat?.to).toBe("channel:123");
  });

  it("should pass explicit 'to' with default target when no channel specified", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      ...createMainCronJob({ now, id: "test-explicit-to", wakeMode: "now" }),
      delivery: {
        mode: "announce",
        to: "user456",
      },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({ storePath, runHeartbeatOnce });
    await runSingleTick(cron);

    expect(runHeartbeatOnce).toHaveBeenCalled();
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    expect(callArgs?.heartbeat?.target).toBe("last");
    expect(callArgs?.heartbeat?.to).toBe("user456");
  });

  it("should fall back to default when delivery.mode is 'none'", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      ...createMainCronJob({ now, id: "test-mode-none", wakeMode: "now" }),
      delivery: {
        mode: "none",
        channel: "discord" as CronMessageChannel,
        to: "channel:123",
      },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({ storePath, runHeartbeatOnce });
    await runSingleTick(cron);

    expect(runHeartbeatOnce).toHaveBeenCalled();
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    // mode: "none" should be respected — fall back to default "last"
    expect(callArgs?.heartbeat?.target).toBe("last");
    expect(callArgs?.heartbeat?.to).toBeUndefined();
  });

  it("should fall back to default when delivery.mode is 'webhook'", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job: CronJob = {
      ...createMainCronJob({ now, id: "test-mode-webhook", wakeMode: "now" }),
      delivery: {
        mode: "webhook",
        to: "https://example.com/webhook",
      },
    };

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({ storePath, runHeartbeatOnce });
    await runSingleTick(cron);

    expect(runHeartbeatOnce).toHaveBeenCalled();
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    // webhook URLs should NOT be forwarded as heartbeat targets
    expect(callArgs?.heartbeat?.target).toBe("last");
    expect(callArgs?.heartbeat?.to).toBeUndefined();
  });
});
