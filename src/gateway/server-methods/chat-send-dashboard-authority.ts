import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { bindUserTurnPromptReactionSource } from "../../sessions/user-turn-transcript-admission.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createCurrentPromptReaction } from "../current-prompt-reaction.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { ChatSendExternalAuthorityAdmission } from "./chat-send-external-authority-contract.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** One source authorization survives queue adoption; read grants retain the original work lease. */
export async function createChatSendDashboardAuthority(params: {
  admission: Pick<
    AdmittedChatSend,
    "activeRunAbort" | "sessionBinding" | "lifecycleGeneration" | "assertWorkAdmissionCurrent"
  >;
  session: Pick<PreparedChatSendSession, "agentId" | "storePath">;
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  hasCurrentClientAuthority: GatewayRequestHandlerOptions["hasCurrentClientAuthority"];
  sessionMutationCommitGuard: GatewayRequestHandlerOptions["sessionMutationCommitGuard"];
  sessionMutationAuthorization?: GatewayRequestHandlerOptions["sessionMutationAuthorization"];
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
  const resolved =
    eligible && !params.sessionMutationAuthorization
      ? await resolveSessionMutationAuthorizationAsync({
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
        })
      : undefined;
  if (resolved?.error) {
    throw new SessionMutationAuthorizationChangedError(resolved.error);
  }
  const sessionAuthorization = params.sessionMutationAuthorization ?? resolved?.authorization;
  if (eligible && !sessionAuthorization) {
    throw new Error("Dashboard session authorization is unavailable.");
  }
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
          (
            sessionAuthorization?.assertAdmittedInputCurrent ?? sessionAuthorization?.assertCurrent
          )?.();
        }
      : undefined;
  return {
    release: () => resolved?.authorization?.release?.(),
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
