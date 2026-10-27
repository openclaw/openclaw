import assert from "node:assert/strict";
import { expect, it, onTestFinished, vi } from "vitest";
import { presentExecutionDecisionReceiptsInDatabase } from "../audit/execution-decision-receipts.js";
import {
  configureExecutionIdentityAdmissionSink,
  type ExecutionIdentityAdmissionWork,
} from "../audit/execution-identity-admission.js";
import { processExecutionIdentityAdmissionWorkInDatabase } from "../audit/execution-identity-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareCronRunAdmission } from "./run-admission.js";
import { TEST_SCHEDULED_EXECUTION } from "./scheduled-occurrence.test-support.js";
import { cronTestInput } from "./service.fixture-builders.test-support.js";
import { createCronServiceWithStateForTest, createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";

it.each([
  { name: "enabled", cfg: { logging: { audit: { executionIdentity: true } } }, enabled: true },
  { name: "disabled", cfg: { logging: { audit: { executionIdentity: false } } }, enabled: false },
  { name: "default", cfg: {}, enabled: false },
] satisfies { name: string; cfg: OpenClawConfig; enabled: boolean }[])(
  "keeps terminal receipt inspection linked only when collection is $name",
  async ({ cfg, enabled }) => {
    const fixture = await createOpenClawTestState({ label: "cron-execution-identity" });
    let stop = async () => {};
    let clearSink = () => {};
    onTestFinished(async () => {
      await stop();
      clearSink();
      await fixture.cleanup();
    });
    const admissions: ExecutionIdentityAdmissionWork[] = [];
    clearSink = configureExecutionIdentityAdmissionSink((work) => {
      admissions.push(work);
      return true;
    });
    const clock = { now: Date.now() };
    const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async (params) => {
      for (const stage of ["trigger", "payload"]) {
        const admission = prepareCronRunAdmission({
          scheduledExecution: TEST_SCHEDULED_EXECUTION,
          cfg,
          agentId: "main",
          runId: `${stage}-${params.job.id}`,
          sessionKey: `agent:main:cron:${params.job.id}`,
          jobId: params.job.id,
          deliveryAttemptFence: params.deliveryAttemptFence,
          executionIdentity: params.executionIdentity,
        });
        try {
          const first = await admission.preparedRunAdmission.admit("embedded");
          expect(await admission.preparedRunAdmission.admit("plugin-harness")).toBe(first);
        } finally {
          await admission.finish();
        }
      }
      return { status: "ok" };
    });
    const service = createCronServiceWithStateForTest({
      scheduler: createTestGatewayScheduler(),
      storePath: fixture.statePath("cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      nowMs: () => clock.now,
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob,
    });
    const { cron } = service;
    stop = async () => {
      cron.stop();
      await cron.waitForIdle();
    };
    const job = await cron.add(cronTestInput({ delivery: { mode: "none" } }));
    clock.now = job.state.nextRunAtMs!;
    await onTimer(service.state);
    expect((await cron.readJob(job.id))?.state.lastRunStatus).toBe("ok");

    const database = openOpenClawStateDatabase();
    const bindingTable = tableExists(database.db, "execution_owner_lifecycle_bindings");
    expect(bindingTable).toBe(enabled);
    if (!enabled) {
      expect(admissions).toEqual([]);
      return;
    }
    expect(admissions).toHaveLength(2);
    const [context, payloadContext] = admissions.map((work) =>
      processExecutionIdentityAdmissionWorkInDatabase(work, { database }),
    );
    assert(context && payloadContext, "Both admission contexts must be recorded");
    expect(context.contextId).not.toBe(payloadContext.contextId);
    const inspect = (admittedContext: typeof payloadContext) =>
      presentExecutionDecisionReceiptsInDatabase(database.db, {
        schema: { cronRunReceipts: true, executionOwnerLifecycleBindings: bindingTable },
        context: admittedContext,
        decisionLimit: 10,
        now: clock.now,
      }).decisions;
    expect(inspect(payloadContext)).not.toContainEqual(
      expect.objectContaining({ source: expect.objectContaining({ owner: "cron_run_receipts" }) }),
    );
    expect(inspect(context)).toContainEqual(
      expect.objectContaining({
        contextId: context.contextId,
        executionId: context.executionId,
        decision: { outcome: "not-applicable", reasonCode: "cron_run_ok" },
        source: expect.objectContaining({ owner: "cron_run_receipts" }),
      }),
    );
  },
);
