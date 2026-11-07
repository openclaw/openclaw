import "../test-utils/prepare-compiled-subprocesses.js";
import { assert, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  recordConvertedProactiveJobInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import { saveCronJobsStore, saveCronStore } from "../cron/store.js";
import { resolveCronStoreKeyInDatabase } from "../cron/store/paths.js";
import type { CronStoredJob } from "../cron/types.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "../infra/heartbeat-events.js";
import { createWarnLogCapture } from "../logging/test-helpers/warn-log-capture.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  loadCronService,
  resetGatewayCronMocks,
  runCronSessionTurnMock,
} from "./server-cron.test-support.js";

function projectionConfig(agentId = "main"): OpenClawConfig {
  return {
    agents: {
      defaults: { systemAgent: { agentId } },
      entries: { [agentId]: {} },
    },
    session: { mainKey: "main" },
    cron: { enabled: true },
  };
}

function projectionJob(id: string, nowMs: number): CronStoredJob & { agentId: string } {
  return {
    id,
    agentId: "main",
    name: id,
    enabled: true,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: { kind: "every", everyMs: 3_600_000, anchorMs: nowMs },
    sessionTarget: "session:agent:main:main",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: id },
    delivery: { mode: "none" },
    state: { nextRunAtMs: nowMs + 3_600_000 },
  };
}

type ProjectionService = ReturnType<typeof loadCronService>;
function withProjection(
  label: string,
  run: (service: ProjectionService, cfg: OpenClawConfig) => Promise<void>,
  options?: Parameters<typeof loadCronService>[1],
) {
  return withOpenClawTestState({ label }, async () => {
    const cfg = projectionConfig();
    const service = loadCronService(cfg, options);
    assert(typeof service.cron.stopAndDrain === "function");
    try {
      await run(service, cfg);
    } finally {
      await service.cron.stopAndDrain();
      vi.restoreAllMocks();
      resetHeartbeatEventsForTest();
    }
  });
}

const summaryReads = (reads: MockInstance<typeof stateReads.executeExistingOpenClawStateRead>) =>
  reads.mock.calls.filter(([, command]) => command.type === "automationProactive.jobs");

function recordDefaults(
  service: ProjectionService,
  jobs: ReturnType<typeof projectionJob>[],
  atMs = 1,
) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const storeKey = resolveCronStoreKeyInDatabase(db, service.storePath);
    for (const job of jobs) {
      recordDefaultProactiveJobInDatabase(db, storeKey, job.agentId, job.id, atMs);
    }
  });
}

const expectRun = (service: ProjectionService, job: CronStoredJob) =>
  expect(service.cron.run(job.id, "force")).resolves.toMatchObject({ ok: true, ran: true });

describe("Gateway legacy heartbeat projection lifecycle", () => {
  beforeEach(() => {
    resetGatewayCronMocks();
    resetHeartbeatEventsForTest();
    runCronSessionTurnMock.mockReset().mockImplementation(async ({ job }) => ({
      status: "ok",
      summary: job.id,
    }));
  });

  it("reuses successful summaries across reads and follows SDK writes and config changes", async () => {
    await withProjection("cron-health-summary", async (service, cfg) => {
      assert(service.readHeartbeatSummary);
      const primary = projectionJob("health-primary", Date.now());
      const other = { ...projectionJob("health-other", primary.createdAtMs), agentId: "other" };
      await saveCronStore(service.storePath, { version: 1, jobs: [primary, other] });
      recordDefaults(service, [primary, other]);
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
      expect(summaryReads(reads)).toHaveLength(1);

      const otherCfg: OpenClawConfig = { agents: projectionConfig("other").agents };
      expect(await service.readHeartbeatSummary(otherCfg)).toMatchObject([{ id: other.id }]);
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
      expect(summaryReads(reads)).toHaveLength(3);

      primary.enabled = false;
      await saveCronStore(service.storePath, { version: 1, jobs: [primary, other] });
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([
        { id: primary.id, enabled: false },
      ]);
      expect(summaryReads(reads)).toHaveLength(4);
      await saveCronStore(service.storePath, { version: 1, jobs: [] });
      expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
      expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
      expect(summaryReads(reads)).toHaveLength(5);

      service.cron.stop();
      expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
      expect(summaryReads(reads)).toHaveLength(6);
    });
  });

  it("does not retain a summary overtaken by a committed SDK write", async () => {
    await withProjection("cron-health-summary-write", async (service, cfg) => {
      assert(service.readHeartbeatSummary);
      const job = projectionJob("health-overlap", Date.now());
      await saveCronStore(service.storePath, { version: 1, jobs: [job] });
      recordDefaults(service, [job]);
      const execute = stateReads.executeExistingOpenClawStateRead;
      let updated = false;
      const reads = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation(async (...args) => {
          const result = await execute(...args);
          if (!updated && args[1].type === "automationProactive.jobs") {
            updated = true;
            await saveCronStore(service.storePath, {
              version: 1,
              jobs: [{ ...job, enabled: false }],
            });
          }
          return result;
        });
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ enabled: true }]);
      expect(updated).toBe(true);
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ enabled: false }]);
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ enabled: false }]);
      expect(summaryReads(reads)).toHaveLength(2);
    });
  });

  it("broadcasts retained automation status and check freshness after a run", async () => {
    const broadcast = vi.fn();
    await withProjection(
      "cron-result-broadcast",
      async (service) => {
        const job = projectionJob("projection-result", Date.now());
        job.state.lastTriggerEvalAtMs = job.createdAtMs - 1_000;
        runCronSessionTurnMock.mockResolvedValue({
          status: "ok",
          summary: "Waiting for release approval.",
          result: { outcome: "blocked", summary: "Waiting for release approval." },
        });
        await saveCronJobsStore(service.storePath, { version: 1, jobs: [job] });
        await service.cron.start();
        await service.cron.run(job.id, "force");
        const finished = broadcast.mock.calls.find(
          ([event, payload]) => event === "cron" && payload.action === "finished",
        );
        expect(finished?.[1].job).toMatchObject({
          id: job.id,
          state: {
            lastDurationMs: expect.any(Number),
            lastTriggerEvalAtMs: job.state.lastTriggerEvalAtMs,
            lastMeaningfulResult: {
              outcome: "blocked",
              summary: "Waiting for release approval.",
              atMs: expect.any(Number),
            },
          },
        });
      },
      { broadcast },
    );
  });

  it("loads once per start and reopens receipt membership after the same service restarts", async () => {
    await withProjection("cron-projection-restart", async (service, cfg) => {
      assert(service.readHeartbeatSummary);
      assert(typeof service.cron.stopAndDrain === "function");
      const primary = projectionJob("projection-primary", Date.now());
      const converted = projectionJob("projection-converted", primary.createdAtMs);
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      // Both jobs exist before start; only receipt membership changes across restart.
      await saveCronJobsStore(service.storePath, { version: 1, jobs: [primary, converted] });
      recordDefaults(service, [primary], primary.createdAtMs);
      reads.mockClear();
      const projectionReads = () => summaryReads(reads);

      await service.cron.start();
      expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
      expect(projectionReads()).toHaveLength(1);
      await service.cron.start();
      expect(projectionReads()).toHaveLength(1);

      await expectRun(service, primary);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "ok-empty",
        preview: primary.id,
      });
      resetHeartbeatEventsForTest();
      await expectRun(service, converted);
      expect(getLastHeartbeatEvent()).toBeNull();
      expect(projectionReads()).toHaveLength(1);

      await service.cron.stopAndDrain();
      runOpenClawStateWriteTransaction(({ db }) => {
        const storeKey = resolveCronStoreKeyInDatabase(db, service.storePath);
        recordConvertedProactiveJobInDatabase(db, storeKey, "main", converted.id);
      });
      await service.cron.start();
      expect(projectionReads()).toHaveLength(2);
      expect(await service.readHeartbeatSummary(cfg)).toHaveLength(2);
      expect(projectionReads()).toHaveLength(2);
      await expectRun(service, converted);
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "ok-empty",
        preview: converted.id,
      });
      expect(projectionReads()).toHaveLength(2);
    });
  });

  it("reports a projection read failure while keeping cron startup available", async () => {
    await withProjection("cron-projection-failure", async (service, cfg) => {
      const warnings = createWarnLogCapture("cron-projection-failure");
      assert(service.readHeartbeatSummary);
      const execute = stateReads.executeExistingOpenClawStateRead;
      let rejected = false;
      const reads = vi
        .spyOn(stateReads, "executeExistingOpenClawStateRead")
        .mockImplementation((...args) => {
          if (!rejected && args[1].type === "automationProactive.jobs") {
            rejected = true;
            return Promise.reject(new Error("synthetic projection reader failure"));
          }
          return execute(...args);
        });
      try {
        await service.cron.start();
        expect(rejected).toBe(true);
        expect(
          await warnings.findText("Legacy heartbeat diagnostics could not read automation state"),
        ).toBeDefined();
        expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
        expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
        expect(summaryReads(reads)).toHaveLength(2);
      } finally {
        warnings.cleanup();
      }
    });
  });
});
