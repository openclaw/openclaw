import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createTaskRecord } from "./task-registry.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { resetTaskRegistryForTests } from "./task-registry.test-support.js";

it("commits a missing requester origin before native creation updates existing metadata", async () => {
  await withOpenClawTestState({ layout: "state-only", prefix: "task-create-commit-" }, async () => {
    resetTaskRegistryForTests({ persist: false });
    try {
      const params = {
        runtime: "acp" as const,
        ownerKey: "agent:main:main",
        scopeKind: "session" as const,
        childSessionKey: "agent:codex:acp:origin-commit",
        runId: "run-origin-commit",
        task: "Original task",
        status: "running" as const,
        deliveryStatus: "pending" as const,
      };
      const first = createTaskRecord(params);
      assert(first);
      const requesterOrigin = { channel: "telegram", to: "synthetic-recipient" };
      const database = openOpenClawStateDatabase();
      const reader = new (requireNodeSqlite().DatabaseSync)(database.path, { readOnly: true });
      const store = getTaskRegistryStore();
      const upsert = store.upsertTaskWithDeliveryState;
      const observedOrigins: unknown[] = [];
      const write = vi.spyOn(store, "upsertTaskWithDeliveryState").mockImplementation((input) => {
        const row = reader
          .prepare("SELECT requester_origin_json FROM task_delivery_state WHERE task_id = ?")
          .get(first.taskId);
        observedOrigins.push(JSON.parse(String(row?.requester_origin_json ?? "null")));
        upsert(input);
      });
      try {
        expect(
          createTaskRecord({
            ...params,
            task: "Updated task",
            requesterOrigin,
            preferMetadata: true,
          }),
        ).toMatchObject({ taskId: first.taskId, task: "Updated task" });
        expect(observedOrigins).toEqual([requesterOrigin]);
      } finally {
        write.mockRestore();
        reader.close();
      }
    } finally {
      resetTaskRegistryForTests({ persist: false });
    }
  });
});
