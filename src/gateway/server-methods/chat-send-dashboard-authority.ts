import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { bindUserTurnPromptReactionSource } from "../../sessions/user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createCurrentPromptReaction } from "../current-prompt-reaction.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions, SessionMutationAuthorization } from "./types.js";

/** One source authorization survives queue adoption; read grants retain the original work lease. */
export function createChatSendDashboardAuthority(params: {
  admission: Pick<
    AdmittedChatSend,
    "activeRunAbort" | "sessionBinding" | "lifecycleGeneration" | "assertWorkAdmissionCurrent"
  >;
  session: Pick<PreparedChatSendSession, "agentId" | "storePath">;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  hasCurrentClientAuthority: GatewayRequestHandlerOptions["hasCurrentClientAuthority"];
  sessionMutationCommitGuard: GatewayRequestHandlerOptions["sessionMutationCommitGuard"];
  externalAuthorityAdmission: ChatSendExternalAuthorityAdmission | undefined;
  externalAdmissionParams: Parameters<
    ChatSendExternalAuthorityAdmission["allowsDashboardReads"]
  >[0];
}) {
  const {
    admission,
    session,
    client,
    context,
    externalAuthorityAdmission,
    externalAdmissionParams,
  } = params;
  const { runId, sessionKey } = externalAdmissionParams;
  const eligible = externalAuthorityAdmission?.allowsDashboardReads(externalAdmissionParams);
  let sessionAuthorization: SessionMutationAuthorization | undefined;
  const assertSourceCurrent =
    eligible && externalAuthorityAdmission
      ? () => {
          params.sessionMutationCommitGuard?.();
          if (admission.lifecycleGeneration !== getAgentEventLifecycleGeneration()) {
            throw new Error("Dashboard prompt source lifecycle is no longer active.");
          }
          const queued = context.chatQueuedTurns.get(runId);
          if (
            admission.activeRunAbort.controller.signal.aborted &&
            !(
              queued?.controller === admission.activeRunAbort.controller &&
              queued.abortable === false
            )
          ) {
            admission.activeRunAbort.controller.signal.throwIfAborted();
          }
          // Transport loss is not revocation; the original caller and target still govern use.
          if (
            client?.invalidated ||
            params.hasCurrentClientAuthority?.() === false ||
            !externalAuthorityAdmission.allowsDashboardReads(externalAdmissionParams)
          ) {
            throw new Error("Dashboard message read admission is no longer active.");
          }
          if (!sessionAuthorization) {
            // Fresh-session preparation may create its SID. Capture it once, never a successor.
            const resolved = resolveSessionMutationAuthorization({
              client,
              context,
              method: "chat.send",
              requestParams: { agentId: session.agentId, sessionKey },
              expectedTarget: {
                agentId: session.agentId,
                sessionKey,
                storePath: session.storePath,
                sessionId: admission.sessionBinding.sessionId,
              },
            });
            if (resolved.error) {
              throw new SessionMutationAuthorizationChangedError(resolved.error);
            }
            if (!resolved.authorization) {
              throw new Error("Dashboard session authorization is unavailable.");
            }
            sessionAuthorization = resolved.authorization;
          }
          sessionAuthorization.assertCurrent();
        }
      : undefined;
  return {
    assertReadCurrent: assertSourceCurrent
      ? () => {
          admission.assertWorkAdmissionCurrent();
          assertSourceCurrent();
        }
      : undefined,
    bindPromptRecorder(recorder: UserTurnTranscriptRecorder) {
      if (!assertSourceCurrent) {
        return;
      }
      bindUserTurnPromptReactionSource(recorder, {
        agentId: session.agentId,
        sessionKey,
        assertCurrent: assertSourceCurrent,
        createReaction: (sourceRecorder) =>
          createCurrentPromptReaction({
            agentId: session.agentId,
            sessionKey,
            recorder: sourceRecorder,
            context,
          }),
      });
    },
  };
}
