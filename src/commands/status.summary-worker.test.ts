import { afterEach, expect, it, vi } from "vitest";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { withArtifactPreservingStateReads } from "../state/openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import * as workerStore from "../state/openclaw-state-worker-store.js";
import { getStatusSummary } from "../status/summary.js";
import { getInspectableTaskStatusSummaryReadOnly } from "../tasks/task-registry.maintenance.js";
import { bindTaskRecord, upsertTaskRunRowInDatabase } from "../tasks/task-registry.store.kernel.js";
import type { TaskRecord } from "../tasks/task-registry.types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawStateDatabaseAsync();
});

function task(taskId: string, now: number): TaskRecord {
  return {
    taskId,
    runtime: "cli",
    ownerKey: "agent:main:main",
    requesterSessionKey: "agent:main:main",
    scopeKind: "session",
    task: "Retained payload ".repeat(512),
    detail: { retained: "Private detail ".repeat(512) },
    status: "succeeded",
    deliveryStatus: "not_applicable",
    notifyPolicy: "silent",
    createdAt: now - 60_000,
    endedAt: now - 1_000,
    cleanupAfter: now + 60_000,
  };
}

it("serves full status without reading retained task payloads or checking task integrity on the Gateway thread", async () => {
  await withOpenClawTestState({ layout: "state-only", prefix: "status-task-worker-" }, async () => {
    const database = openOpenClawStateDatabase();
    const now = Date.now();
    runOpenClawStateWriteTransaction(
      (writer) => {
        for (let index = 0; index < 512; index++) {
          upsertTaskRunRowInDatabase(writer, bindTaskRecord(task(`terminal-${index}`, now)));
        }
        upsertTaskRunRowInDatabase(
          writer,
          bindTaskRecord({
            ...task("queued", now),
            status: "queued",
            endedAt: undefined,
            createdAt: now - 15 * 60_000,
          }),
        );
      },
      { database },
    );
    const prepare = vi.spyOn(database.db, "prepare");
    const summary = await getStatusSummary({
      includeSensitive: false,
      includeChannelSummary: false,
      config: { agents: { defaults: { heartbeat: { every: "0m" } } } },
    });
    expect(summary.tasks).toMatchObject({
      total: 513,
      active: 1,
      terminal: 512,
      failures: 0,
      byStatus: { queued: 1, succeeded: 512 },
      byRuntime: { cli: 513 },
    });
    expect(summary.taskAudit).toMatchObject({ total: 1, byCode: { stale_queued: 1 } });
    expect(
      prepare.mock.calls.filter(([statement]) =>
        /task_runs|task_delivery_state|integrity_check/i.test(statement),
      ),
    ).toEqual([]);
    expect(JSON.stringify(summary)).not.toContain("Private detail");
    await closeOpenClawStateDatabaseAsync();
  });
});

it("coalesces overlapping task inspections, separates artifact-preserving reads, and refreshes after settlement", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "status-task-coalesce-" },
    async () => {
      const database = openOpenClawStateDatabase();
      runOpenClawStateWriteTransaction(
        (writer) => {
          upsertTaskRunRowInDatabase(writer, bindTaskRecord(task("first", Date.now())));
        },
        { database },
      );
      const operations = vi.spyOn(workerStore, "runOpenClawStateWorkerOperation");
      const first = getInspectableTaskStatusSummaryReadOnly();
      const second = getInspectableTaskStatusSummaryReadOnly();
      expect(operations).toHaveBeenCalledTimes(1);
      const preserving = withArtifactPreservingStateReads(getInspectableTaskStatusSummaryReadOnly);
      expect(operations).toHaveBeenCalledTimes(2);
      const [left, right, privateRead] = await Promise.all([first, second, preserving]);
      expect(left).toEqual(right);
      expect(privateRead).toEqual(left);
      left.tasks.total = 100;
      expect(right.tasks.total).toBe(1);
      runOpenClawStateWriteTransaction(
        (writer) => {
          upsertTaskRunRowInDatabase(writer, bindTaskRecord(task("second", Date.now())));
        },
        { database },
      );
      expect((await getInspectableTaskStatusSummaryReadOnly()).tasks.total).toBe(2);
      expect(operations).toHaveBeenCalledTimes(3);
      await closeOpenClawStateDatabaseAsync();
    },
  );
});
