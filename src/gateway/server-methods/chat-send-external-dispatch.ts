import { getRpcSourceIdentity } from "../../sessions/session-controller.rpc-sources.js";
import { withRepositoryChatDispatch } from "../repository-dispatch.js";
import type { StartChatDispatchParams } from "./chat-send-agent-dispatch.types.js";
import { isDirectGatewayUserClient } from "./cron-creator-authority-admission.js";

/** External input carries only its current caller's capabilities into execution. */
export function runChatSendExternalDispatch<T>(
  params: StartChatDispatchParams,
  dispatch: () => Promise<T>,
): Promise<T> {
  const { externalAuthorityAdmission, cronCreatorAuthority, assertDashboardReadCurrent } = params;
  const run = () =>
    cronCreatorAuthority && externalAuthorityAdmission
      ? externalAuthorityAdmission.run(
          cronCreatorAuthority,
          dispatch,
          params.admission.activeRunAbort.controller.signal,
        )
      : dispatch();
  // Resume is an explicit authenticated Goal operation, though its transcript input
  // is hidden/internal. It carries operator authority, not cron-creation authority.
  const assertRepositoryCurrent =
    params.admission.codexGoalAdmission &&
    isDirectGatewayUserClient(params.client) &&
    params.request.goalOperation
      ? params.admission.operatorAuthority?.assertCurrent
      : externalAuthorityAdmission && assertDashboardReadCurrent;
  return assertRepositoryCurrent
    ? withRepositoryChatDispatch(
        {
          client: params.client,
          agentId: params.session.agentId,
          sessionKey: params.session.sessionKey,
          getSessionId: () => getRpcSourceIdentity(params.admission.sourceRef).sessionId,
          runId: params.session.clientRunId,
          assertCurrent: assertRepositoryCurrent,
        },
        run,
      )
    : run();
}
