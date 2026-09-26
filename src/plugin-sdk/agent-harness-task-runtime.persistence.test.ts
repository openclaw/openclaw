import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { identifiedClient, runTaskHandler } from "../gateway/server-methods/tasks.test-helpers.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../plugins/registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createAgentHarnessTaskRuntimeScope } from "../tasks/agent-harness-task-runtime-scope.js";
import { getTaskFlowRegistryStore } from "../tasks/task-flow-registry.store.js";
import {
  getTaskActivitySnapshot,
  recordTaskActivityEvent,
} from "../tasks/task-registry-activity.js";
import { updateTask } from "../tasks/task-registry-mutation.js";
import { getTaskById } from "../tasks/task-registry.js";
import { getTaskRegistryStore } from "../tasks/task-registry.store.js";
import {
  resetTaskRegistryForTests,
  withTaskRegistryTempDir,
} from "../tasks/task-registry.test-support.js";
import { getTaskRunOwner } from "../tasks/task-run-owner.js";
import {
  captureAgentHarnessTaskAssignment,
  createAgentHarnessTaskRuntime,
  createAgentHarnessCommandTask,
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

it.each([
  "cancelled",
  "succeeded",
  "replacement",
  "same-scope replacement",
  "replacement before stop",
  "revoked",
  "incognito",
  "incognito failed",
  "registry retired",
  "caller revoked",
  "requester reassigned",
  "session write revoked",
  "session read revoked after stop",
] as const)("binds command cancellation to its original task outcome (%s)", async (scenario) => {
  await withTaskRegistryTempDir(
    async () => {
      let current = true;
      let stops = 0;
      const agentRegistry = createEmptyPluginRegistry();
      const requestSignal = new AbortController().signal;
      const sessionPolicyCase =
        scenario === "session write revoked" || scenario === "session read revoked after stop";
      const role: GatewayOperatorRoleDefinition = {
        sessions: { others: "write" },
        agents: "*",
        scopes: ["operator.read", "operator.write"],
      };
      const config: OpenClawConfig = sessionPolicyCase
        ? {
            gateway: {
              roles: { default: "task-operator", definitions: { "task-operator": role } },
            },
          }
        : {};
      const requestClient = sessionPolicyCase
        ? identifiedClient(role.scopes, ensureProfileForEmail("viewer@example.com").id)
        : identifiedClient(["operator.admin"]);
      let replacement: ReturnType<typeof updateTask> | undefined;
      const incognito = scenario === "incognito" || scenario === "incognito failed";
      const ownerKey = incognito ? "agent:main:dashboard:incognito-command" : "agent:main:command";
      if (sessionPolicyCase) {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: ownerKey },
          {
            sessionId: "command-session",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: "owner@example.com" },
            visibility: "shared",
          },
        );
      }
      const command = await withPluginRuntimeGenerationScope(
        { metadataSnapshot: createPluginMetadataSnapshotFixture(), pluginRegistry: agentRegistry },
        () =>
          createAgentHarnessCommandTask({
            scope: createAgentHarnessTaskRuntimeScope({ requesterSessionKey: ownerKey }),
            runId: "native-command:original",
            taskKind: "test-native-command",
            command: "SYNTHETIC_TASK_CONTENT",
            startedAt: Date.now(),
            assertCurrent() {
              if (!current) {
                throw new Error("source retired");
              }
            },
            async cancel(_reason, assertTaskCurrent) {
              expect(getPluginRuntimeGatewayRequestScope()?.signal).toBe(requestSignal);
              expect(getPluginRuntimeGatewayRequestScope()?.client).toBe(requestClient);
              if (
                scenario === "caller revoked" ||
                scenario === "requester reassigned" ||
                scenario === "session write revoked"
              ) {
                await Promise.resolve();
                if (scenario === "caller revoked") {
                  requestClient.invalidated = true;
                } else if (scenario === "requester reassigned") {
                  updateTask(command.task.taskId, {
                    requesterSessionKey: "agent:main:another-session",
                  });
                } else {
                  role.sessions = { others: "view" };
                }
                assertTaskCurrent();
              }
              stops += 1;
              if (scenario === "replacement") {
                replacement = updateTask(command.task.taskId, {
                  runId: "native-command:successor",
                  status: "cancelled",
                });
              } else if (scenario === "same-scope replacement") {
                replacement = updateTask(command.task.taskId, { taskKind: "successor-command" });
                assertTaskCurrent();
              } else {
                await command.finish({
                  status:
                    scenario === "succeeded"
                      ? "succeeded"
                      : scenario === "incognito failed"
                        ? "failed"
                        : "cancelled",
                  endedAt: Date.now(),
                  ...(scenario === "incognito failed"
                    ? {
                        terminalSummary: "SYNTHETIC_TASK_CONTENT",
                        error: "SYNTHETIC_TASK_CONTENT",
                      }
                    : {}),
                });
                if (scenario === "session read revoked after stop") {
                  role.sessions = { others: "none" };
                }
              }
            },
          }),
      );
      try {
        if (scenario === "registry retired") {
          markPluginRegistryRetired(agentRegistry);
        }
        if (scenario === "revoked") {
          current = false;
        }
        if (scenario === "replacement before stop") {
          replacement = updateTask(command.task.taskId, { taskKind: "successor-command" });
        }
        const request = withPluginRuntimeGatewayRequestScope(
          {
            pluginRegistry: createEmptyPluginRegistry(),
            client: requestClient,
            signal: requestSignal,
            isWebchatConnect: () => true,
          },
          () =>
            runTaskHandler("tasks.cancel", { taskId: command.task.taskId }, config, requestClient),
        );
        if (scenario === "caller revoked") {
          await expect(request).rejects.toThrow("Gateway requester authority changed");
        } else {
          const result = await request;
          expect(result.payload?.cancelled).toBe(
            scenario === "cancelled" ||
              scenario === "incognito" ||
              scenario === "session read revoked after stop",
          );
          if (scenario === "session read revoked after stop") {
            expect(result.payload).toMatchObject({ found: true, cancelled: true });
            expect(result.payload?.task).toBeUndefined();
          }
        }
        expect(stops).toBe(
          scenario === "revoked" ||
            scenario === "replacement before stop" ||
            scenario === "registry retired" ||
            scenario === "caller revoked" ||
            scenario === "requester reassigned" ||
            scenario === "session write revoked"
            ? 0
            : 1,
        );
        if (incognito) {
          const task = getTaskById(command.task.taskId);
          expect(task).toMatchObject({
            status: scenario === "incognito failed" ? "failed" : "cancelled",
            terminalSummary: scenario === "incognito failed" ? "Command failed" : "Command stopped",
            ...(scenario === "incognito failed" ? { error: "Incognito task error." } : {}),
          });
          expect(JSON.stringify(task)).not.toContain("SYNTHETIC_TASK_CONTENT");
        }
        if (scenario === "replacement") {
          expect(replacement).toMatchObject({
            runId: "native-command:successor",
            status: "cancelled",
          });
          await expect(command.finish({ status: "failed", endedAt: Date.now() })).resolves.toBe(
            "retired",
          );
          expect(getTaskById(command.task.taskId)?.runId).toBe("native-command:successor");
        }
        if (scenario === "same-scope replacement" || scenario === "replacement before stop") {
          expect(replacement).toMatchObject({ taskKind: "successor-command", status: "running" });
          const outcome = await command
            .finish({ status: "failed", endedAt: Date.now() })
            .catch(() => "rejected");
          const successor = expectDefined(getTaskById(command.task.taskId), "replacement task");
          expect(successor).toMatchObject({ taskKind: "successor-command", status: "running" });
          expect(outcome).toBe("retired");
          expect(getTaskRunOwner(successor)).toBeUndefined();
        }
      } finally {
        command.release();
        markPluginRegistryRetired(agentRegistry);
      }
    },
    { durableStore: true },
  );
});
