import { scopePreparedModelRuntimeLease } from "../../agents/prepared-model-runtime-generation-scope.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getGroupThreadTurn } from "../group-thread-context.js";
import { isDispatchReplyOperationAbortedError } from "./dispatch-from-config.abort.js";
import { createInboundMessageAuditTerminal } from "./dispatch-from-config.audit.js";
import { chooseDispatchRoute } from "./dispatch-from-config.choose-route.js";
import { executeDispatch } from "./dispatch-from-config.execute.js";
import { finalizeDispatchAndAudit } from "./dispatch-from-config.finalize.js";
import { gatherDispatchRequest } from "./dispatch-from-config.gather.js";
import { prepareDispatchOperationContext } from "./dispatch-from-config.prepare-context.js";
import { prepareDispatchDelivery } from "./dispatch-from-config.prepare-delivery.js";
import { prepareDispatchExecution } from "./dispatch-from-config.prepare-execution.js";
import { prepareDispatchOperation } from "./dispatch-from-config.prepare-operation.js";
import type {
  DispatchFromConfigParams,
  DispatchFromConfigResult,
} from "./dispatch-from-config.types.js";
import { DispatchSessionRefreshRequiredError } from "./dispatch-session-refresh-error.js";
import { prepareInternalGetReplyOptions } from "./get-reply.types.js";
import { prepareReplySourceInput, retireUnadoptedReplySource } from "./reply-source-binding.js";

export type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";

export async function dispatchReplyFromConfig(
  params: DispatchFromConfigParams,
): Promise<DispatchFromConfigResult> {
  return await dispatchReplyFromConfigWithQueuePolicy(params, false);
}

/** Low-level plugin dispatch must reach queue policy before waiting on the active reply owner. */
export async function dispatchLowLevelChannelReplyFromConfig(
  params: DispatchFromConfigParams,
): Promise<DispatchFromConfigResult> {
  // A group coordinator must retain this turn until execution, not just queue publication.
  return await dispatchReplyFromConfigWithQueuePolicy(params, !getGroupThreadTurn());
}

async function dispatchReplyFromConfigWithQueuePolicy(
  inputParams: DispatchFromConfigParams,
  allowActiveQueueResolution: boolean,
): Promise<DispatchFromConfigResult> {
  const source = await prepareReplySourceInput(
    inputParams.ctx,
    inputParams.cfg,
    prepareInternalGetReplyOptions(inputParams.replyOptions, inputParams.ctx),
  );
  const params = { ...inputParams, replyOptions: source.options };
  const messageAuditTerminal = createInboundMessageAuditTerminal(params);
  let refreshedSessionSnapshot = false;
  try {
    while (true) {
      try {
        const result = await dispatchReplyFromConfigInner(
          params,
          messageAuditTerminal,
          allowActiveQueueResolution,
        );
        messageAuditTerminal?.finishSuccess(result);
        return result;
      } catch (error) {
        if (
          error instanceof DispatchSessionRefreshRequiredError &&
          !refreshedSessionSnapshot &&
          source.input?.retirementRequested !== true &&
          source.input?.claim?.releaseRequested !== true &&
          params.replyOptions?.abortSignal?.aborted !== true
        ) {
          // Rebuild once from the latest store entry. If another lifecycle mutation wins the
          // refreshed admission race, leave the event retryable for the channel ingress owner.
          refreshedSessionSnapshot = true;
          continue;
        }
        messageAuditTerminal?.finishError();
        throw error;
      }
    }
  } finally {
    if (source.created) {
      retireUnadoptedReplySource(source.input);
    }
  }
}

async function dispatchReplyFromConfigInner(
  params: DispatchFromConfigParams,
  messageAuditTerminal: ReturnType<typeof createInboundMessageAuditTerminal>,
  allowActiveQueueResolution: boolean,
): Promise<DispatchFromConfigResult> {
  await using runtimeResources = new AsyncDisposableStack();
  let runtimeLease: ReturnType<typeof scopePreparedModelRuntimeLease> | undefined;
  const gathered = await gatherDispatchRequest(
    params,
    messageAuditTerminal,
    allowActiveQueueResolution,
    (lease) => {
      runtimeLease = runtimeResources.use(scopePreparedModelRuntimeLease(lease));
    },
    (dispose) => runtimeResources.defer(dispose),
  );
  if (gathered.status === "complete") {
    return gathered.result;
  }

  const execute = async () => {
    const delivery = await prepareDispatchDelivery(gathered.state);

    const context = await prepareDispatchOperationContext(delivery);
    if (context.status === "complete") {
      return context.result;
    }

    const errorState = context.state;
    try {
      const operation = await prepareDispatchOperation(context.state);
      if (operation.status === "complete") {
        return operation.result;
      }

      const route = await chooseDispatchRoute(operation.state);
      if (route.status === "complete") {
        return route.result;
      }

      const execution = await prepareDispatchExecution(route.state);

      const executed = await executeDispatch(execution);
      if (executed.status === "complete") {
        return executed.result;
      }

      return await finalizeDispatchAndAudit(executed.state);
    } catch (err) {
      const {
        failDispatchReplyOperation,
        finishReplyOperationAbortedDispatch,
        inboundDedupeClaim,
        markIdle,
        recordAgentDispatchCompleted,
        recordProcessed,
      } = errorState;
      if (isDispatchReplyOperationAbortedError(err)) {
        return finishReplyOperationAbortedDispatch();
      }
      if (inboundDedupeClaim.status === "claimed") {
        if (errorState.turnAdoptionState?.adopted || errorState.inboundDedupeReplayUnsafe) {
          inboundDedupeClaim.commit();
        } else {
          inboundDedupeClaim.release();
        }
      }
      if (err instanceof DispatchSessionRefreshRequiredError) {
        // This attempt already incremented diagnostic queue depth before admission
        // detected the rotated owner. Balance only that state transition; the
        // refreshed attempt owns the single processed/audit terminal outcome.
        markIdle("session_refresh");
      } else {
        recordAgentDispatchCompleted("error", { error: String(err) });
        recordProcessed("error", { error: String(err) });
        markIdle("message_error");
      }
      failDispatchReplyOperation(err);
      throw err;
    }
  };
  const runWithRegistry = () =>
    withPluginRuntimeRegistryScope(gathered.state.pluginRegistry, execute);
  return runtimeLease ? await runtimeLease.run(runWithRegistry) : await runWithRegistry();
}
