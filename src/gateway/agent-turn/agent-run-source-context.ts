import {
  attachAgentCommandAdmissionFacts,
  attachAgentCommandRecoveryAdmissionFacts,
} from "../../agents/agent-command-admission-facts.js";
import {
  resolveReplySourceTurnId,
  setChannelSourceTurnId,
  setChannelSourceTurnSameThreadRequired,
} from "../../auto-reply/reply/source-turn-id.js";
import { getGatewayLocalUserIngress } from "../local-user-ingress.js";
import type { resolveAgentRestartRecoveryContext } from "./agent-restart-recovery-context.js";
import type { StartAgentRunExecutionParams } from "./agent-run-execution-types.js";

/** Preserve source-turn routing and admission facts at the Gateway dispatch boundary. */
export function buildAgentRunSourceContext(
  params: StartAgentRunExecutionParams,
  restartRecoveryContext: ReturnType<typeof resolveAgentRestartRecoveryContext>,
) {
  const { prepared } = params;
  const restartRecoveryChannelContext = restartRecoveryContext?.channel;
  const runContext = {
    messageChannel: restartRecoveryContext?.messageChannel ?? params.delivery.originMessageChannel,
    accountId:
      restartRecoveryChannelContext?.requesterAccountId ?? params.delivery.resolvedAccountId,
    senderId: restartRecoveryChannelContext?.requesterSenderId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    currentChannelId: restartRecoveryChannelContext?.currentChannelId,
    currentThreadTs:
      restartRecoveryChannelContext?.currentThreadTs ??
      (prepared.resolvedThreadId != null ? String(prepared.resolvedThreadId) : undefined),
  };
  setChannelSourceTurnId(
    runContext,
    resolveReplySourceTurnId({
      sourceTurnId: restartRecoveryChannelContext?.sourceTurnId,
      admissionRunId: params.runId,
      ingressProvider: runContext.messageChannel,
      entry: params.sessionEntry,
    }),
  );
  setChannelSourceTurnSameThreadRequired(
    runContext,
    restartRecoveryChannelContext?.sameChannelThreadRequired,
  );

  const localUserIngress = getGatewayLocalUserIngress(params.client);
  if (params.isRestartRecoveryResumeRun) {
    attachAgentCommandRecoveryAdmissionFacts(runContext);
  } else if (localUserIngress) {
    attachAgentCommandAdmissionFacts(runContext, localUserIngress.facts);
  }
  return runContext;
}
