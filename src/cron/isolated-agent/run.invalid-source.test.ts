import { describe, expect, it, vi } from "vitest";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { CronOperatorSourceError } from "../operator-source-error.js";
import { readCronOperatorSnapshotForRun } from "../operator-source-snapshot.js";
import { readCronRunHistoryPageForTests } from "../run-history.test-support.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
  writeCronStoreSnapshot,
} from "../service.test-harness.js";
import type { CronServiceDeps } from "../service/state.js";
import { onTimer } from "../service/timer.test-support.js";
import type { CronStoredJob } from "../types.js";
import { makeIsolatedAgentJobFixture, makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import * as h from "./run.test-harness.js";

const runAgent = await h.loadRunCronIsolatedAgentTurn();

describe("undecodable scheduled authority", () => {
  setupRunCronIsolatedAgentTurnSuite();
  const { logger, makeStorePath } = setupCronServiceSuite({
    prefix: "cron-invalid-source-",
    fakeTimers: false,
  });

  it.each([undefined, { version: 1 }, { version: 1, snapshot: null }])(
    "refuses preparation before creating an unsandboxed session or running inference: %j",
    async (source) => {
      const job = makeIsolatedAgentJobFixture({
        operatorSource: { executionRevision: "invalid", source },
      });
      expect(() => readCronOperatorSnapshotForRun(job)).toThrow(CronOperatorSourceError);
      await expect(
        runAgent(
          makeIsolatedAgentParamsFixture({
            job,
          }),
        ),
      ).resolves.toMatchObject({
        status: "error",
        error: expect.stringMatching(
          /operator authority that created this automation was refused.*Restart recovery operator source/,
        ),
        errorClassification: { kind: "permanent" },
        executionStarted: false,
        admissionDisposition: "rejected",
      });
      expect(h.resolveCronSessionMock).not.toHaveBeenCalled();
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(h.runCliAgentMock).not.toHaveBeenCalled();
      expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
    },
  );

  it("disables a recurring job after its first undecodable-authority occurrence", async () => {
    const { storePath } = await makeStorePath();
    const nowMs = Date.now();
    const clock = createGatewaySchedulerClock(nowMs);
    const job: CronStoredJob = makeIsolatedAgentJobFixture({
      enabled: true,
      agentId: "main",
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: nowMs },
      wakeMode: "next-heartbeat",
      delivery: { mode: "none" },
      failureAlert: { after: 1, channel: "telegram", to: "fixture-recipient" },
      state: { nextRunAtMs: nowMs + 60_000 },
      operatorSource: { executionRevision: "invalid", source: { version: 1, snapshot: null } },
    });
    await writeCronStoreSnapshot({ storePath, jobs: [job] });
    const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>((request) =>
      runAgent(
        makeIsolatedAgentParamsFixture({ ...request, sessionKey: `cron:${request.job.id}` }),
      ),
    );
    const enqueueSystemEvent = vi.fn();
    const sendCronFailureAlert = vi.fn<NonNullable<CronServiceDeps["sendCronFailureAlert"]>>(
      async () => {},
    );
    const { cron, state } = createCronServiceWithStateForTest({
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: clock.clock.now,
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      log: logger,
      enqueueSystemEvent,
      sendCronFailureAlert,
      runIsolatedAgentJob,
    });
    try {
      await cron.start();
      clock.setTime(nowMs + 60_001);
      await onTimer(state);
      await cron.waitForIdle();
      expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
      expect(cron.getJob(job.id)).toMatchObject({
        enabled: false,
        state: { lastRunStatus: "error", consecutiveErrors: 1 },
      });
      expect(cron.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
      expect(cron.getJob(job.id)?.state.autoDisabled).toBeUndefined();
      const result = await runIsolatedAgentJob.mock.results[0]?.value;
      expect(result).toMatchObject({
        status: "error",
        error: expect.stringContaining(
          "operator authority that created this automation was refused",
        ),
        errorClassification: { kind: "permanent" },
        executionStarted: false,
        admissionDisposition: "rejected",
      });
      const history = readCronRunHistoryPageForTests({ storeKey: storePath });
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ status: "error", error: result?.error });
      expect(sendCronFailureAlert).toHaveBeenCalledTimes(1);
      expect(sendCronFailureAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "telegram",
          to: "fixture-recipient",
          payload: {
            text: 'Automation "Test Job" failed 1 times\nCheck automation history for details.',
          },
        }),
      );
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
      expect(h.resolveCronSessionMock).not.toHaveBeenCalled();
      expect(h.runEmbeddedAgentMock).not.toHaveBeenCalled();
      expect(h.runCliAgentMock).not.toHaveBeenCalled();
      expect(h.dispatchCronDeliveryMock).not.toHaveBeenCalled();
    } finally {
      cron.stop();
      await cron.waitForIdle();
    }
  });
});
