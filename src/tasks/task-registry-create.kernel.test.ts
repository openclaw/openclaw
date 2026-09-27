import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../state/openclaw-state-schema.js";
import { createTaskRecordInDatabase } from "./task-registry-create.kernel.js";
import {
  readTaskRecord,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";
import type { TaskRecord } from "./task-registry.types.js";

it.each(["new-run", "existing-run", " "])(
  "selects creation for run %j without decoding other runs in the same child session",
  (runId) => {
    const db = new DatabaseSync(":memory:");
    const historyDetail = { retainedHistory: "Unrelated task result" };
    const record: TaskRecord = {
      taskId: "existing-task",
      runtime: "cli",
      requesterSessionKey: "agent:main:parent",
      ownerKey: "agent:main:parent",
      childSessionKey: "agent:main:child",
      scopeKind: "session",
      agentId: "main",
      runId: "existing-run",
      task: "Requested work",
      status: "running",
      deliveryStatus: "not_applicable",
      notifyPolicy: "silent",
      createdAt: 100,
    };
    try {
      db.exec(OPENCLAW_STATE_SCHEMA_SQL);
      runSqliteImmediateTransactionSync(db, () => {
        upsertTaskWithDeliveryStateInDatabase({ db }, { task: record });
        for (let index = 0; index < 32; index += 1) {
          upsertTaskWithDeliveryStateInDatabase(
            { db },
            {
              task: {
                ...record,
                taskId: `history-${index}`,
                runId: `history-run-${index}`,
                status: "succeeded",
                endedAt: 150,
                detail: historyDetail,
              },
            },
          );
        }
      });
      const serializedHistory = JSON.stringify(historyDetail);
      const parse = vi.spyOn(JSON, "parse");
      let unrelatedDecodes: number;
      let created: ReturnType<typeof createTaskRecordInDatabase>;
      try {
        created = createTaskRecordInDatabase(
          db,
          {
            taskId: "proposed-task",
            now: 200,
            params: { ...record, runId },
          },
          (operation) => runSqliteImmediateTransactionSync(db, operation),
          { onCommitted() {} },
        );
        unrelatedDecodes = parse.mock.calls.filter(([value]) => value === serializedHistory).length;
      } finally {
        parse.mockRestore();
      }
      const reused = runId === record.runId;
      expect(created).toMatchObject({
        mutation: reused ? "reused" : "created",
        task: { taskId: reused ? record.taskId : "proposed-task", task: record.task },
      });
      expect(readTaskRecord(db, record.taskId)).toEqual(record);
      expect(readTaskRecord(db, "history-0")).toMatchObject({
        status: "succeeded",
        detail: historyDetail,
      });
      expect(unrelatedDecodes).toBe(0);
    } finally {
      db.close();
    }
  },
);
