import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRuntimeFactsContext } from "../agents/runtime-facts-prompt.js";
import { updateTask } from "./task-registry-mutation.js";
import { listFreshTasksForOwnerKey } from "./task-registry-query.js";
import { prepareTaskRegistryRead } from "./task-registry-read.js";
import { resetReadState, withReadState } from "./task-registry-read.test-support.js";
import { invalidateTaskRegistryProjection } from "./task-registry-state.js";
import { getTaskRegistryStore } from "./task-registry.store.js";
import { createTaskFixture } from "./task-registry.test-support.js";

afterEach(resetReadState);

describe("canonical task owner reads", () => {
  it.each(["owner lookup", "media prompt"] as const)(
    "reads canonical owner facts despite unrelated projection churn for %s",
    async (surface) => {
      await withReadState(async () => {
        const task = createTaskFixture("cli", {
          runId: "canonical-owner-read",
          task: "Generate video",
          taskKind: "video_generation",
          sourceId: "video_generate:test",
          agentId: "main",
          notifyPolicy: "silent",
        });
        const unrelated = createTaskFixture("cli", {
          runId: "unrelated-owner-read",
          ownerKey: "agent:main:other",
          task: "Unrelated work",
          notifyPolicy: "silent",
        });
        await prepareTaskRegistryRead();
        const store = getTaskRegistryStore();
        const loadSnapshot = store.loadMutationSnapshotAsync.bind(store);
        let updates = 0;
        vi.spyOn(store, "loadMutationSnapshotAsync").mockImplementation(async (...args) => {
          const snapshot = await loadSnapshot(...args);
          expect(
            updateTask(unrelated.taskId, { task: `Unrelated update ${++updates}` }),
          ).not.toBeNull();
          invalidateTaskRegistryProjection();
          return snapshot;
        });
        invalidateTaskRegistryProjection();

        if (surface === "owner lookup") {
          expect(await listFreshTasksForOwnerKey(task.ownerKey)).toMatchObject([
            { taskId: task.taskId, status: "running", sourceId: "video_generate:test" },
          ]);
        } else {
          expect(
            await buildRuntimeFactsContext({
              capabilityToolNames: new Set(["video_generate"]),
              cfg: {},
              sessionKey: task.ownerKey,
              agentId: "main",
            }),
          ).toEqual([
            {
              kind: "conversation-data",
              text: `## Media Generation Tasks\n- tool=video_generate; task=${task.taskId}; status=running; provider_json="test"`,
            },
          ]);
        }
      });
    },
  );
});
