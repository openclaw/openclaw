import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { prepareCronRunAdmission } from "./run-admission.js";
import type { CronService } from "./service.js";
import { createCronServiceWithStateForTest, createNoopLogger } from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";
import { onTimer } from "./service/timer.test-support.js";

let fixture: OpenClawTestState;
let cron: CronService | undefined;
let clearSink: (() => void) | undefined;

beforeEach(async () => {
  fixture = await createOpenClawTestState({ label: "cron-execution-identity" });
});

afterEach(async () => {
  cron?.stop();
  await cron?.waitForIdle();
  cron = undefined;
  clearSink?.();
  clearSink = undefined;
  await fixture.cleanup();
});

describe("scheduled cron execution identity", () => {
  it.each([
    { name: "enabled", cfg: { logging: { audit: { executionIdentity: true } } }, enabled: true },
    { name: "disabled", cfg: { logging: { audit: { executionIdentity: false } } }, enabled: false },
    { name: "default", cfg: {}, enabled: false },
  ] satisfies { name: string; cfg: OpenClawConfig; enabled: boolean }[])(
    "keeps terminal receipt inspection linked only when collection is $name",
    async ({ cfg, enabled }) => {
      const admissions: ExecutionIdentityAdmissionWork[] = [];
      clearSink = configureExecutionIdentityAdmissionSink((work) => {
        admissions.push(work);
        return true;
      });
      const clock = { now: Date.now() };
      const runIsolatedAgentJob = vi.fn<CronServiceDeps["runIsolatedAgentJob"]>(async (params) => {
        for (const stage of ["trigger", "payload"]) {
          const admission = prepareCronRunAdmission({
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
      cron = service.cron;
      const job = await cron.add({
        name: "identity-linked scheduled run",
        agentId: "main",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "record one scheduled execution" },
        delivery: { mode: "none" },
      });
      clock.now = job.state.nextRunAtMs!;
      await onTimer(service.state);
      expect(runIsolatedAgentJob).toHaveBeenCalledOnce();
      expect((await cron.readJob(job.id))?.state.lastRunStatus).toBe("ok");

      const database = openOpenClawStateDatabase();
      const bindingTable = tableExists(database.db, "execution_owner_lifecycle_bindings");
      expect(bindingTable).toBe(enabled);
      if (!enabled) {
        expect(admissions).toEqual([]);
        return;
      }
      expect(admissions).toHaveLength(2);
      const context = processExecutionIdentityAdmissionWorkInDatabase(admissions[0], { database });
      const payloadContext = processExecutionIdentityAdmissionWorkInDatabase(admissions[1], {
        database,
      });
      expect(context.contextId).not.toBe(payloadContext.contextId);
      expect(
        database.db
          .prepare(
            `SELECT b.context_id, b.execution_id, r.job_id, r.status
             FROM execution_owner_lifecycle_bindings b
             JOIN cron_run_receipts r ON b.owner_kind = 'cron' AND b.owner_id = r.receipt_id`,
          )
          .all(),
      ).toEqual([
        {
          context_id: context.contextId,
          execution_id: context.executionId,
          job_id: job.id,
          status: "ok",
        },
      ]);
      const inspection = presentExecutionDecisionReceiptsInDatabase(database.db, {
        schema: { cronRunReceipts: true, executionOwnerLifecycleBindings: bindingTable },
        context,
        decisionLimit: 10,
        now: clock.now,
      });
      expect(inspection.decisions).toContainEqual(
        expect.objectContaining({
          contextId: context.contextId,
          executionId: context.executionId,
          decision: { outcome: "not-applicable", reasonCode: "cron_run_ok" },
          source: expect.objectContaining({ owner: "cron_run_receipts" }),
        }),
      );
    },
  );
});
