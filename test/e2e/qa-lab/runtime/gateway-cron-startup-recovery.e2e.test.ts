import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { createCronRunHandle, finishCronRun } from "../../../../src/cron/service/run-history.js";
import { createCronServiceState } from "../../../../src/cron/service/state.js";
import { saveCronStore } from "../../../../src/cron/store.js";
import type { CronJob } from "../../../../src/cron/types.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { closeOpenClawStateDatabaseForTest } from "../../../../src/state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../../../src/test-utils/gateway-scheduler-clock.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { prepareRecoveryHome, resetGatewayState } from "./gateway-startup-routing.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function cronJob(params: {
  id: string;
  startedAtMs: number;
  enabled?: boolean;
  nextRunAtMs: number;
  recurring?: boolean;
}): CronJob {
  return {
    id: params.id,
    agentId: "main",
    name: params.id,
    enabled: params.enabled ?? true,
    createdAtMs: params.startedAtMs - 1,
    updatedAtMs: params.startedAtMs - 1,
    schedule: params.recurring
      ? { kind: "every", everyMs: 60_000, anchorMs: params.startedAtMs }
      : { kind: "at", at: new Date(params.startedAtMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "Gateway startup recovery proof" },
    state: { runningAtMs: params.startedAtMs, nextRunAtMs: params.nextRunAtMs },
  };
}

describe("Gateway cron startup recovery", () => {
  beforeEach(resetGatewayState);
  afterEach(resetGatewayState);

  it("reports lifecycle-owned retry and disable state through cron.list", async () => {
    const tempHome = tempDirs.make("openclaw-gateway-cron-recovery-");
    const token = `gateway-cron-recovery-${process.pid}`;
    const { stateDir, configPath, workspaceDir, envSnapshot } = await prepareRecoveryHome(
      tempHome,
      token,
    );
    closeOpenClawStateDatabaseForTest();

    const startedAtMs = Date.now() - 30_000;
    const endedAtMs = startedAtMs + 2_000;
    const persistedRetryAtMs = Date.now() + 120_000;
    const historyRetryAtMs = Date.now() + 60_000;
    const jobs = [
      { id: "persisted-retry-without-history", nextRunAtMs: persistedRetryAtMs },
      { id: "persisted-retry", nextRunAtMs: persistedRetryAtMs },
      { id: "history-retry", nextRunAtMs: startedAtMs },
      { id: "persisted-disable", nextRunAtMs: startedAtMs, enabled: false },
      { id: "recurring-history", nextRunAtMs: startedAtMs, recurring: true },
    ].map((job) => cronJob({ startedAtMs, ...job }));
    const storePath = path.join(stateDir, "cron", "jobs.json");
    const executionState = createCronServiceState({
      scheduler: createTestGatewayScheduler(),
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      nowMs: () => endedAtMs,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(),
    });

    for (const job of jobs) {
      const taskRunId = createCronRunHandle({
        state: executionState,
        job,
        startedAt: startedAtMs,
      })?.runId;
      if (!taskRunId) {
        throw new Error(`cron history identity was not created for ${job.id}`);
      }
      await finishCronRun(executionState, {
        taskRunId,
        job,
        event: {
          jobId: job.id,
          action: "finished",
          job,
          status: "error",
          error: 'Session "agent:main:cron:recovery" changed while starting work. Retry.',
          runAtMs: startedAtMs,
          durationMs: endedAtMs - startedAtMs,
          nextRunAtMs: job.id === "persisted-retry-without-history" ? undefined : historyRetryAtMs,
        },
      });
    }
    await saveCronStore(storePath, { version: 1, jobs });

    const config = {
      agents: {
        defaults: { workspace: workspaceDir, skipBootstrap: true },
        entries: { main: {} },
      },
      gateway: { auth: { mode: "token", token } },
      plugins: { slots: { memory: "none" } },
    } satisfies OpenClawConfig;

    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    try {
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath,
        token,
        clientDisplayName: "vitest-gateway-cron-startup-recovery",
      });
      await gateway.server.startupSettled;
      // Cron recovery runs in post-ready maintenance. Observe retirement of
      // every seeded running marker before inspecting its finalized schedule.
      const response = await vi.waitUntil(
        async () => {
          const snapshot = await gateway!.client.request<{
            jobs: Array<{
              id: string;
              enabled: boolean;
              state: { runningAtMs?: number; nextRunAtMs?: number };
            }>;
          }>("cron.list", { includeDisabled: true });
          return jobs.every((seeded) =>
            snapshot.jobs.some(
              (job) => job.id === seeded.id && job.state.runningAtMs === undefined,
            ),
          )
            ? snapshot
            : false;
        },
        { timeout: 30_000 },
      );
      const recovered = new Map(response.jobs.map((job) => [job.id, job] as const));

      for (const [id, nextRunAtMs] of [
        ["persisted-retry-without-history", persistedRetryAtMs],
        ["persisted-retry", persistedRetryAtMs],
        ["history-retry", historyRetryAtMs],
        ["recurring-history", historyRetryAtMs],
      ] as const) {
        expect(recovered.get(id)).toMatchObject({ enabled: true, state: { nextRunAtMs } });
      }
      const disabled = recovered.get("persisted-disable");
      expect({ enabled: disabled?.enabled, nextRunAtMs: disabled?.state.nextRunAtMs }).toEqual({
        enabled: false,
        nextRunAtMs: undefined,
      });
    } finally {
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "Gateway cron startup recovery test complete" });
      }
      closeOpenClawStateDatabaseForTest();
      envSnapshot.restore();
    }
  });
});
