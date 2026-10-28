import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { SessionGoalOperation } from "../../config/sessions/goals-operations.js";
import type { SessionRestartResume } from "../../config/sessions/restart-resume.js";
import type { ProviderReviewAcknowledgment } from "../../sessions/provider-review.js";
import type { SessionControllerInput } from "../../sessions/session-controller.contracts.js";
import { respondChatSendAdmissionError } from "./chat-send-admission-errors.js";
import { admitChatSend } from "./chat-send-admission.js";
import type { ChatSendDiagnostics } from "./chat-send-diagnostics.js";
import { runChatSendPreAdmission } from "./chat-send-pre-admission.js";
import { normalizeChatSendRequest } from "./chat-send-request.js";
import {
  prepareChatSendNativeRuntimeRestriction,
  prepareChatSendSession,
  qualifyChatSendSession,
  type PreparedChatSendSession,
} from "./chat-send-session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

/** Normalize, prepare, and exclusively admit one new chat.send request. */
export async function prepareAndAdmitChatSend(
  {
    params,
    respond,
    context,
    client,
    hasCurrentClientAuthority,
    sessionMutationAuthorization,
  }: Pick<
    GatewayRequestHandlerOptions,
    | "params"
    | "respond"
    | "context"
    | "client"
    | "hasCurrentClientAuthority"
    | "sessionMutationAuthorization"
  >,
  onAdmissionOwned?: () => Promise<boolean>,
  options?: {
    trustedSystemInput?: boolean;
    controllerInput?: SessionControllerInput;
    isDirectExternalUser?: boolean;
    goalResume?: SessionGoalOperation & { action: "resume" };
    restartResume?: SessionRestartResume;
    providerReviewAcknowledgment?: ProviderReviewAcknowledgment;
  },
  diagnostics?: ChatSendDiagnostics,
  releaseSessionStorage?: () => void,
) {
  const phase = diagnostics?.scope("admission");
  const assertCurrent =
    sessionMutationAuthorization || hasCurrentClientAuthority
      ? () => {
          sessionMutationAuthorization?.assertCurrent();
          if (hasCurrentClientAuthority?.() === false) {
            throw new Error("Gateway caller authority is no longer active.");
          }
        }
      : undefined;
  const withCurrent = sessionMutationAuthorization?.withCurrent;
  const assertCurrentAsync = async () =>
    withCurrent ? withCurrent(() => assertCurrent?.()) : assertCurrent?.();
  const normalization = normalizeChatSendRequest({
    params,
    client,
    ...(options?.trustedSystemInput ? { trustedSystemInput: true } : {}),
    ...(options?.goalResume ? { goalResume: options.goalResume } : {}),
    ...(options?.restartResume ? { restartResume: options.restartResume } : {}),
    ...(options?.providerReviewAcknowledgment
      ? { providerReviewAcknowledgment: options.providerReviewAcknowledgment }
      : {}),
  });
  const normalizedRequest = normalization instanceof Promise ? await normalization : normalization;
  if (!normalizedRequest.ok) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        normalizedRequest.error,
        normalizedRequest.reason ? { details: { reason: normalizedRequest.reason } } : undefined,
      ),
    );
    return undefined;
  }
  if (normalization instanceof Promise || normalizedRequest.value.goalOperation) {
    try {
      assertCurrent?.();
    } catch (error) {
      respondChatSendAdmissionError(error, respond);
      return undefined;
    }
  }
  const loadedSession = await prepareChatSendSession({
    request: normalizedRequest.value,
    context,
    client,
    isDirectExternalUser: options?.isDirectExternalUser,
    assertCurrent,
  });
  if (!loadedSession.ok) {
    respond(
      false,
      undefined,
      typeof loadedSession.error === "string"
        ? errorShape(ErrorCodes.INVALID_REQUEST, loadedSession.error)
        : loadedSession.error,
    );
    return undefined;
  }
  const recoveryEntry = loadedSession.value.entry;
  let recoveryOutcome: "rejected" | "admitted" | "retried" = "rejected";
  using recoveryLog =
    recoveryEntry?.mainRestartRecovery && !normalizedRequest.value.stopCommand
      ? {
          [Symbol.dispose]() {
            try {
              context.logGateway.info("chat.send recovery admission", {
                outcome: recoveryOutcome,
                sessionIdHash: sha256HexPrefixCore(recoveryEntry.sessionId, 16),
                runId: loadedSession.value.clientRunId,
                sourceRunId: recoveryEntry.restartRecoveryDeliverySourceRunId,
                recoveryRunId: recoveryEntry.restartRecoveryDeliveryRunId,
                // Capture the incoming custody, including rejected requests that never write.
                chargedAttempts: recoveryEntry.mainRestartRecovery?.chargedAttempts,
              });
            } catch {
              // Observability must not change admission or retry outcomes.
            }
          },
        }
      : undefined;
  if (normalizedRequest.value.mentions) {
    const mentions = await context.mentionInbox?.validateRecipientsAsync(
      client,
      loadedSession.value.entry
        ? { sessionKey: loadedSession.value.sessionKey, agentId: loadedSession.value.agentId }
        : { agentId: loadedSession.value.agentId },
      normalizedRequest.value.mentions.map((mention) => mention.profileId),
    );
    if (!mentions?.ok) {
      respond(
        false,
        undefined,
        mentions?.error ??
          errorShape(
            ErrorCodes.UNAVAILABLE,
            "Human mentions are unavailable; reconnect and retry.",
          ),
      );
      return undefined;
    }
  }
  phase?.mark("authority");
  const preparation = {
    request: normalizedRequest.value,
    session: loadedSession.value,
    respond: recoveryLog
      ? (((...response) => {
          recoveryOutcome = response[0] ? "retried" : "rejected";
          respond(...response);
        }) satisfies typeof respond)
      : respond,
    context,
    client,
    assertCurrent,
    assertCurrentAsync,
    withCurrent,
  };
  const shouldAdmit = await runChatSendPreAdmission(preparation);
  if (!shouldAdmit) {
    return undefined;
  }
  let session: PreparedChatSendSession;
  try {
    session = await qualifyChatSendSession(loadedSession.value, releaseSessionStorage);
  } catch (error) {
    respondChatSendAdmissionError(error, respond);
    return undefined;
  }
  const nativeRestriction = await prepareChatSendNativeRuntimeRestriction({
    ...preparation,
    session,
  });
  if (nativeRestriction) {
    respond(false, undefined, nativeRestriction);
    return undefined;
  }
  phase?.mark("runAdmission");
  const admitted = await admitChatSend({
    ...preparation,
    session,
    onAdmissionOwned,
    controllerInput: options?.controllerInput,
    hasCurrentClientAuthority,
    withPreparedCurrent: sessionMutationAuthorization?.withPreparedCurrent,
    followRegistration: sessionMutationAuthorization?.followRegistration,
    diagnostics,
  });
  if (!admitted.ok) {
    return undefined;
  }
  recoveryOutcome = "admitted";
  phase?.finish();
  return {
    request: normalizedRequest.value,
    session,
    admission: admitted.value,
  };
}
