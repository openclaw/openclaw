import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import type { SessionRecoveryContinuationOutcome } from "../session-recovery-service.js";
import {
  resolveSessionMutationAuthorization,
  SessionMutationAuthorizationChangedError,
} from "../session-sharing.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { withSessionMutationCommitGuard } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const RECOVERY_CONTINUATION_TEXT =
  "Continue from the recovered transcript and finish the interrupted work.";

/** Starts the fixed recovery continuation as trusted system input. */
export async function launchSessionRecoveryContinuation(params: {
  agentId: string;
  client: GatewayRequestHandlerOptions["client"];
  commitGuard?: () => void;
  context: GatewayRequestHandlerOptions["context"];
  hasCurrentClientAuthority?: GatewayRequestHandlerOptions["hasCurrentClientAuthority"];
  idempotencyKey: string;
  req: GatewayRequestHandlerOptions["req"];
  sessionScope?: SessionOperatorScope;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<SessionRecoveryContinuationOutcome> {
  let outcome: SessionRecoveryContinuationOutcome | undefined;
  try {
    const destination = resolveSessionMutationAuthorization({
      client: params.client,
      context: params.context,
      method: "chat.send",
      requestParams: { agentId: params.agentId, sessionKey: params.sessionKey },
      expectedTarget: {
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        storePath: params.storePath,
      },
      sessionScope: params.sessionScope,
    });
    if (destination.error) {
      return { status: "rejected", error: destination.error };
    }
    const destinationAuthorization = withSessionMutationCommitGuard(
      destination.authorization,
      params.commitGuard,
      undefined,
    );
    if (!destinationAuthorization) {
      return {
        status: "rejected",
        error: errorShape(ErrorCodes.UNAVAILABLE, "Continuation authorization was not prepared."),
      };
    }
    await handleTrustedInternalChatSend(
      {
        req: params.req,
        params: {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          sessionId: params.sessionId,
          message: formatSystemTurnPrompt(RECOVERY_CONTINUATION_TEXT),
          idempotencyKey: params.idempotencyKey,
          deliver: false,
          suppressCommandInterpretation: true,
          systemInputProvenance: {
            kind: "internal_system",
            sourceSessionKey: params.sessionKey,
            sourceTool: "sessions.recover",
          },
        },
        respond: (ok, payload, error) => {
          const response = payload as { runId?: unknown } | undefined;
          const runId =
            ok && response && typeof response.runId === "string" ? response.runId.trim() : "";
          outcome =
            ok && runId
              ? { status: "started", runId }
              : {
                  status: "rejected",
                  error:
                    error ?? errorShape(ErrorCodes.UNAVAILABLE, "Continuation was not started."),
                };
        },
        context: params.context,
        client: params.client,
        ...(params.hasCurrentClientAuthority
          ? { hasCurrentClientAuthority: params.hasCurrentClientAuthority }
          : {}),
        isWebchatConnect: () => false,
        sessionMutationAuthorization: destinationAuthorization,
      },
      params.commitGuard
        ? async () => {
            params.commitGuard?.();
            return true;
          }
        : undefined,
    );
  } catch (error) {
    outcome = {
      status: "rejected",
      error:
        error instanceof SessionMutationAuthorizationChangedError
          ? error.error
          : errorShape(
              ErrorCodes.INVALID_REQUEST,
              error instanceof Error ? error.message : "Continuation authority check failed.",
            ),
    };
  }
  return (
    outcome ?? {
      status: "rejected",
      error: errorShape(ErrorCodes.UNAVAILABLE, "Continuation returned no outcome."),
    }
  );
}
