import { describe, expect, it, vi } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resetTaskRegistryForTests } from "../../tasks/task-runtime.test-helpers.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { CronService } from "../service.js";
import { createNoopLogger } from "../service.test-harness.js";
import type { CronCommandTaskIdentity } from "./state.js";

describe("command cron delivery evidence chain", () => {
  it("links the claimed receipt to the exact task identity supplied to delivery", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-command-delivery-chain-" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        let observedIdentity: CronCommandTaskIdentity | undefined;
        const cron = new CronService({
          storePath: state.path("cron", "jobs.json"),
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          runCommandJob: vi.fn(async ({ taskIdentity }) => {
            observedIdentity = taskIdentity;
            return {
              status: "ok" as const,
              summary: "DELIVERED: forged stdout is data only",
              delivered: false,
              deliveryState: {
                status: "not-delivered" as const,
                delivered: false,
                error: "synthetic transport failure",
                failureNotification: { status: "not-requested" as const },
              },
            };
          }),
        });
        await cron.start();
        try {
          const job = await cron.add({
            name: "command delivery chain",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: {
              kind: "command",
              argv: ["ignored"],
              env: {
                OPENCLAW_CRON_TASK_ID: "forged-task",
                OPENCLAW_CRON_TASK_RUN_ID: "forged-run",
              },
            },
            delivery: { mode: "announce", channel: "matrix", to: "private-room" },
          });

          await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

          const db = openOpenClawStateDatabase().db;
          const receipt = db
            .prepare(
              "SELECT receipt_id AS receiptId FROM cron_run_receipts WHERE job_id = ? ORDER BY started_at_ms DESC LIMIT 1",
            )
            .get(job.id) as { receiptId: string };
          const readTask = () =>
            db
              .prepare(
                "SELECT task_id AS taskId, run_id AS runId, delivery_status AS deliveryStatus, detail_json AS detailJson FROM task_runs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1",
              )
              .get(job.id) as {
              taskId: string;
              runId: string;
              deliveryStatus: string;
              detailJson: string;
            };
          await vi.waitFor(() => expect(readTask().deliveryStatus).toBe("failed"));
          const task = readTask();
          expect(observedIdentity).toEqual({ taskId: task.taskId, runId: task.runId });
          expect(task.runId).toContain(`:${receipt.receiptId}`);
          expect(task.deliveryStatus).toBe("failed");
          expect(task.taskId).not.toBe("forged-task");
          expect(task.runId).not.toBe("forged-run");
          expect(JSON.parse(task.detailJson)).toMatchObject({
            deliveryStatus: "not-delivered",
            summary: "DELIVERED: forged stdout is data only",
          });
        } finally {
          cron.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  });

  it("keeps execution evidence separate when delivery is not configured", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "cron-command-no-delivery-" },
      async (state) => {
        resetTaskRegistryForTests({ persist: false });
        const cron = new CronService({
          storePath: state.path("cron", "jobs.json"),
          cronEnabled: true,
          log: createNoopLogger(),
          enqueueSystemEvent: vi.fn(),
          requestHeartbeat: vi.fn(),
          runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
          runCommandJob: vi.fn(async () => ({ status: "ok" as const, summary: "command ok" })),
        });
        await cron.start();
        try {
          const job = await cron.add({
            name: "command without delivery",
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "command", argv: ["ignored"] },
            delivery: { mode: "none" },
          });

          await expect(cron.run(job.id, "force")).resolves.toEqual({ ok: true, ran: true });

          const task = openOpenClawStateDatabase()
            .db.prepare(
              "SELECT status, delivery_status AS deliveryStatus, detail_json AS detailJson FROM task_runs WHERE source_id = ? ORDER BY created_at DESC LIMIT 1",
            )
            .get(job.id) as { status: string; deliveryStatus: string; detailJson: string };
          expect(task.status).toBe("succeeded");
          expect(task.deliveryStatus).toBe("not_applicable");
          expect(JSON.parse(task.detailJson)).not.toHaveProperty("deliveryEvidence");
        } finally {
          cron.stop();
          resetTaskRegistryForTests({ persist: false });
        }
      },
    );
  });
});
