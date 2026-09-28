import path from "node:path";
import { expect, it, vi } from "vitest";
import { resetConfigRuntimeState } from "../config/config.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearCronJobActive, markCronJobActive, resetCronActiveJobs } from "./active-jobs.js";
import { startCronMaintenance, stopCronMaintenance } from "./maintenance.js";
import { saveCronStore } from "./store.js";
import { maintainCronRunHistory } from "./store/run-history.js";
import { readCronRunRecordsInDatabase } from "./store/run-history.kernel.js";
import { releaseLocalCronRunReceiptOwnership } from "./store/run-receipt-store.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "./store/run-receipt-store.test-support.js";

const DAY = 24 * 60 * 60_000;

function insertHistory(id: string, status = "running", at = 1, runtime = "cron") {
  runOpenClawStateWriteTransaction(({ db }) => {
    db.prepare(
      "INSERT INTO task_runs (task_id, runtime, source_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, last_event_at, status) VALUES (?, ?, ?, '', 'system', 'legacy', 'not_applicable', 'silent', ?, ?, ?)",
    ).run(id, runtime, id, at, at, status);
  });
}

function readHistory() {
  return runOpenClawStateWriteTransaction(({ db }) => readCronRunRecordsInDatabase(db));
}

it("runs Gateway retention with scheduling disabled and reconciles only unowned legacy Cron rows", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-maintenance-disabled-" },
    async (state) => {
      resetConfigRuntimeState();
      resetGatewayWorkAdmission();
      resetCronActiveJobs();
      const now = Date.parse("2026-09-20T12:00:00Z");
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const gatewayScheduler = createTestGatewayScheduler("fake-timers");
      let receipt: ReturnType<typeof claimCronRunReceiptForTest> | undefined;
      try {
        await state.writeConfig({
          cron: { enabled: false },
          agents: { ownership: "explicit", entries: { main: {} } },
        });
        const storePath = state.statePath("cron/jobs.json");
        const job = makeCronReceiptJob("receipt-owned", "main");
        await saveCronStore(storePath, { version: 1, jobs: [job] });
        receipt = claimCronRunReceiptForTest(storePath, job, now - 10 * DAY);
        for (const [id, status] of [
          ["orphan", "running"],
          ["queued", "queued"],
          ["terminal", "succeeded"],
          ["receipt-owned", "running"],
          ["local-owned", "running"],
        ]) {
          insertHistory(id!, status!);
        }
        insertHistory("young", "running", now - 5 * 60_000 + 5_001);
        insertHistory("retired-task", "running", 1, "subagent");
        const local = markCronJobActive("local-owned");
        const sessionStore = path.join(state.sessionsDir("main"), "sessions.json");
        const sessionKey = "agent:main:cron:terminal:run:old";
        await replaceSessionEntry(
          { sessionKey, storePath: sessionStore },
          { sessionId: "old", updatedAt: now - 8 * DAY },
        );
        startCronMaintenance(gatewayScheduler);
        await vi.advanceTimersByTimeAsync(4_999);
        expect(readHistory().find((row) => row.id === "terminal")).toBeDefined();
        await vi.advanceTimersByTimeAsync(1);
        await stopCronMaintenance();
        expect(readHistory().find((row) => row.id === "terminal")).toBeUndefined();
        expect(loadSessionEntry({ sessionKey, storePath: sessionStore })).toBeUndefined();
        for (const id of ["orphan", "queued"]) {
          expect(readHistory().find((row) => row.id === id)).toMatchObject({
            status: "lost",
            endedAt: now + 5_000,
            cleanupAfter: now + 5_000 + DAY,
            error: "backing session missing",
          });
        }
        for (const id of ["receipt-owned", "local-owned", "young"]) {
          expect(readHistory().find((row) => row.id === id)?.status).toBe("running");
        }
        expect(
          runOpenClawStateWriteTransaction(({ db }) =>
            db.prepare("SELECT status FROM task_runs WHERE task_id = 'retired-task'").get(),
          ),
        ).toEqual({ status: "running" });
        clearCronJobActive("local-owned", local);
        releaseLocalCronRunReceiptOwnership(receipt);
        receipt = undefined;
        await maintainCronRunHistory(captureOpenClawStateWorkerContext(), () => {});
        expect(readHistory().find((row) => row.id === "receipt-owned")?.status).toBe("lost");
        expect(readHistory().find((row) => row.id === "local-owned")?.status).toBe("lost");
      } finally {
        await stopCronMaintenance();
        await gatewayScheduler.stop();
        if (receipt) {
          releaseLocalCronRunReceiptOwnership(receipt);
        }
        resetCronActiveJobs();
        resetGatewayWorkAdmission();
        vi.useRealTimers();
        resetConfigRuntimeState();
      }
    },
  );
});

it("rolls back an admitted sweep when backing or caller authority changes before commit", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-maintenance-commit-" },
    async () => {
      resetCronActiveJobs();
      insertHistory("race");
      insertHistory("expired", "succeeded");
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      for (const change of ["backing", "caller"] as const) {
        let current = true;
        const assertion = () => {
          if (!current) {
            throw new Error("sweep retired");
          }
        };
        const spy = vi
          .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              if (request.stage === "commit") {
                if (change === "backing") {
                  markCronJobActive("race");
                } else {
                  current = false;
                }
              }
              admit(request, grant);
            }, attachment),
          );
        try {
          await expect(
            maintainCronRunHistory(captureOpenClawStateWorkerContext(), assertion),
          ).rejects.toThrow(
            change === "backing"
              ? "Cron history backing ownership changed before commit"
              : "sweep retired",
          );
          expect(readHistory().find((row) => row.id === "race")?.status).toBe("running");
          expect(readHistory().find((row) => row.id === "expired")).toBeDefined();
        } finally {
          spy.mockRestore();
          resetCronActiveJobs();
        }
      }
    },
  );
});

it("recovers the first durable duplicate only within its existing Cron partition", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "cron-maintenance-duplicates-" },
    async () => {
      const now = Date.now();
      const endedAt = now - 2 * DAY;
      runOpenClawStateWriteTransaction(({ db }) => {
        const insert = db.prepare(
          "INSERT INTO task_runs (task_id, runtime, source_id, run_id, owner_key, scope_kind, task, delivery_status, notify_policy, created_at, ended_at, last_event_at, status, error, terminal_summary, detail_json) VALUES (?, 'cron', ?, ?, '', 'system', 'legacy', 'not_applicable', 'silent', ?, ?, ?, ?, ?, ?, ?)",
        );
        const row = (
          id: string,
          job: string,
          createdAt: number,
          status: string,
          partition?: string,
          error?: string,
        ) => {
          const terminal = status === "succeeded";
          insert.run(
            id,
            job,
            `run:${job}`,
            createdAt,
            terminal ? endedAt : null,
            terminal ? endedAt : now - 60_000,
            status,
            error ?? null,
            terminal ? "durable outcome" : null,
            JSON.stringify({
              ...(partition === undefined ? {} : { storeKey: partition }),
              ...(terminal ? { kind: "cron-run", status: "ok" } : {}),
            }),
          );
        };
        row("same-terminal", "same", 1, "succeeded", "store-a");
        row("same-queued", "same", 2, "queued", "store-a");
        row("same-lost", "same", 3, "lost", "store-a", " Backing session missing ");
        row("other-error", "same", 4, "lost", "store-a", "unrelated failure");
        row("foreign-active", "same", 5, "running", "store-b");
        row("unscoped-active", "same", 6, "running");
        row("unscoped-terminal", "legacy", 1, "succeeded");
        row("unscoped-queued", "legacy", 2, "queued");
        row("first-active", "ordered", 1, "running", "store-a");
        row("later-terminal", "ordered", 2, "succeeded", "store-a");
        row("live-terminal", "live", 1, "succeeded", "store-a");
        row("live-active", "live", 2, "running", "store-a");
      });
      const marker = markCronJobActive("live");
      try {
        await maintainCronRunHistory(captureOpenClawStateWorkerContext(), () => {});
        const records = readHistory();
        for (const id of ["same-queued", "same-lost", "unscoped-queued"]) {
          expect(records.find((entry) => entry.id === id)).toMatchObject({
            status: "succeeded",
            endedAt,
            summary: "durable outcome",
            error: undefined,
            cleanupAfter: endedAt + 7 * DAY,
            lastEventAt: now - 60_000,
          });
        }
        for (const id of ["foreign-active", "unscoped-active", "first-active", "live-active"]) {
          expect(records.find((entry) => entry.id === id)?.status).toBe("running");
        }
        expect(records.find((entry) => entry.id === "other-error")).toMatchObject({
          status: "lost",
          error: "unrelated failure",
        });
        expect(records.find((entry) => entry.id === "unscoped-queued")?.detail).not.toHaveProperty(
          "storeKey",
        );
      } finally {
        clearCronJobActive("live", marker);
      }
    },
  );
});
