import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import {
  assertAgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntimeScope,
} from "./agent-harness-task-runtime-scope.js";
import { backgroundCommandTaskContent } from "./background-command-task-content.js";
import {
  DetachedTaskAssignmentUnsupportedError,
  type DetachedTaskTerminalState,
} from "./detached-task-runtime-contract.js";
import { captureDetachedTaskRuntimeOwner } from "./detached-task-runtime-state.js";
import { prepareRunningTaskRun } from "./detached-task-runtime.js";
import { captureTaskCancellationControl } from "./task-cancellation-context.js";
import { backgroundCommandTaskSummary } from "./task-content.js";
import { getTaskById } from "./task-registry-query.js";
import {
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
} from "./task-registry-records.js";
import type { TaskPersistenceReceipt, TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";
import type { TaskRunOwnerBinding } from "./task-run-owner.types.js";

/** Bind a harness-owned command to the existing ledger without taking over its process. */
export async function createAgentHarnessCommandTask(params: {
  scope: AgentHarnessTaskRuntimeScope;
  runId: string;
  taskKind: string;
  command: string;
  agentId?: string;
  startedAt: number;
  assertCurrent: () => void;
  /** Recheck current task authority after awaits and immediately before stopping native work. */
  cancel: (reason: string, assertTaskCurrent: () => void) => Promise<void>;
}) {
  const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
  const registry = requireActivePluginRegistry();
  const runtime = captureDetachedTaskRuntimeOwner();
  // Legacy custom runtimes cannot bind a receipt-owned cancellation capability.
  if (runtime.runtime) {
    throw new DetachedTaskAssignmentUnsupportedError();
  }
  const assertCurrent = () => {
    runtime.assertCurrent();
    params.assertCurrent();
  };
  assertCurrent();
  const incognito = isIncognitoSessionKey(scope.requesterSessionKey);
  const prepared = prepareRunningTaskRun(
    {
      runtime: "cli",
      taskKind: params.taskKind,
      requesterSessionKey: scope.requesterSessionKey,
      ownerKey: scope.requesterSessionKey,
      scopeKind: "session",
      agentId: params.agentId,
      requesterAgentId: params.agentId,
      runId: params.runId,
      ...backgroundCommandTaskContent(incognito ? "Incognito task" : params.command),
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      startedAt: params.startedAt,
      lastEventAt: params.startedAt,
    },
    assertCurrent,
  );
  if (prepared.kind !== "receipt") {
    throw new DetachedTaskAssignmentUnsupportedError();
  }
  const receipt = await prepared.create();
  if (!receipt) {
    throw new Error("Native command task persistence failed");
  }
  let binding: TaskRunOwnerBinding | undefined;
  let expectedTask: TaskPersistenceReceipt | undefined;
  let settlement: Promise<"published" | "retired"> | undefined;
  const originalTask = () => {
    const current = getTaskById(receipt.task.taskId);
    if (
      !expectedTask ||
      !current ||
      !matchesTaskPersistenceReceipt(current, expectedTask) ||
      !binding ||
      getTaskRunOwner(current) !== binding.owner
    ) {
      binding?.release();
      return undefined;
    }
    return current;
  };
  const finish = (terminal: DetachedTaskTerminalState) =>
    (settlement ??= (async (): Promise<"published" | "retired"> => {
      if (!originalTask()) {
        return "retired";
      }
      await receipt.finalizeActive(
        {
          ...terminal,
          ...(incognito
            ? {
                terminalSummary: backgroundCommandTaskSummary(terminal.status),
                ...(terminal.error ? { error: "Incognito task error." } : {}),
              }
            : {}),
        },
        (task) =>
          Boolean(
            expectedTask &&
            matchesTaskPersistenceReceipt(task, expectedTask) &&
            binding &&
            getTaskRunOwner(task) === binding.owner,
          ),
      );
      const current = originalTask();
      if (!current) {
        return "retired";
      }
      if (current.status !== terminal.status) {
        throw new Error(
          "Native command terminal publication did not settle for its original task.",
        );
      }
      binding?.release();
      return "published";
    })().catch((error: unknown) => {
      settlement = undefined;
      throw error;
    }));
  try {
    binding = await receipt.bindRunOwner(
      (reason) =>
        // Keep the admitting registry without reviving its old Gateway request authority.
        withPluginRuntimeRegistryScope(registry, async (): Promise<Result<TaskRecord, string>> => {
          try {
            const control = captureTaskCancellationControl();
            const assertTaskCurrent = () => {
              assertCurrent();
              if (!originalTask()) {
                throw new Error("Native command no longer belongs to its original task.");
              }
              control?.assertCurrent();
            };
            assertTaskCurrent();
            await params.cancel(reason, assertTaskCurrent);
            const current = getTaskById(receipt.task.taskId);
            return expectedTask &&
              current &&
              matchesTaskPersistenceReceipt(current, expectedTask) &&
              current.status === "cancelled"
              ? ok(current)
              : err("Native command did not settle as cancelled.");
          } catch {
            return err("Native command could not be cancelled by its current owner.");
          }
        }),
      assertCurrent,
    );
    const current = getTaskById(receipt.task.taskId);
    if (!current || getTaskRunOwner(current) !== binding.owner) {
      throw new Error("Native command task owner was replaced during admission.");
    }
    expectedTask = captureTaskPersistenceReceipt(current);
    return { task: receipt.task, finish, release: () => binding?.release() };
  } catch (error) {
    binding?.release();
    await receipt.settleUnstarted(
      {
        status: "failed",
        endedAt: Date.now(),
        error: "Native command task admission ended.",
      },
      (task) => !getTaskRunOwner(task),
    );
    throw error;
  }
}
