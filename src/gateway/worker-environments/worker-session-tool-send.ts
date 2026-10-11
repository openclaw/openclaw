import type { AgentToolGatewayRequestCaller } from "../../agents/tools/in-process-gateway.js";
import { runWithScopedSessionAccess } from "../../agents/tools/scoped-session-access.js";
import type { PlacedSessionsSendArguments } from "../../agents/tools/sessions-placement-tool-contract.js";
import { createSessionsSendTool } from "../../agents/tools/sessions-send-tool.js";
import { getRuntimeConfig } from "../../config/config.js";
import { sessionDeliveryChannel } from "../../utils/delivery-context.read.js";
import { executeWorkerSessionToolWithReplay } from "./worker-session-tool-result.js";
import {
  resolveWorkerSessionToolTarget as exactAuthorizedTarget,
  type WorkerSessionToolSource as ExactSource,
  type WorkerSessionToolTarget as ExactTarget,
} from "./worker-session-tool-topology.js";

export async function executeWorkerSessionSend(operation: {
  source: ExactSource;
  target: ExactTarget;
  request: PlacedSessionsSendArguments & { toolCallId: string };
  idempotencyKey: string;
  assertSource: () => void;
  callGateway: AgentToolGatewayRequestCaller;
  signal?: AbortSignal;
}) {
  const config = getRuntimeConfig();
  const executeFencedSend = async () => {
    const assertCurrentTarget = async () => {
      const target = await exactAuthorizedTarget({
        source: operation.source,
        requestedSessionKey: operation.request.sessionKey,
      });
      if (
        target.sessionId !== operation.target.sessionId ||
        target.storePath !== operation.target.storePath ||
        target.topologyParent?.sessionKey !== operation.target.topologyParent?.sessionKey ||
        target.topologyParent?.sessionId !== operation.target.topologyParent?.sessionId ||
        target.topologyParent?.storePath !== operation.target.topologyParent?.storePath
      ) {
        throw new Error("Worker sessions_send target incarnation changed");
      }
      operation.assertSource();
    };
    await assertCurrentTarget();
    const tool = createSessionsSendTool({
      agentSessionKey: operation.source.sessionKey,
      agentId: operation.source.agentId,
      agentSessionId: operation.source.sessionId,
      assertSourceCurrent: operation.assertSource,
      agentChannel: sessionDeliveryChannel(operation.source.entry),
      expectedTargetSessionId: operation.target.sessionId,
      expectedTargetStorePath: operation.target.storePath,
      completionOwner: "caller",
      idempotencyKey: operation.idempotencyKey,
      config,
      ...(operation.signal ? { signal: operation.signal } : {}),
      callGateway: async (request) => {
        await assertCurrentTarget();
        return operation.callGateway(request);
      },
    });
    return executeWorkerSessionToolWithReplay(async (replay) => {
      operation.assertSource();
      if (replay) {
        await assertCurrentTarget();
      }
      const { toolCallId, ...args } = operation.request;
      return tool.execute(toolCallId, { ...args, sessionKey: operation.target.sessionKey });
    });
  };
  const topologyParent = operation.target.topologyParent;
  if (!topologyParent) {
    return await executeFencedSend();
  }
  // Sibling authority exists only while the exact shared parent exists. Hold
  // that third incarnation through target admission and the message effect.
  return await runWithScopedSessionAccess({
    cfg: config,
    agentId: topologyParent.agentId,
    storePath: topologyParent.storePath,
    expectedSessionId: topologyParent.sessionId,
    targetSessionKey: topologyParent.sessionKey,
    ...(operation.signal ? { signal: operation.signal } : {}),
    run: executeFencedSend,
  });
}
