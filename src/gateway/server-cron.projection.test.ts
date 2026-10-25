import "../test-utils/prepare-compiled-subprocesses.js";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  recordConvertedProactiveJobInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import { saveCronJobsStore, saveCronStore } from "../cron/store.js";
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

function projectionConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: {} },
    },
    session: { mainKey: "main" },
    cron: { enabled: true },
  };
}

function projectionJob(id: string, nowMs: number): CronStoredJob {
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
    await withOpenClawTestState({ label: "cron-health-summary" }, async () => {
      const cfg = projectionConfig();
      const service = loadCronService(cfg);
      assert(service.readHeartbeatSummary);
      const primary = projectionJob("health-primary", Date.now());
      const other = { ...projectionJob("health-other", primary.createdAtMs), agentId: "other" };
      await saveCronStore(service.storePath, { version: 1, jobs: [primary, other] });
      runOpenClawStateWriteTransaction(({ db }) => {
        recordDefaultProactiveJobInDatabase(db, service.storePath, "main", primary.id, 1);
        recordDefaultProactiveJobInDatabase(db, service.storePath, "other", other.id, 1);
      });
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      const summaryReads = () =>
        reads.mock.calls.filter(([, command]) => command.type === "automationProactive.jobs");
      try {
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
        expect(summaryReads()).toHaveLength(1);

        const otherCfg: OpenClawConfig = {
          agents: {
            defaults: { systemAgent: { agentId: "other" } },
            entries: { other: {} },
          },
        };
        expect(await service.readHeartbeatSummary(otherCfg)).toMatchObject([{ id: other.id }]);
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
        expect(summaryReads()).toHaveLength(3);

        primary.enabled = false;
        await saveCronStore(service.storePath, { version: 1, jobs: [primary, other] });
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([
          { id: primary.id, enabled: false },
        ]);
        expect(summaryReads()).toHaveLength(4);
        await saveCronStore(service.storePath, { version: 1, jobs: [] });
        expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
        expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
        expect(summaryReads()).toHaveLength(5);

        service.cron.stop();
        expect(await service.readHeartbeatSummary(cfg)).toEqual([]);
        expect(summaryReads()).toHaveLength(6);
      } finally {
        await service.cron.stopAndDrain?.();
        reads.mockRestore();
      }
    });
  });

  it("does not retain a summary overtaken by a committed SDK write", async () => {
    await withOpenClawTestState({ label: "cron-health-summary-write" }, async () => {
      const cfg = projectionConfig();
      const service = loadCronService(cfg);
      assert(service.readHeartbeatSummary);
      const job = projectionJob("health-overlap", Date.now());
      await saveCronStore(service.storePath, { version: 1, jobs: [job] });
      runOpenClawStateWriteTransaction(({ db }) => {
        recordDefaultProactiveJobInDatabase(db, service.storePath, "main", job.id, 1);
      });
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
      try {
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ enabled: true }]);
        expect(updated).toBe(true);
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ enabled: false }]);
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ enabled: false }]);
        expect(
          reads.mock.calls.filter(([, command]) => command.type === "automationProactive.jobs"),
        ).toHaveLength(2);
      } finally {
        await service.cron.stopAndDrain?.();
        reads.mockRestore();
      }
    });
  });

  it("broadcasts retained automation status and check freshness after a run", async () => {
    await withOpenClawTestState({ label: "cron-result-broadcast" }, async () => {
      const broadcast = vi.fn();
      const service = loadCronService(projectionConfig(), { broadcast });
      assert(typeof service.cron.stopAndDrain === "function");
      const job = projectionJob("projection-result", Date.now());
      job.state.lastTriggerEvalAtMs = job.createdAtMs - 1_000;
      runCronSessionTurnMock.mockResolvedValue({
        status: "ok",
        summary: "Waiting for release approval.",
        result: { outcome: "blocked", summary: "Waiting for release approval." },
      });
      try {
        await saveCronJobsStore(service.storePath, { version: 1, jobs: [job] });
        await service.cron.start();
        await service.cron.run(job.id, "force");
        expect(broadcast).toHaveBeenCalledWith(
          "cron",
          expect.objectContaining({
            action: "finished",
            job: expect.objectContaining({
              id: job.id,
              state: expect.objectContaining({
                lastDurationMs: expect.any(Number),
                lastTriggerEvalAtMs: job.state.lastTriggerEvalAtMs,
                lastMeaningfulResult: {
                  outcome: "blocked",
                  summary: "Waiting for release approval.",
                  atMs: expect.any(Number),
                },
              }),
            }),
          }),
          expect.anything(),
        );
      } finally {
        await service.cron.stopAndDrain();
      }
    });
  });

  it("loads once per start and reopens receipt membership after the same service restarts", async () => {
    await withOpenClawTestState({ label: "cron-projection-restart" }, async () => {
      const cfg = projectionConfig();
      const service = loadCronService(cfg);
      assert(service.readHeartbeatSummary);
      assert(typeof service.cron.stopAndDrain === "function");
      const primary = projectionJob("projection-primary", Date.now());
      const converted = projectionJob("projection-converted", primary.createdAtMs);
      const reads = vi.spyOn(stateReads, "executeExistingOpenClawStateRead");
      try {
        // Both jobs exist before start; only receipt membership changes across restart.
        await saveCronJobsStore(service.storePath, { version: 1, jobs: [primary, converted] });
        runOpenClawStateWriteTransaction(({ db }) => {
          recordDefaultProactiveJobInDatabase(
            db,
            service.storePath,
            "main",
            primary.id,
            primary.createdAtMs,
          );
        });
        reads.mockClear();
        const projectionReads = () =>
          reads.mock.calls.filter(([, command]) => command.type === "automationProactive.jobs");

        await service.cron.start();
        expect(await service.readHeartbeatSummary(cfg)).toMatchObject([{ id: primary.id }]);
        expect(projectionReads()).toHaveLength(1);
        await service.cron.start();
        expect(projectionReads()).toHaveLength(1);

        await expect(service.cron.run(primary.id, "force")).resolves.toMatchObject({
          ok: true,
          ran: true,
        });
        expect(getLastHeartbeatEvent()).toMatchObject({
          status: "ok-empty",
          preview: primary.id,
        });
        resetHeartbeatEventsForTest();
        await expect(service.cron.run(converted.id, "force")).resolves.toMatchObject({
          ok: true,
          ran: true,
        });
        expect(getLastHeartbeatEvent()).toBeNull();
        expect(projectionReads()).toHaveLength(1);

        await service.cron.stopAndDrain();
        runOpenClawStateWriteTransaction(({ db }) => {
          recordConvertedProactiveJobInDatabase(db, service.storePath, "main", converted.id);
        });
        await service.cron.start();
        expect(projectionReads()).toHaveLength(2);
        expect(await service.readHeartbeatSummary(cfg)).toHaveLength(2);
        expect(projectionReads()).toHaveLength(2);
        await expect(service.cron.run(converted.id, "force")).resolves.toMatchObject({
          ok: true,
          ran: true,
        });
        expect(getLastHeartbeatEvent()).toMatchObject({
          status: "ok-empty",
          preview: converted.id,
        });
        expect(projectionReads()).toHaveLength(2);
      } finally {
        await service.cron.stopAndDrain();
        reads.mockRestore();
        resetHeartbeatEventsForTest();
      }
    });
  });

  it("reports a projection read failure while keeping cron startup available", async () => {
    await withOpenClawTestState({ label: "cron-projection-failure" }, async () => {
      const warnings = createWarnLogCapture("cron-projection-failure");
      const cfg = projectionConfig();
      const service = loadCronService(cfg);
      assert(service.readHeartbeatSummary);
      assert(typeof service.cron.stopAndDrain === "function");
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
        expect(
          reads.mock.calls.filter(([, command]) => command.type === "automationProactive.jobs"),
        ).toHaveLength(2);
      } finally {
        await service.cron.stopAndDrain();
        reads.mockRestore();
        warnings.cleanup();
        resetHeartbeatEventsForTest();
      }
    });
  });
});
