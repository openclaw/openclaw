import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../agents/cron-creator-authority-context.js";
import { issueHumanSenderTurn } from "../../plugins/memory-human-sender-turn.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { hasGatewayAdminScope } from "../operator-scopes.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import { handleChatSend } from "./chat-send-handler.js";
import {
  isDirectGatewayChatUserTurn,
  isDirectGatewayUserClient,
  resolveGatewayChatCronCreatorAuthorityAdmission,
} from "./cron-creator-authority-admission.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const externalAuthorityAdmission: ChatSendExternalAuthorityAdmission = {
  allowsDashboardReads: (params) =>
    params.client?.internal?.authenticatedControlUi === true &&
    authorizeOperatorScopesForMethod("chat.send", params.client.connect.scopes ?? []).allowed &&
    isDirectGatewayChatUserTurn({
      ...params,
      resolvedSessionKey: params.sessionKey,
      isIncognito: params.isIncognitoEntry || isIncognitoSessionKey(params.sessionKey),
      isDirectExternalUser: true,
    }),
  resolve: (params) => {
    const authority = resolveGatewayChatCronCreatorAuthorityAdmission({
      ...params,
      resolvedSessionKey: params.sessionKey,
      isIncognito: params.isIncognitoEntry || isIncognitoSessionKey(params.sessionKey),
      isDirectExternalUser: true,
    });
    return authority
      ? createCronCreatorAuthorityCapability(
          authority.runId,
          authority.callerOrigin,
          authority.managementEntitlement,
          authority.isCurrent,
          undefined,
          authority.requesterOwner,
          authority.callerScopedCreation,
        )
      : undefined;
  },
  // Unlike the grants above, a spawned target session qualifies: the attested
  // sender replaces its spawn receipt instead of extending its lineage.
  issueHumanSenderTurn: (params) =>
    params.client?.internal?.authenticatedOperator === true &&
    isDirectGatewayUserClient(params.client) &&
    params.inputProvenance === undefined &&
    !params.hasExplicitOrigin &&
    !params.hasRestoredCronContinuation &&
    !params.isReconnectResume &&
    !params.isSystemGenerated &&
    params.turnKind === "main"
      ? issueHumanSenderTurn({
          sessionKey: params.sessionKey,
          senderIsOwner: hasGatewayAdminScope(params.client),
        })
      : undefined,
  run: (capability, run, signal) => runWithCronCreatorAuthorityCapability(capability, run, signal),
};

/** Authenticated external chat entry; internal re-entry must call handleChatSend directly. */
export function handleDirectExternalChatSend(
  options: GatewayRequestHandlerOptions,
  onAdmissionOwned?: () => Promise<boolean>,
): Promise<void> {
  return handleChatSend(options, onAdmissionOwned, externalAuthorityAdmission);
}
