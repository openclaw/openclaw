import { agentCommandFromIngress } from "../commands/agent.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { pairingChangedResult } from "./server-node-event-source.js";
import type {
  NodeEventContext,
  NodeEventHandlerOptions,
  NodeEventHandleResult,
} from "./server-node-events-types.js";
import { formatForLog } from "./ws-log.js";

/** Retain accepted work independently, but publish admission only after the final connection check. */
export async function admitNodeAgentRequest(params: {
  ctx: Pick<NodeEventContext, "deps" | "logGateway">;
  nodeId: string;
  input: Parameters<typeof agentCommandFromIngress>[0];
  isConnectionCurrent?: NodeEventHandlerOptions["isConnectionCurrent"];
  pending?: Promise<unknown>[];
  onRejected: () => Promise<void>;
}): Promise<NodeEventHandleResult> {
  const admission = createDeferredCore<boolean>();
  // A live parent synchronously reserves a root even across suspension/restart fences.
  const work = runWithGatewayIndependentRootWorkContinuation(async () => {
    if (params.isConnectionCurrent && !(await params.isConnectionCurrent())) {
      admission.resolve(false);
      await params.onRejected();
      return;
    }
    const agentWork = agentCommandFromIngress(params.input, defaultRuntime, params.ctx.deps);
    admission.resolve(true);
    await agentWork;
  }, "node-events:agent-turn").catch((err: unknown) => {
    admission.reject(err);
    params.ctx.logGateway.warn(`agent failed node=${params.nodeId}: ${formatForLog(err)}`);
  });
  params.pending?.push(work);
  // This receipt confirms dispatch, not completion of the agent run.
  return (await admission.promise)
    ? { ok: true, event: "agent.request", handled: true, reason: "accepted" }
    : pairingChangedResult("agent.request");
}
