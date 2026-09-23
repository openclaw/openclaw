import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import {
  getTaskActivitySnapshot,
  recordTaskActivityEvent,
} from "../tasks/task-registry-activity.js";
import { getTaskById } from "../tasks/task-registry.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import {
  resetTaskRegistryForTests,
  withTaskRegistryTempDir,
} from "../tasks/task-registry.test-support.js";
import {
  captureAgentHarnessTaskAssignment,
  createAgentHarnessTaskRuntime,
} from "./agent-harness-task-runtime.js";

it.each([false, true])(
  "keeps live task activity separate from durable content (Incognito: %s)",
  async (incognito) => {
    await withTaskRegistryTempDir(
      async () => {
        const requesterSessionKey = incognito
          ? "agent:main:dashboard:incognito-native"
          : "agent:main:main";
        const runtime = createAgentHarnessTaskRuntime({
          runtime: "subagent",
          taskKind: "example-harness",
          scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey }),
        });
        const content = "SYNTHETIC_TASK_CONTENT";
        const runId = "example:child";
        const task = runtime.createRunningTaskRun({
          runId,
          task: content,
          label: content,
          progressSummary: content,
          deliveryStatus: "pending",
          notifyPolicy: "silent",
          detail: { nativeTurnId: "turn-1" },
        });
        const expectedTask = captureAgentHarnessTaskAssignment(task);
        const flowId = expectDefined(task.parentFlowId, "native task flow id");
        recordTaskActivityEvent(task, {
          runId,
          seq: 1,
          ts: Date.now(),
          stream: "assistant",
          data: { text: content },
        });
        expect(getTaskActivitySnapshot(task.taskId)?.lastActivity).toBe(content);

        runtime.recordTaskRunProgressByRunId({
          runId,
          expectedTask,
          progressSummary: content,
          eventSummary: content,
        });
        runtime.finalizeTaskRunByRunId({
          runId,
          expectedTask,
          status: "failed",
          endedAt: Date.now(),
          error: content,
          terminalSummary: content,
        });
        const persisted = expectDefined(
          getTaskRegistryStore().loadSnapshot().tasks.get(task.taskId),
          "persisted native task",
        );
        const flow = expectDefined(
          getTaskFlowRegistryStore().loadSnapshot().flows.get(flowId),
          "persisted native task flow",
        );
        expect(persisted).toMatchObject({
          taskId: task.taskId,
          ownerKey: requesterSessionKey,
          requesterSessionKey,
          runId,
          status: "failed",
          detail: { nativeTurnId: "turn-1" },
        });
        expect(JSON.stringify({ persisted, flow }).includes(content)).toBe(!incognito);
        resetTaskRegistryForTests({ persist: false });
        expect(getTaskById(task.taskId)).toEqual(persisted);
        expect(getTaskActivitySnapshot(task.taskId)).toBeUndefined();
      },
      { durableStore: true },
    );
  },
);
