/** Main reply dispatch pipeline from finalized config/context to delivery payloads. */
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
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
  DispatchProcessedNote,
} from "./dispatch-from-config.types.js";
import { commitInboundDedupe, releaseInboundDedupe } from "./inbound-dedupe.js";
import "./dispatch-from-config.events.js";

export type { DispatchFromConfigResult } from "./dispatch-from-config.types.js";

/** Dispatches a reply from config, context, command handling, agent run, and delivery policy. */
export async function dispatchReplyFromConfig(
  params: DispatchFromConfigParams,
): Promise<DispatchFromConfigResult> {
  const messageAuditTerminal = createInboundMessageAuditTerminal(params);
  // Every terminal branch records its processed outcome; the result mirrors the
  // last note so consumers can attribute a dispatch that queued no payloads.
  const processedNote: { current?: DispatchProcessedNote } = {};
  try {
    const inner = await dispatchReplyFromConfigInner(params, messageAuditTerminal, processedNote);
    const result = processedNote.current
      ? { ...inner, processedOutcome: processedNote.current }
      : inner;
    messageAuditTerminal?.finishSuccess(result);
    return result;
  } catch (error) {
    messageAuditTerminal?.finishError();
    throw error;
  }
}

async function dispatchReplyFromConfigInner(
  params: DispatchFromConfigParams,
  messageAuditTerminal: ReturnType<typeof createInboundMessageAuditTerminal>,
  processedNote: { current?: DispatchProcessedNote },
): Promise<DispatchFromConfigResult> {
  const gathered = await gatherDispatchRequest(params, messageAuditTerminal, processedNote);
  if (gathered.status === "complete") {
    return gathered.result;
  }

  return await withPluginRuntimeRegistryScope(gathered.state.pluginRegistry, async () => {
    const delivery = await prepareDispatchDelivery(gathered.state);

    const context = await prepareDispatchOperationContext(delivery.state);
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

      const executed = await executeDispatch(execution.state);
      if (executed.status === "complete") {
        return executed.result;
      }

      const finalized = await finalizeDispatchAndAudit(executed.state);
      return finalized.result;
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
        if (errorState.inboundDedupeReplayUnsafe) {
          commitInboundDedupe(inboundDedupeClaim.key);
        } else {
          releaseInboundDedupe(inboundDedupeClaim.key);
        }
      }
      recordAgentDispatchCompleted("error", { error: String(err) });
      recordProcessed("error", { error: String(err) });
      markIdle("message_error");
      failDispatchReplyOperation(err);
      throw err;
    }
  });
}
