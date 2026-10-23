import "../test-utils/prepare-compiled-subprocesses.js";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  recordConvertedProactiveJobInDatabase,
  recordDefaultProactiveJobInDatabase,
} from "../cron/proactive-job-receipt.js";
import { saveCronJobsStore } from "../cron/store.js";
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

  it("loads once per start and reopens receipt membership after the same service restarts", async () => {
    await withOpenClawTestState({ label: "cron-projection-restart" }, async () => {
      const service = loadCronService(projectionConfig());
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
      const service = loadCronService(projectionConfig());
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
      } finally {
        await service.cron.stopAndDrain();
        reads.mockRestore();
        warnings.cleanup();
        resetHeartbeatEventsForTest();
      }
    });
  });
});
