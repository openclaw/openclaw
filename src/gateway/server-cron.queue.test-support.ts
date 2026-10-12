import path from "node:path";
import { expect, it, vi } from "vitest";
import { observeCronJobCommits } from "../../test/helpers/cron/runtime-mutation.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/config.js";
import type { CronServiceState } from "../cron/service/state.js";
import { onTimer as onCronTimer } from "../cron/service/timer.test-support.js";
import { loadCronStore } from "../cron/store.js";
import { cronStoreKey } from "../cron/store/key.js";
import type { CronJobCreate } from "../cron/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import type { buildGatewayCronService } from "./server-cron.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;
type GatewayCronQueueTestHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (
    cfg: OpenClawConfig,
    overrides?: { scheduler?: GatewayScheduler },
  ) => CronFixture;
  withCronService: (
    cfg: OpenClawConfig,
    run: (service: CronFixture) => Promise<void>,
  ) => Promise<void>;
  getCronState: (service: CronFixture) => CronServiceState;
  addAgentTurnJob: (
    service: CronFixture,
    name: string,
    message: string,
    overrides?: Partial<Omit<CronJobCreate, "name" | "payload">>,
  ) => ReturnType<CronFixture["cron"]["add"]>;
  loadConfigMock: { mockReturnValue: (cfg: OpenClawConfig) => unknown };
  runCronIsolatedAgentTurnMock: (params: {
    abortSignal?: AbortSignal;
  }) => Promise<{ status: "ok"; summary: string }>;
  expectIsolatedRunFields: (fields: Record<string, unknown>) => unknown;
};

export function registerGatewayCronQueueTests({
  createCronConfig,
  loadCronService,
  withCronService,
  getCronState,
  addAgentTurnJob,
  loadConfigMock,
  runCronIsolatedAgentTurnMock,
  expectIsolatedRunFields,
}: GatewayCronQueueTestHarness) {
  it("does not resurrect a startup agent missing from the runtime roster", async () => {
    const startupCfg = createCronConfig("server-cron-agent-workspace");
    const tmpDir = path.dirname((startupCfg.cron as { store: string }).store);
    startupCfg.agents = {
      defaults: { workspace: path.join(tmpDir, "workspace") },
      entries: {
        main: {},
        yinze: { workspace: path.join(tmpDir, "workspace-yinze") },
      },
    };
    const reloadedCfg = {
      ...startupCfg,
      agents: { ...startupCfg.agents, entries: { main: {} } },
    } as OpenClawConfig;
    await withCronService(startupCfg, async (state) => {
      const job = await addAgentTurnJob(state, "isolated-subagent-workspace", "read SOW.md", {
        agentId: "yinze",
      });

      loadConfigMock.mockReturnValue(reloadedCfg);
      await expect(state.cron.run(job.id, "force")).resolves.toEqual({
        ok: true,
        ran: false,
        reason: "not-due",
      });
      expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
      const skipped = openOpenClawStateDatabase()
        .db.prepare(
          "SELECT status, error_text FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
        )
        .get(cronStoreKey(getCronState(state).deps.storePath), job.id);
      const skippedJob = await state.cron.readJob(job.id);
      expect(skippedJob?.state.queuedAtMs).toBeUndefined();
      expect(skippedJob?.state.runningAtMs).toBeUndefined();
      expect(skippedJob?.state.runningReceiptId).toBeUndefined();
      expect(skipped).toMatchObject({
        status: "skipped",
        error_text: expect.stringContaining("cron job agent is unavailable: yinze"),
      });
    });
  });

  it("retries a failed scheduled activation using the committed request", async ({ signal }) => {
    vi.useFakeTimers();
    const now = Date.parse("2026-08-13T18:15:00.000Z");
    vi.setSystemTime(now);
    const clock = createGatewaySchedulerClock(now);
    const cfg = createCronConfig("server-cron-activation-write-failure");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    const cronState = getCronState(state);
    try {
      const database = openOpenClawStateDatabase().db;
      try {
        await state.cron.start();
        const job = await addAgentTurnJob(state, "activation-failure", "run it", {
          agentId: "main",
          deleteAfterRun: false,
          delivery: { mode: "none" },
          schedule: { kind: "cron", expr: "* * * * *", staggerMs: 0 },
        });
        const storeKey = cronStoreKey(cronState.deps.storePath);
        const receipts = () =>
          database
            .prepare(
              "SELECT receipt_id, status FROM cron_run_receipts WHERE store_key = ? AND job_id = ? ORDER BY receipt_id",
            )
            .all(storeKey, job.id);
        expect(receipts()).toEqual([]);
        // Real request/activation writes; only this synthetic fault is injected.
        database.exec(`
          CREATE TRIGGER fail_gateway_cron_activation
          AFTER UPDATE OF state_json ON cron_jobs
          WHEN NEW.store_key = '${storeKey.replaceAll("'", "''")}'
            AND NEW.job_id = '${job.id}'
            AND json_extract(OLD.state_json, '$.queuedAtMs') IS NOT NULL
            AND json_extract(NEW.state_json, '$.runningAtMs') IS NOT NULL
          BEGIN
            SELECT RAISE(ABORT, 'injected scheduled activation failure');
          END;
        `);
        vi.setSystemTime(now + 60_000);
        clock.setTime(Date.now());
        // The timer-test entry calls the real scheduler.
        await expect(onCronTimer(cronState)).rejects.toThrow(
          "injected scheduled activation failure",
        );
        const failedReceipts = receipts();
        expect(failedReceipts).toHaveLength(1);
        expect(failedReceipts[0]).toMatchObject({ status: "running" });
        expect(cronState.activeTimerTicks).toBe(0);
        const afterFailure = (await loadCronStore(cronState.deps.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(afterFailure?.state.queuedAtMs).toBe(now + 60_000);
        expect(afterFailure?.state.runningReceiptId).toBeUndefined();
        expect(afterFailure?.state.runningAtMs).toBeUndefined();
        expect(runCronIsolatedAgentTurnMock).not.toHaveBeenCalled();
        database.exec("DROP TRIGGER fail_gateway_cron_activation");

        const completed = createDeferred();
        const stopObserving = observeCronJobCommits(job.id, (runtime) => {
          if (runtime.queuedAtMs === undefined && runtime.runningAtMs === undefined) {
            completed.resolve();
          }
        });
        try {
          vi.setSystemTime(now + 120_000);
          clock.setTime(Date.now());
          await onCronTimer(cronState);
          await withinTest(completed.promise, signal);
        } finally {
          stopObserving();
        }
        expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledOnce();
        expectIsolatedRunFields({ job: expect.objectContaining({ id: job.id }) });
        const afterTick = (await loadCronStore(cronState.deps.storePath)).jobs.find(
          (entry) => entry.id === job.id,
        );
        expect(afterTick?.state).toMatchObject({ lastRunStatus: "ok" });
        expect(afterTick?.state.queuedAtMs).toBeUndefined();
        expect(afterTick?.state.runningAtMs).toBeUndefined();
        expect(receipts()).toEqual([
          expect.objectContaining({ receipt_id: failedReceipts[0]?.receipt_id, status: "ok" }),
        ]);
        expect(cronState.activeTimerTicks).toBe(0);
      } finally {
        database.exec("DROP TRIGGER IF EXISTS fail_gateway_cron_activation");
      }
    } finally {
      state.cron.stop();
      vi.useRealTimers();
    }
  });
}
