import { captureGatewayToolCallerAssertion } from "../agents/tools/gateway-caller-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../infra/sqlite-worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "../infra/sqlite-worker-store.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import {
  matchesTaskFlowCancellationSelection,
  captureTaskFlowCancellationSelection,
  type TaskFlowCancellationRequest,
  type TaskFlowCancellationResult,
  type TaskFlowCancellationSelection,
} from "./task-flow-cancellation.types.js";
import { getTaskFlowRegistryStore } from "./task-flow-registry.store.js";
import {
  ensureTaskFlowRegistryReadyAsync,
  readResidentTaskFlow,
  runTaskFlowRegistryWorkerMutation,
} from "./task-flow-runtime-internal.js";
import { getTaskRegistryStore } from "./task-registry.store.js";

async function cancelFlow(
  params: TaskFlowCancellationRequest & { callerOwnerKey?: string },
  assertInvocation?: () => void,
): Promise<TaskFlowCancellationResult> {
  const expected = params.expectedFlow && {
    ...captureTaskFlowCancellationSelection(params.expectedFlow),
    revision: params.expectedFlow.revision,
  };
  const context = captureOpenClawStateWorkerContext();
  const flowStore = getTaskFlowRegistryStore();
  const taskStore = getTaskRegistryStore();
  const assertCaller = captureGatewayToolCallerAssertion();
  const signal = getAsyncWorkSignal();
  let active = true;
  let selected: TaskFlowCancellationSelection | undefined;
  let intentPublished = false;
  const assertCurrent = () => {
    if (!active) {
      throw new Error("Flow cancellation is no longer active.");
    }
    context.admission.assertCurrent();
    assertCaller?.();
    assertInvocation?.();
    signal?.throwIfAborted();
    if (getTaskFlowRegistryStore() !== flowStore || getTaskRegistryStore() !== taskStore) {
      throw new Error("Flow cancellation owner is no longer current.");
    }
    if (
      intentPublished &&
      selected &&
      !matchesTaskFlowCancellationSelection(readResidentTaskFlow(selected.flowId), selected)
    ) {
      throw new Error("Flow changed while cancellation was in progress.");
    }
  };
  try {
    assertCurrent();
    await ensureTaskFlowRegistryReadyAsync(context);
    assertCurrent();
    const { runOpenClawStateWorkerOperation } =
      await import("../state/openclaw-state-worker-store.js");
    assertCurrent();
    return await runOpenClawStateWorkerOperation(
      context,
      async (scope) => {
        const flow = await scope.execute({
          type: "flows.current",
          input: { flowId: params.flowId.trim() },
        });
        assertCurrent();
        if (
          !flow ||
          (params.callerOwnerKey !== undefined &&
            flow.ownerKey.trim() !== params.callerOwnerKey.trim())
        ) {
          return { found: false, cancelled: false, reason: "Flow not found." };
        }
        if (
          expected &&
          (!matchesTaskFlowCancellationSelection(flow, expected) ||
            flow.revision !== expected.revision)
        ) {
          return {
            found: true,
            cancelled: false,
            reason: "Flow changed while cancellation was in progress.",
            flow,
          };
        }
        const selection = expected ?? captureTaskFlowCancellationSelection(flow);
        selected = selection;
        const mutate = (phase: "request" | "finalize", expectedRevision: number) =>
          runTaskFlowRegistryWorkerMutation(
            { flowId: flow.flowId, admission: context.admission },
            () =>
              scope.execute({
                type: "flows.cancel",
                input: { selected: selection, phase, expectedRevision, now: Date.now() },
              }),
            () => scope.execute({ type: "flows.current", input: { flowId: flow.flowId } }),
          );
        const { dispatch, ...requested } = await mutate("request", flow.revision);
        assertCurrent();
        if (!dispatch) {
          return requested;
        }
        intentPublished = true;
        assertCurrent();
        if (dispatch.length > 0) {
          const { cancelDetachedTaskRunByIdAsync } =
            await import("./task-executor-cancel.async.js");
          assertCurrent();
          for (const task of dispatch) {
            await cancelDetachedTaskRunByIdAsync(
              { cfg: params.cfg, taskId: task.taskId },
              { selectedTask: task, assertCurrent },
            );
            assertCurrent();
          }
        }
        const current = await scope.execute({
          type: "flows.current",
          input: { flowId: flow.flowId },
        });
        assertCurrent();
        if (!current || !matchesTaskFlowCancellationSelection(current, selection)) {
          return {
            found: Boolean(current),
            cancelled: false,
            reason: "Flow changed while cancellation was in progress.",
          };
        }
        const { dispatch: _dispatch, ...result } = await mutate("finalize", current.revision);
        return result;
      },
      {
        assertCurrent,
        requireStateLifecycle: true,
        createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
          context.admission.databasePath,
        ]),
      },
    );
  } catch (error) {
    if (hasSqliteWorkerOutcomeUnknown(error)) {
      throw error;
    }
    return { found: selected !== undefined, cancelled: false, reason: formatErrorMessage(error) };
  } finally {
    active = false;
  }
}

export function cancelFlowById(
  params: TaskFlowCancellationRequest,
): Promise<TaskFlowCancellationResult> {
  return cancelFlow(params);
}

export function cancelFlowByIdForOwner(
  params: TaskFlowCancellationRequest & { callerOwnerKey: string },
  assertInvocation?: () => void,
): Promise<TaskFlowCancellationResult> {
  return cancelFlow(params, assertInvocation);
}
