import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite, writeCronStoreSnapshot } from "./service.test-harness.js";
import type { CronJob } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-main-delivery-override",
});

type RunHeartbeatOnce = NonNullable<
  ConstructorParameters<typeof CronService>[0]["runHeartbeatOnce"]
>;

describe("cron main job delivery override (#34572)", () => {
  function createMainCronJob(params: {
    now: number;
    id: string;
    delivery?: CronJob["delivery"];
  }): CronJob {
    return {
      id: params.id,
      name: params.id,
      enabled: true,
      createdAtMs: params.now - 10_000,
      updatedAtMs: params.now - 10_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "callback result" },
      delivery: params.delivery,
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
    return { cron, enqueueSystemEvent, requestHeartbeatNow };
  }

  async function runSingleTick(cron: CronService) {
    await cron.start();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1_000);
    cron.stop();
  }

  it("uses explicit delivery.channel as heartbeat target", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "explicit-channel",
      delivery: { mode: "none", channel: "discord", to: "channel:123" },
    });

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

  it("uses explicit delivery.accountId in heartbeat override", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "explicit-account",
      delivery: { mode: "none", channel: "telegram", to: "-1001234567890", accountId: "bot2" },
    });

    await writeCronStoreSnapshot({ storePath, jobs: [job] });

    const runHeartbeatOnce = vi.fn<RunHeartbeatOnce>(async () => ({
      status: "ran" as const,
      durationMs: 50,
    }));

    const { cron } = createCronWithSpies({ storePath, runHeartbeatOnce });
    await runSingleTick(cron);

    expect(runHeartbeatOnce).toHaveBeenCalled();
    const callArgs = runHeartbeatOnce.mock.calls[0]?.[0];
    expect(callArgs?.heartbeat?.target).toBe("telegram");
    expect(callArgs?.heartbeat?.to).toBe("-1001234567890");
    expect(callArgs?.heartbeat?.accountId).toBe("bot2");
  });

  it("falls back to target=last when no delivery config", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "no-delivery",
    });

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
  });

  it("falls back to target=last when delivery.channel is 'last'", async () => {
    const { storePath } = await makeStorePath();
    const now = Date.now();

    const job = createMainCronJob({
      now,
      id: "channel-last",
      delivery: { mode: "none", channel: "last" },
    });

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
  });
});
