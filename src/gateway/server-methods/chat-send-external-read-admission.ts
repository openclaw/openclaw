import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions, SessionMutationAuthorization } from "./types.js";

/** Bind external/dashboard reads once to the already admitted original session. */
export function prepareChatSendExternalReadAdmission(
  params: Pick<
    GatewayRequestHandlerOptions,
    "client" | "context" | "hasCurrentClientAuthority" | "sessionMutationCommitGuard"
  > & {
    request: NormalizedChatSendRequest;
    session: PreparedChatSendSession;
    admission: AdmittedChatSend;
    externalAuthorityAdmission?: ChatSendExternalAuthorityAdmission;
  },
) {
  const {
    client,
    context,
    hasCurrentClientAuthority,
    sessionMutationCommitGuard,
    request,
    session,
    admission,
    externalAuthorityAdmission,
  } = params;
  const { clientRunId, sessionKey, entry, storePath } = session;
  const { systemInputProvenance, reconnectResumeRequested } = request;
  const externalAdmissionParams = {
    runId: clientRunId,
    sessionKey,
    spawnedBy: entry?.spawnedBy,
    client,
    isCurrent: hasCurrentClientAuthority,
    inputProvenance: systemInputProvenance,
    hasExplicitOrigin: request.explicitOrigin !== undefined,
    hasRestoredCronContinuation: entry?.cronRunContinuation !== undefined,
    isIncognitoEntry: entry?.incognito === true,
    isReconnectResume: reconnectResumeRequested,
    isSystemGenerated:
      request.suppressCommandInterpretation || request.systemProvenanceReceipt !== undefined,
    turnKind: request.turnKind,
  };
  const cronCreatorAuthority = externalAuthorityAdmission?.resolve(externalAdmissionParams);
  let dashboardSessionAuthorization: SessionMutationAuthorization | undefined;
  const assertDashboardReadCurrent = externalAuthorityAdmission?.allowsDashboardReads(
    externalAdmissionParams,
  )
    ? () => {
        admission.assertWorkAdmissionCurrent();
        sessionMutationCommitGuard?.();
        // Admitted runs survive transport loss; their caller authority must stay current.
        if (
          client?.invalidated ||
          hasCurrentClientAuthority?.() === false ||
          !externalAuthorityAdmission.allowsDashboardReads(externalAdmissionParams)
        ) {
          throw new Error("Dashboard message read admission is no longer active.");
        }
        if (!dashboardSessionAuthorization) {
          // The original preparation may create its SID. Capture it once, never a successor.
          const resolved = resolveSessionMutationAuthorization({
            client,
            context,
            method: "chat.send",
            requestParams: { agentId: session.agentId, sessionKey },
            expectedTarget: {
              agentId: session.agentId,
              sessionKey,
              storePath,
              sessionId: admission.sessionBinding.sessionId,
            },
          });
          if (resolved.error) {
            throw new SessionMutationAuthorizationChangedError(resolved.error);
          }
          if (!resolved.authorization) {
            throw new Error("Dashboard session authorization is unavailable.");
          }
          dashboardSessionAuthorization = resolved.authorization;
        }
        dashboardSessionAuthorization.assertCurrent();
      }
    : undefined;

  return { cronCreatorAuthority, assertDashboardReadCurrent };
}
