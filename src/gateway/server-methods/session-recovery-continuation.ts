import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { RESTART_RECOVERY_INTERRUPTION_NOTE } from "../../agents/restart-recovery-prompt.js";
import type { SessionRestartResume } from "../../config/sessions/restart-resume.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import type { SessionOperatorScope } from "../../shared/session-method-scopes-base.js";
import type { DeliveryContext } from "../../utils/delivery-context.types.js";
import type { SessionRecoveryContinuationOutcome } from "../session-recovery-service.js";
import { resolveSessionMutationAuthorizationAsync } from "../session-sharing-authorization-async.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import type { ChatSendInternalOptions } from "./chat-send-options.js";
import { withSessionMutationCommitGuard } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const RECOVERY_CONTINUATION_TEXT =
  "Continue from the recovered transcript and finish the interrupted work.";

/** Starts a recovery input through the ordinary reply owner, never a second scheduler. */
export async function launchSessionRecoveryContinuation(params: {
  agentId: string;
  client: GatewayRequestHandlerOptions["client"];
  commitGuard?: () => void;
  assertAdmittedSourceCurrent?: () => void;
  context: GatewayRequestHandlerOptions["context"];
  hasCurrentClientAuthority?: GatewayRequestHandlerOptions["hasCurrentClientAuthority"];
  idempotencyKey: string;
  req: GatewayRequestHandlerOptions["req"];
  sessionScope?: SessionOperatorScope;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  resume?: SessionRestartResume;
  /** Host-prepared automatic recovery keeps its original input, route, and reserved custody. */
  preparedInput?: {
    message: string;
    provenance?: InputProvenance;
    deliver: boolean;
    deliveryContext?: DeliveryContext;
    options?: Pick<
      ChatSendInternalOptions,
      | "controllerInput"
      | "continuationPolicy"
      | "beforeDispatch"
      | "onExecutionStarted"
      | "onSourceAdmitted"
      | "onInputCommitted"
    >;
  };
}): Promise<SessionRecoveryContinuationOutcome> {
  let outcome: SessionRecoveryContinuationOutcome | undefined;
  try {
    params.commitGuard?.();
    const destination = await resolveSessionMutationAuthorizationAsync({
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
      params.resume ? params.assertAdmittedSourceCurrent : undefined,
    );
    if (!destinationAuthorization) {
      return {
        status: "rejected",
        error: errorShape(ErrorCodes.UNAVAILABLE, "Continuation authorization was not prepared."),
      };
    }
    const route = params.preparedInput?.deliveryContext;
    await handleTrustedInternalChatSend(
      {
        req: params.req,
        params: {
          sessionKey: params.sessionKey,
          agentId: params.agentId,
          sessionId: params.sessionId,
          message:
            params.preparedInput?.message ??
            formatSystemTurnPrompt(
              params.resume
                ? RESTART_RECOVERY_INTERRUPTION_NOTE +
                    "\n\n" +
                    RECOVERY_CONTINUATION_TEXT +
                    (params.resume.forceRestartSafeTools
                      ? " This turn uses restart-safe tools; inspect the recorded outcome before attempting more work."
                      : "")
                : RECOVERY_CONTINUATION_TEXT,
            ),
          idempotencyKey: params.idempotencyKey,
          deliver: params.preparedInput?.deliver ?? false,
          ...(route
            ? {
                originatingChannel: route.channel,
                originatingTo: route.to,
                originatingAccountId: route.accountId,
                originatingThreadId: route.threadId?.toString(),
              }
            : {}),
          suppressCommandInterpretation: true,
          systemInputProvenance: params.preparedInput?.provenance ?? {
            kind: "internal_system",
            sourceSessionKey: params.sessionKey,
            sourceTool: "sessions.recover",
          },
        },
        respond: (ok, payload, error) => {
          const runId =
            ok && isRecord(payload) && typeof payload.runId === "string"
              ? payload.runId.trim()
              : "";
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
      {
        ...(params.resume ? { stageCreatedInput: true, restartResume: params.resume } : {}),
        ...params.preparedInput?.options,
      },
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
