import { expect, it } from "vitest";
import { updateTask } from "./task-registry-mutation.js";
import {
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
} from "./task-registry-records.js";
import { getTaskById, publishTaskRecordAfterAtomicStore } from "./task-registry.js";
import { configureTaskRegistryRuntime, getTaskRegistryStore } from "./task-registry.store.js";
import { upsertTaskWithDeliveryStateToSqlite } from "./task-registry.store.sqlite.js";
import { createTaskFixture, withTaskRegistryTempDir } from "./task-registry.test-support.js";
import type { TaskRecord } from "./task-registry.types.js";

it("persists and publishes the same canonical task identifiers on creation and replacement", async () => {
  await withTaskRegistryTempDir(
    async () => {
      const published: Array<Omit<TaskRecord, "detail">> = [];
      configureTaskRegistryRuntime({
        observers: {
          onEvent(event) {
            if (event.kind === "upserted") {
              published.push(event.task);
            }
          },
        },
      });
      const created = createTaskFixture("cli", {
        task: "Canonical task identifiers",
        runId: " \trun-created\n",
        childSessionKey: "\u00a0agent:main:child-created\u00a0",
        notifyPolicy: "silent",
      });
      expect(created).toMatchObject({
        runId: "run-created",
        childSessionKey: "agent:main:child-created",
      });
      const assertPublished = (record: TaskRecord) => {
        const stored = getTaskRegistryStore().loadSnapshot().tasks.get(record.taskId);
        expect(stored).toEqual(record);
        expect(getTaskById(record.taskId)).toEqual(record);
        expect(published.at(-1)).toEqual(record);
        expect(stored).toBeDefined();
        expect(matchesTaskPersistenceReceipt(stored!, captureTaskPersistenceReceipt(record))).toBe(
          true,
        );
      };
      assertPublished(created);

      const updated = updateTask(created.taskId, {
        runId: "\u00a0run-replaced\u00a0",
        childSessionKey: " \tagent:main:child-replaced\n",
      });
      expect(updated).toMatchObject({
        runId: "run-replaced",
        childSessionKey: "agent:main:child-replaced",
      });
      assertPublished(updated!);
      expect(published).toHaveLength(2);
    },
    { durableStore: true },
  );
});

it.each([undefined, " \t\n"])(
  "clears explicitly supplied empty identifiers (%j)",
  async (empty) => {
    await withTaskRegistryTempDir(
      async () => {
        const task = createTaskFixture("cli", {
          task: "Clear optional identifiers",
          runId: "run-created",
          childSessionKey: "agent:main:child-created",
          notifyPolicy: "silent",
        });
        const updated = updateTask(task.taskId, { runId: empty, childSessionKey: empty });
        expect(updated).not.toBeNull();
        expect(updated?.runId).toBeUndefined();
        expect(updated?.childSessionKey).toBeUndefined();
        expect(getTaskRegistryStore().loadSnapshot().tasks.get(task.taskId)).toEqual(updated);
        expect(getTaskById(task.taskId)).toEqual(updated);
      },
      { durableStore: true },
    );
  },
);

it("leaves historical identifiers to Doctor when a patch only changes progress", async () => {
  await withTaskRegistryTempDir(
    async () => {
      const created = createTaskFixture("cli", {
        task: "Legacy task awaiting Doctor",
        notifyPolicy: "silent",
      });
      const legacy = {
        ...created,
        runId: " padded-run ",
        childSessionKey: " agent:main:padded-child ",
      };
      upsertTaskWithDeliveryStateToSqlite({ task: legacy });
      publishTaskRecordAfterAtomicStore(legacy);
      const updated = updateTask(created.taskId, { progressSummary: "New progress" });
      expect(updated).toEqual({ ...legacy, progressSummary: "New progress" });
      expect(getTaskRegistryStore().loadSnapshot().tasks.get(created.taskId)).toEqual(updated);
    },
    { durableStore: true },
  );
});
